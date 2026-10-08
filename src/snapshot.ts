import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expandEnv, lockSource } from "./config.js";
import { promptEntry, serverIntegrity, toolEntry } from "./lockfile.js";
import type { PromptEntry, ServerEntry, ServerSpec, ToolEntry } from "./types.js";

export interface SnapshotOptions {
  timeoutMs: number;
  verbose: boolean;
  version: string;
}

export type SnapshotResult =
  | { name: string; ok: true; entry: ServerEntry }
  | { name: string; ok: false; error: string };

export async function snapshotAll(specs: ServerSpec[], options: SnapshotOptions): Promise<SnapshotResult[]> {
  const results: SnapshotResult[] = new Array(specs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < specs.length) {
      const index = next++;
      const spec = specs[index]!;
      try {
        results[index] = { name: spec.name, ok: true, entry: await snapshotServer(spec, options) };
      } catch (err) {
        results[index] = { name: spec.name, ok: false, error: describeError(err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, specs.length) }, worker));
  return results;
}

export async function snapshotServer(spec: ServerSpec, options: SnapshotOptions): Promise<ServerEntry> {
  const stderrTail: string[] = [];
  const transport = createTransport(spec, options, stderrTail);
  const client = new Client({ name: "mcpkeel", version: options.version }, { capabilities: {} });
  const request = { timeout: options.timeoutMs };

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s`)),
      options.timeoutMs + 2000,
    );
  });

  const work = (async (): Promise<ServerEntry> => {
    await client.connect(transport, request);
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

function createTransport(spec: ServerSpec, options: SnapshotOptions, stderrTail: string[]): McpTransport {
  if (spec.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
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
  const init = { requestInit: { headers } };
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
