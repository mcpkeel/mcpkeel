#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { UserError, findConfig, loadConfig } from "./config.js";
import { atLeast, diffLockfiles, scanServer } from "./diff.js";
import { DEFAULT_MODEL, explainChanges, reviewable, type Review } from "./explain.js";
import { LOCKFILE_NAME, readLockfile, writeLockfile } from "./lockfile.js";
import { palette, plural, renderChange, summarize, summaryLine, type Palette } from "./report.js";
import { snapshotAll, type SnapshotResult } from "./snapshot.js";
import { SEVERITIES, type Change, type Lockfile, type ServerEntry, type ServerSpec, type Severity } from "./types.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `mcpkeel ${VERSION}: the lockfile for MCP

Pin what your MCP servers tell your agent, and find out when it changes.

Usage
  mcpkeel init                 Snapshot every server in your MCP config into mcp.lock
  mcpkeel verify               Compare live servers against mcp.lock; exit 1 on drift
  mcpkeel diff                 Show what changed, with severity (always exits 0)
  mcpkeel diff <old> <new>     Compare two lockfiles without contacting any server
  mcpkeel update [server...]   Accept the current definitions and rewrite mcp.lock

Options
  -c, --config <path>     MCP config to read (default: .mcp.json, mcp.json,
                          .cursor/mcp.json, .vscode/mcp.json)
  -l, --lockfile <path>   Lockfile to read and write (default: mcp.lock)
      --fail-on <level>   verify: lowest severity that fails the run:
                          critical, high, medium or low (default: low)
      --explain           diff: ask Claude to assess the changed text for prompt
                          injection. Needs ANTHROPIC_API_KEY. Sends only the
                          changed definitions to the Claude API.
      --model <id>        Model for --explain (default: ${DEFAULT_MODEL})
      --force             init: overwrite an existing lockfile
      --timeout <secs>    Per-server timeout (default: 30)
      --json              Machine-readable output
      --verbose           Show server stderr while connecting
      --no-color          Disable colored output
  -h, --help              Show this help
  -v, --version           Show the version

Exit codes
  0  no drift            1  drift found (verify)            2  could not complete

Docs: https://mcpkeel.app
`;

interface Options {
  config?: string;
  lockfile: string;
  failOn: Severity;
  explain: boolean;
  model: string;
  force: boolean;
  timeoutMs: number;
  json: boolean;
  verbose: boolean;
  cwd: string;
  p: Palette;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        lockfile: { type: "string", short: "l" },
        "fail-on": { type: "string" },
        explain: { type: "boolean" },
        model: { type: "string" },
        force: { type: "boolean" },
        timeout: { type: "string" },
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    throw new UserError(`${(err as Error).message}\nRun \`mcpkeel --help\` for usage.`);
  }
  const { values, positionals } = parsed;
  if (values.version) return print(VERSION);
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") return print(HELP);

  const failOn = (values["fail-on"] ?? "low") as Severity;
  if (!SEVERITIES.includes(failOn)) throw new UserError(`--fail-on must be one of: ${SEVERITIES.join(", ")}.`);
  const timeoutSecs = Number(values.timeout ?? "30");
  if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0) throw new UserError("--timeout must be a positive number of seconds.");

  const cwd = process.cwd();
  const color = !values["no-color"] && !values.json && !process.env.NO_COLOR && (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR));
  const options: Options = {
    config: values.config,
    lockfile: resolve(cwd, values.lockfile ?? LOCKFILE_NAME),
    failOn,
    explain: Boolean(values.explain),
    model: values.model ?? process.env.MCPKEEL_MODEL ?? DEFAULT_MODEL,
    force: Boolean(values.force),
    timeoutMs: timeoutSecs * 1000,
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    cwd,
    p: palette(color),
  };

  switch (command) {
    case "init":
      return init(options);
    case "verify":
      return compare(options, "verify");
    case "diff":
      if (rest.length === 2) return diffFiles(options, rest[0]!, rest[1]!);
      if (rest.length !== 0) throw new UserError("`mcpkeel diff` takes either no arguments or two lockfile paths.");
      return compare(options, "diff");
    case "update":
      return update(options, rest);
    default:
      throw new UserError(`Unknown command "${command}".\nRun \`mcpkeel --help\` for usage.`);
  }
}

