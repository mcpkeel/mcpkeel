import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expandEnv, lockSource } from "./config.js";
import { promptEntry, serverIntegrity, toolEntry } from "./lockfile.js";
import { assertSafeHost, noRedirectFetch, packageRef, resolvePackage, type ResolveOptions } from "./resolve.js";
import type { PackagePin, PromptEntry, ServerEntry, ServerSpec, ToolEntry } from "./types.js";

export interface SnapshotOptions {
  timeoutMs: number;
  verbose: boolean;
  version: string;
  /** Also check that the server gives the same answer later in the session, and to another client. */
  probe?: boolean;
  /** Look up the release each package launcher runs. `false` skips it on purpose. */
  resolve?: ResolveOptions | false;
}

/** A second reading of a server that did not match the first. */
export interface ProbeFinding {
  kind: "session" | "identity";
  /** How the second reading was taken, phrased to follow "changed ...". */
  how: string;
  entry: ServerEntry;
}

export type SnapshotResult =
  | {
      name: string;
      ok: true;
      entry: ServerEntry;
      probes?: ProbeFinding[];
      probeNote?: string;
      /** The package could not be looked up, so what runs was not checked. */
      resolveError?: string;
      /** The package was found, but the config asks for something that cannot be pinned, such as a range. */
      packageNote?: string;
    }
  | { name: string; ok: false; error: string };

/**
 * Credentials that are mcpkeel's own. A server being inspected is not handed
 * them, unless the config passes one on by name in that server's `env`.
 */
const OWN_SECRETS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

/** The name mcpkeel introduces itself with. */
const CLIENT_NAME = "mcpkeel";
/** A second name, to see whether a server answers a checker differently from an agent. */
export const PROBE_CLIENT_NAME = "claude-code";
/** Requests sent between the two readings of a session probe. */
export const PROBE_REQUESTS = 5;

export async function snapshotAll(specs: ServerSpec[], options: SnapshotOptions): Promise<SnapshotResult[]> {
  const results: SnapshotResult[] = new Array(specs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < specs.length) {
      const index = next++;
      const spec = specs[index]!;
      try {
        // The package is looked up before the server is started: the pin says
        // what was meant to run, independently of what the launcher fetched.
        const resolved = await resolveSpec(spec, options);
        const read = await snapshotServer(spec, options);
        if (resolved.pin) read.entry = { ...read.entry, package: resolved.pin };
        results[index] = { name: spec.name, ok: true, ...read, resolveError: resolved.error, packageNote: resolved.note };
      } catch (err) {
        results[index] = { name: spec.name, ok: false, error: describeError(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, specs.length) }, worker));
  return results;
}

async function resolveSpec(spec: ServerSpec, options: SnapshotOptions): Promise<{ pin?: PackagePin; error?: string; note?: string }> {
  if (!options.resolve) return {};
  const ref = packageRef(spec);
  if (!ref) return {};
  try {
    const resolution = await resolvePackage(ref, options.resolve);
    if (resolution.kind === "pinned") return { pin: resolution.pin };
    if (resolution.kind === "unpinnable") return { note: resolution.reason };
    return {};
  } catch (err) {
    return { error: `could not look up ${ref.ecosystem} package ${ref.name}: ${(err as Error).message}` };
  }
}

export async function snapshotServer(
  spec: ServerSpec,
  options: SnapshotOptions,
): Promise<{ entry: ServerEntry; probes?: ProbeFinding[]; probeNote?: string }> {
  const probes: ProbeFinding[] = [];

  const entry = await withSession(spec, options, CLIENT_NAME, async (client) => {
    const first = await readEntry(client, spec, options);
    if (options.probe) {
      // A server can behave until it has seen a few requests and only then
      // rewrite what it serves. Reading once, at connect, never sees that.
      await poke(client, options);
      const second = await readEntry(client, spec, options);
      if (second.integrity !== first.integrity) {
        probes.push({ kind: "session", how: `after ${PROBE_REQUESTS} more requests in the same session`, entry: second });
      }
    }
    return first;
  });
  if (!options.probe) return { entry };

  // A server that wants to pass a check can serve clean definitions to anything
  // called "mcpkeel". Asking again under an agent's name closes that door.
  let probeNote: string | undefined;
  try {
    const other = await withSession(spec, options, PROBE_CLIENT_NAME, (client) => readEntry(client, spec, options));
    if (other.integrity !== entry.integrity) {
      probes.push({ kind: "identity", how: `when the client is named "${PROBE_CLIENT_NAME}"`, entry: other });
    }
  } catch (err) {
    probeNote = `could not be read a second time as "${PROBE_CLIENT_NAME}": ${describeError(err).split("\n")[0]}`;
  }
  return { entry, probes, probeNote };
}