/* ------------------------------------------------------------------ init */

async function init(options: Options): Promise<number> {
  if (existsSync(options.lockfile) && !options.force) {
    throw new UserError(
      `${rel(options, options.lockfile)} already exists.\n` +
        "Use `mcpkeel update` to accept changes, or `mcpkeel init --force` to start over.",
    );
  }
  const { specs, results, configPath } = await snapshot(options);
  const failed = results.filter((r) => !r.ok);
  const lock = toLockfile(results);
  const notes = collectNotes(specs, lock);

  if (failed.length === 0) writeLockfile(options.lockfile, lock);

  if (options.json) {
    return print(
      JSON.stringify(
        { ok: failed.length === 0, config: configPath, lockfile: options.lockfile, servers: serverSummaries(results, []), errors: errorList(results), notes },
        null,
        2,
      ),
      failed.length ? 2 : 0,
    );
  }

  const { p } = options;
  const out: string[] = [p.dim(`config  ${rel(options, configPath)}`), ""];
  for (const result of results) out.push(serverLine(result, p));
  if (notes.length) {
    out.push("", p.bold("Worth a look before you trust this lockfile"));
    for (const note of notes) out.push(`  ${p.magenta("!")} ${p.bold(note.server)} ${note.subject}: ${note.message}`);
  }
  out.push("");
  if (failed.length) {
    out.push(p.red(`Nothing written: ${plural(failed.length, "server")} could not be reached.`), "Fix the errors above and run `mcpkeel init` again.");
    return print(out.join("\n"), 2);
  }
  const toolCount = Object.values(lock.servers).reduce((sum, server) => sum + Object.keys(server.tools).length, 0);
  out.push(
    `${p.green("Wrote")} ${p.bold(rel(options, options.lockfile))}: ${plural(results.length, "server")}, ${plural(toolCount, "tool")} pinned.`,
    "Commit it, then run `mcpkeel verify` in CI.",
  );
  return print(out.join("\n"));
}

/* ------------------------------------------------------- verify and diff */

async function compare(options: Options, mode: "verify" | "diff"): Promise<number> {
  const locked = readLockfile(options.lockfile);
  const { results, configPath } = await snapshot(options);
  const failed = results.filter((r) => !r.ok);
  const changes = diffLockfiles(locked, toLockfile(results), new Set(failed.map((r) => r.name)));
  const reviews = mode === "diff" && options.explain ? await review(changes, options) : undefined;

  const failing = changes.filter((change) => atLeast(change.severity, options.failOn));
  // A server that cannot be reached cannot be verified, so verify fails closed.
  const code = failed.length ? 2 : mode === "verify" && failing.length ? 1 : 0;

  if (options.json) {
    return print(
      JSON.stringify(
        {
          ok: code === 0,
          drift: changes.length > 0,
          config: configPath,
          lockfile: options.lockfile,
          summary: summarize(changes),
          servers: serverSummaries(results, changes),
          changes: withReviews(changes, reviews),
          errors: errorList(results),
        },
        null,
        2,
      ),
      code,
    );
  }

  const { p } = options;
  const out: string[] = [p.dim(`config  ${rel(options, configPath)}`), p.dim(`lock    ${rel(options, options.lockfile)}`), ""];
  out.push(...renderGroups(results, changes, reviews, p));
  out.push("", ...footer(changes, failed.length, mode, options, failing.length));
  return print(out.join("\n"), code);
}

async function diffFiles(options: Options, oldPath: string, newPath: string): Promise<number> {
  const before = readLockfile(resolve(options.cwd, oldPath));
  const after = readLockfile(resolve(options.cwd, newPath));
  const changes = diffLockfiles(before, after);
  const reviews = options.explain ? await review(changes, options) : undefined;

  if (options.json) {
    return print(JSON.stringify({ drift: changes.length > 0, summary: summarize(changes), changes: withReviews(changes, reviews) }, null, 2));
  }
  const { p } = options;
  const out: string[] = [p.dim(`old  ${oldPath}`), p.dim(`new  ${newPath}`), ""];
  if (changes.length === 0) out.push(`${p.green("✓")} The two lockfiles pin the same definitions.`);
  else {
    out.push(...renderChangesByServer(changes, reviews, p));
    out.push("", `${plural(changes.length, "change")}: ${summaryLine(changes)}.`);
  }
  return print(out.join("\n"));
}

/* ---------------------------------------------------------------- update */

async function update(options: Options, only: string[]): Promise<number> {
  const previous = existsSync(options.lockfile) ? readLockfile(options.lockfile) : undefined;
  const { specs, results, configPath } = await snapshot(options);
  const known = new Set([...specs.map((s) => s.name), ...Object.keys(previous?.servers ?? {})]);
  for (const name of only) {
    if (!known.has(name)) throw new UserError(`No server named "${name}" in the config or the lockfile.`);
  }
  const selected = only.length ? results.filter((r) => only.includes(r.name)) : results;
  const failed = selected.filter((r) => !r.ok);

  let next: Lockfile;
  if (only.length && previous) {
    next = { lockfileVersion: 1, servers: { ...previous.servers } };
    for (const name of only) delete next.servers[name];
    for (const result of selected) if (result.ok) next.servers[result.name] = result.entry;
  } else {
    next = toLockfile(selected);
  }

  const changes = previous ? diffLockfiles(previous, next, new Set(failed.map((r) => r.name))) : [];
  if (failed.length === 0) writeLockfile(options.lockfile, next);

  if (options.json) {
    return print(
      JSON.stringify(
        { ok: failed.length === 0, config: configPath, lockfile: options.lockfile, accepted: changes, errors: errorList(selected) },
        null,
        2,
      ),
      failed.length ? 2 : 0,
    );
  }

  const { p } = options;
  const out: string[] = [p.dim(`config  ${rel(options, configPath)}`), ""];
  for (const result of failed) out.push(serverLine(result, p));
  if (failed.length) {
    out.push("", p.red(`Nothing written: ${plural(failed.length, "server")} could not be reached.`));
    return print(out.join("\n"), 2);
  }
  if (previous && changes.length === 0) {
    out.push(`${p.green("✓")} ${rel(options, options.lockfile)} is already up to date.`);
    return print(out.join("\n"));
  }
  if (changes.length) {
    out.push(...renderChangesByServer(changes, undefined, p), "");
    out.push(`${p.green("Accepted")} ${plural(changes.length, "change")} (${summaryLine(changes)}) into ${p.bold(rel(options, options.lockfile))}.`);
    out.push("Review the diff of mcp.lock before you commit it.");
  } else {
    out.push(`${p.green("Wrote")} ${p.bold(rel(options, options.lockfile))}.`);
  }
  return print(out.join("\n"));
}

/* --------------------------------------------------------------- helpers */

async function snapshot(options: Options): Promise<{ specs: ServerSpec[]; results: SnapshotResult[]; configPath: string }> {
  const configPath = findConfig(options.cwd, options.config);
  const specs = loadConfig(configPath);
  if (specs.length === 0) throw new UserError(`${rel(options, configPath)} does not define any MCP servers.`);
  if (!options.json && process.stderr.isTTY) process.stderr.write(options.p.dim(`Contacting ${plural(specs.length, "server")}…\n`));
  const results = await snapshotAll(specs, { timeoutMs: options.timeoutMs, verbose: options.verbose, version: VERSION });
  return { specs, results, configPath };
}

function toLockfile(results: SnapshotResult[]): Lockfile {
  const servers: Record<string, ServerEntry> = {};
  for (const result of results) if (result.ok) servers[result.name] = result.entry;
  return { lockfileVersion: 1, servers };
}