/** Connect, run `fn`, and always clean up, within one overall deadline. */
async function withSession<T>(
  spec: ServerSpec,
  options: SnapshotOptions,
  clientName: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const stderrTail: string[] = [];
  const transport = createTransport(spec, options, stderrTail);
  const client = new Client({ name: clientName, version: options.version }, { capabilities: {} });
  const budget = options.timeoutMs * (options.probe ? 2 : 1) + 2000;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s`)), budget);
  });

  const work = (async (): Promise<T> => {
    if (spec.transport !== "stdio") await assertSafeHost(new URL(expandEnv(spec.url ?? "")));
    await client.connect(transport, { timeout: options.timeoutMs });
    return fn(client);
  })();

  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    const tail = stderrTail.join("").trim().split("\n").slice(-3).join("\n").trim();
    const message = describeError(err);
    throw new Error(tail && !options.verbose ? `${message}\n${tail}` : message);
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

/** Everything mcpkeel pins about a server, read over an open session. */
async function readEntry(client: Client, spec: ServerSpec, options: SnapshotOptions): Promise<ServerEntry> {
  const request = { timeout: options.timeoutMs };
  const capabilities = client.getServerCapabilities() ?? {};

  const tools: Record<string, ToolEntry> = {};
  if (capabilities.tools) {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, request);
      for (const tool of page.tools) {
        tools[tool.name] = toolEntry({
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations as Record<string, unknown> | undefined,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  let prompts: Record<string, PromptEntry> | undefined;
  if (capabilities.prompts) {
    prompts = {};
    let cursor: string | undefined;
    do {
      const page = await client.listPrompts(cursor ? { cursor } : undefined, request);
      for (const prompt of page.prompts) {
        prompts[prompt.name] = promptEntry({
          title: prompt.title,
          description: prompt.description,
          arguments: prompt.arguments,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  const info = client.getServerVersion();
  const partial: Omit<ServerEntry, "integrity"> = {
    transport: spec.transport,
    source: lockSource(spec),
    serverInfo: info ? { name: info.name, version: info.version } : undefined,
    instructions: client.getInstructions() || undefined,
    tools,
    prompts,
  };
  return { ...partial, integrity: serverIntegrity(partial) };
}

/**
 * Give a request counter something to count, without doing anything. Each call
 * names a tool that does not exist, so a well-behaved server answers with an
 * error and nothing happens. Failures are expected and ignored.
 */
async function poke(client: Client, options: SnapshotOptions): Promise<void> {
  const request = { timeout: Math.min(options.timeoutMs, 5000) };
  if (client.getServerCapabilities()?.tools) {
    for (let i = 0; i < PROBE_REQUESTS; i++) {
      try {
        await client.callTool({ name: `mcpkeel_probe_does_not_exist_${i}`, arguments: {} }, undefined, request);
      } catch {
        // An error is the expected answer.
      }
    }
  }
  try {
    await client.ping(request);
  } catch {
    // Not every server answers pings.
  }
}

function createTransport(spec: ServerSpec, options: SnapshotOptions, stderrTail: string[]): McpTransport {
  if (spec.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !OWN_SECRETS.has(key)) env[key] = value;
    }
    for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = expandEnv(value);
    const transport = new StdioClientTransport({
      command: expandEnv(spec.command ?? ""),
      args: (spec.args ?? []).map((arg) => expandEnv(arg)),
      env,
      stderr: options.verbose ? "inherit" : "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrTail.push(chunk.toString("utf8"));
      if (stderrTail.length > 50) stderrTail.shift();
    });
    return transport;
  }

  const url = new URL(expandEnv(spec.url ?? ""));
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.headers ?? {})) headers[key] = expandEnv(value);
  const init = { requestInit: { headers }, fetch: noRedirectFetch };
  return spec.transport === "sse" ? new SSEClientTransport(url, init) : new StreamableHTTPClientTransport(url, init);
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b401\b|unauthorized/i.test(message)) {
    return `${message}\nThis server needs authentication. Pass a token via "headers" in the config; interactive OAuth sign-in is not supported yet.`;
  }
  if (/ENOENT/.test(message)) return `${message}\nThe server command was not found on PATH.`;
  return message;
}