async function review(changes: Change[], options: Options): Promise<Map<Change, Review>> {
  const targets = reviewable(changes);
  const map = new Map<Change, Review>();
  if (targets.length === 0) return map;
  if (!options.json && process.stderr.isTTY) {
    process.stderr.write(options.p.dim(`Asking Claude (${options.model}) to review ${plural(targets.length, "change")}…\n`));
  }
  const reviews = await explainChanges(targets, {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: options.model,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  });
  for (const item of reviews) {
    const change = targets[item.index];
    if (change) map.set(change, item);
  }
  return map;
}

function withReviews(changes: Change[], reviews: Map<Change, Review> | undefined): unknown[] {
  return changes.map((change) => {
    const item = reviews?.get(change);
    return item ? { ...change, claudeReview: { risk: item.risk, reason: item.reason } } : change;
  });
}

function renderGroups(results: SnapshotResult[], changes: Change[], reviews: Map<Change, Review> | undefined, p: Palette): string[] {
  const out: string[] = [];
  const byServer = groupByServer(changes);
  const seen = new Set<string>();
  for (const result of results) {
    seen.add(result.name);
    const own = byServer.get(result.name) ?? [];
    if (!result.ok || own.length === 0) out.push(serverLine(result, p));
    else {
      out.push(`${p.red("✗")} ${p.bold(result.name)}  ${p.dim(plural(own.length, "change"))}`);
      for (const change of own) out.push(...renderWithReview(change, reviews, p));
    }
  }
  for (const [name, own] of byServer) {
    if (seen.has(name)) continue;
    out.push(`${p.red("✗")} ${p.bold(name)}  ${p.dim(plural(own.length, "change"))}`);
    for (const change of own) out.push(...renderWithReview(change, reviews, p));
  }
  return out;
}

function renderChangesByServer(changes: Change[], reviews: Map<Change, Review> | undefined, p: Palette): string[] {
  const out: string[] = [];
  for (const [name, own] of groupByServer(changes)) {
    out.push(`${p.red("✗")} ${p.bold(name)}  ${p.dim(plural(own.length, "change"))}`);
    for (const change of own) out.push(...renderWithReview(change, reviews, p));
  }
  return out;
}

function renderWithReview(change: Change, reviews: Map<Change, Review> | undefined, p: Palette): string[] {
  const lines = [renderChange(change, p)];
  const item = reviews?.get(change);
  if (item) {
    const tint = item.risk === "malicious" ? p.red : item.risk === "suspicious" ? p.yellow : p.green;
    lines.push(`${" ".repeat(12)}${p.cyan("Claude:")} ${tint(item.risk)}. ${item.reason}`);
  }
  return lines;
}

function groupByServer(changes: Change[]): Map<string, Change[]> {
  const map = new Map<string, Change[]>();
  for (const change of changes) map.set(change.server, [...(map.get(change.server) ?? []), change]);
  return map;
}

function serverLine(result: SnapshotResult, p: Palette): string {
  if (!result.ok) {
    const [first, ...more] = result.error.split("\n");
    return [`${p.red("✗")} ${p.bold(result.name)}  ${p.red(`could not connect: ${first}`)}`, ...more.map((line) => `    ${p.dim(line)}`)].join("\n");
  }
  const { entry } = result;
  const tools = Object.keys(entry.tools).length;
  const prompts = Object.keys(entry.prompts ?? {}).length;
  const parts = [plural(tools, "tool")];
  if (prompts) parts.push(plural(prompts, "prompt"));
  if (entry.instructions) parts.push("instructions");
  const info = entry.serverInfo?.name ? `  ${entry.serverInfo.name}${entry.serverInfo.version ? `@${entry.serverInfo.version}` : ""}` : "";
  return `${p.green("✓")} ${p.bold(result.name)}  ${p.dim(`${entry.transport} · ${parts.join(", ")}${info}`)}`;
}

function footer(changes: Change[], failedCount: number, mode: "verify" | "diff", options: Options, failingCount: number): string[] {
  const { p } = options;
  const lines: string[] = [];
  if (failedCount) lines.push(p.red(`${plural(failedCount, "server")} could not be reached, so ${failedCount === 1 ? "it was" : "they were"} not verified.`));
  if (changes.length === 0) {
    if (!failedCount) lines.push(`${p.green("✓")} No drift. Every server matches ${rel(options, options.lockfile)}.`);
    return lines;
  }
  lines.push(`${p.bold("Drift:")} ${plural(changes.length, "change")} (${summaryLine(changes)}).`);
  if (mode === "verify" && failingCount === 0) {
    lines.push(p.dim(`Nothing at or above --fail-on ${options.failOn}, so this run passes.`));
  }
  lines.push("Review the changes, then run `mcpkeel update` to accept them.");
  if (mode === "diff" && !options.explain) lines.push(p.dim("Add --explain to have Claude assess the changed text."));
  return lines;
}

interface Note {
  server: string;
  subject: string;
  message: string;
}

/** Things worth knowing at init time, when there is no earlier lockfile to diff against. */
function collectNotes(specs: ServerSpec[], lock: Lockfile): Note[] {
  const notes: Note[] = [];
  for (const spec of specs) {
    const entry = lock.servers[spec.name];
    if (!entry) continue;
    for (const hit of scanServer(entry)) {
      for (const flag of hit.flags) notes.push({ server: spec.name, subject: hit.subject, message: `${flag.label}: "${flag.excerpt}"` });
    }
    const unpinned = unpinnedPackage(spec);
    if (unpinned) {
      notes.push({
        server: spec.name,
        subject: "launch command",
        message: `"${unpinned}" has no version pinned, so each run may fetch a newer server. mcpkeel will catch the changes; pinning the version prevents them.`,
      });
    }
  }
  return notes;
}

/** Package runners that fetch the latest release unless a version is given. */
function unpinnedPackage(spec: ServerSpec): string | undefined {
  if (spec.transport !== "stdio" || !spec.command) return undefined;
  const runner = basename(spec.command).replace(/\.(cmd|exe)$/i, "");
  if (!["npx", "bunx", "uvx", "pipx"].includes(runner)) return undefined;
  const pkg = (spec.args ?? []).find((arg) => !arg.startsWith("-") && arg !== "run" && arg !== "dlx");
  if (!pkg || pkg.startsWith(".") || pkg.startsWith("/")) return undefined;
  const at = pkg.lastIndexOf("@");
  const version = at > 0 ? pkg.slice(at + 1) : pkg.includes("==") ? pkg.split("==")[1] : undefined;
  return version && version !== "latest" ? undefined : pkg;
}

function serverSummaries(results: SnapshotResult[], changes: Change[]): unknown[] {
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.server, (counts.get(change.server) ?? 0) + 1);
  return results.map((result) =>
    result.ok
      ? {
          name: result.name,
          status: counts.get(result.name) ? "drift" : "ok",
          transport: result.entry.transport,
          tools: Object.keys(result.entry.tools).length,
          prompts: Object.keys(result.entry.prompts ?? {}).length,
          serverInfo: result.entry.serverInfo,
          integrity: result.entry.integrity,
        }
      : { name: result.name, status: "error", error: result.error },
  );
}

function errorList(results: SnapshotResult[]): { server: string; error: string }[] {
  return results.flatMap((result) => (result.ok ? [] : [{ server: result.name, error: result.error }]));
}

function rel(options: Options, path: string): string {
  const relativePath = relative(options.cwd, path);
  return relativePath && !relativePath.startsWith("..") ? relativePath : path;
}

function print(text: string, code = 0): number {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return code;
}

main(process.argv.slice(2)).then(
  (code) => {
    // Some servers keep child processes or sockets alive after close; do not wait on them.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  },
  (err) => {
    const p = palette(Boolean(process.stderr.isTTY) && !process.env.NO_COLOR);
    if (err instanceof UserError) process.stderr.write(`${p.red("mcpkeel:")} ${err.message}\n`);
    else process.stderr.write(`${p.red("mcpkeel: unexpected error")}\n${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  },
);
