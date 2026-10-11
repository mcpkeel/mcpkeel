#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { UserError, findConfig, loadConfig } from "./config.js";
import { atLeast, crossServerNotes, diffEntries, diffLockfiles, scanServer } from "./diff.js";
import { renderSarif, withCodes } from "./findings.js";
import { LOCKFILE_NAME, readLockfile, writeLockfile } from "./lockfile.js";
import { POLICY_NAME, applyPolicy, readPolicy, unknownServers, type Policy } from "./policy.js";
import { packageRef } from "./resolve.js";
import { palette, plural, renderChange, renderMarkdown, summarize, summaryLine, type Palette } from "./report.js";
import { DEFAULT_MODEL, applyReviews, claudeReviewer, openaiReviewer, reviewable } from "./review.js";
import { visible } from "./scan.js";
import { snapshotAll, type SnapshotResult } from "./snapshot.js";
import { SEVERITIES, type Change, type Lockfile, type ServerEntry, type ServerSpec, type Severity } from "./types.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `mcpkeel ${VERSION}: the lockfile for MCP

Pin what your MCP servers tell your agent, and find out when it changes.

Usage
  mcpkeel init                 Snapshot every server in your MCP config into mcp.lock
  mcpkeel verify               Compare live servers against mcp.lock; exit 1 on drift
  mcpkeel diff                 Show what changed, with severity (exits 0 unless incomplete)
  mcpkeel diff <old> <new>     Compare two lockfiles without contacting any server
  mcpkeel update [server...]   Accept the current definitions and rewrite mcp.lock
  mcpkeel demo                 Watch mcpkeel catch a rug pull, on a local demo server

Options
  -c, --config <path>     MCP config to read (default: the first of .mcp.json,
                          mcp.json, .cursor/mcp.json, .vscode/mcp.json,
                          opencode.json, opencode.jsonc, .codex/config.toml,
                          .gemini/settings.json)
  -l, --lockfile <path>   Lockfile to read and write (default: mcp.lock)
      --fail-on <level>   verify: lowest severity that fails the run:
                          critical, high, medium or low (default: low)
      --explain           verify, diff: have Claude read each changed text and
                          say whether it is cosmetic, functional or adversarial.
                          Adversarial changes become critical. Cosmetic rewordings
                          drop to low, but never when a built-in check fired.
                          Needs ANTHROPIC_API_KEY. Sends only the changed
                          definitions to the Claude API.
      --model <id>        Model for --explain (default: ${DEFAULT_MODEL})
      --provider <name>   Reviewer for --explain: anthropic (default) or openai,
                          for any OpenAI-compatible endpoint. openai needs
                          --model, and MCPKEEL_REVIEW_API_KEY or OPENAI_API_KEY
                          unless the endpoint is local.
      --review-url <url>  Base URL of the reviewer's API, such as
                          http://localhost:11434/v1 for a local model server
      --probe             init, verify, diff: read each server twice more. Once after
                          five calls to a tool that does not exist, to catch servers
                          that change their definitions partway through a session.
                          Once under another client name, to catch servers that
                          answer a checker differently from an agent.
      --no-resolve        Do not look up the release that npx, uvx, pipx or docker
                          runs. By default each one is pinned by version and
                          registry digest, so a new release fails verify even
                          when the definitions stay the same.
      --sarif <file>      verify, diff: also write the changes as SARIF 2.1.0, for
                          GitHub code scanning. Each carries a stable MK code
                          and its OWASP MCP Top 10 category.
      --policy <file>     verify, diff: decisions about findings, each with a
                          reason (default: mcpkeel.json next to the lockfile,
                          when it exists). See the README.
      --report <file>     verify, diff, update: also append a Markdown report to
                          <file>, for pull request bodies and job summaries
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
  provider: "anthropic" | "openai";
  model: string | undefined;
  reviewUrl?: string;
  report?: string;
  sarif?: string;
  /** An explicit --policy path; otherwise mcpkeel.json next to the lockfile is read if it exists. */
  policy?: string;
  probe: boolean;
  resolve: boolean;
  force: boolean;
  timeoutMs: number;
  json: boolean;
  verbose: boolean;
  cwd: string;
  color: boolean;
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
        provider: { type: "string" },
        "review-url": { type: "string" },
        report: { type: "string" },
        sarif: { type: "string" },
        policy: { type: "string" },
        probe: { type: "boolean" },
        "no-resolve": { type: "boolean" },
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

  const provider = (values.provider ?? process.env.MCPKEEL_PROVIDER ?? "anthropic").toLowerCase();
  if (provider !== "anthropic" && provider !== "openai") throw new UserError("--provider must be anthropic or openai.");

  const cwd = process.cwd();
  const color = !values["no-color"] && !values.json && !process.env.NO_COLOR && (process.stdout.isTTY || Boolean(process.env.FORCE_COLOR));
  const options: Options = {
    config: values.config,
    lockfile: resolve(cwd, values.lockfile ?? LOCKFILE_NAME),
    failOn,
    explain: Boolean(values.explain),
    provider,
    // Claude has a default model. An OpenAI-compatible endpoint can serve anything, so the model is named.
    model: values.model ?? process.env.MCPKEEL_MODEL ?? (provider === "anthropic" ? DEFAULT_MODEL : undefined),
    reviewUrl: values["review-url"] ?? process.env.MCPKEEL_REVIEW_URL,
    report: values.report ? resolve(cwd, values.report) : undefined,
    sarif: values.sarif ? resolve(cwd, values.sarif) : undefined,
    policy: values.policy ? resolve(cwd, values.policy) : undefined,
    probe: Boolean(values.probe),
    resolve: !values["no-resolve"],
    force: Boolean(values.force),
    timeoutMs: timeoutSecs * 1000,
    json: Boolean(values.json),
    verbose: Boolean(values.verbose),
    cwd,
    color,
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
    case "demo":
      return demo(options);
    default:
      throw new UserError(`Unknown command "${command}".\nRun \`mcpkeel --help\` for usage.`);
  }
}

/* ------------------------------------------------------------------ demo */

/**
 * Pin a local demo server, let it change the way a compromised release would,
 * and run verify. Everything happens in a temporary directory, with a server
 * that ships with mcpkeel, so nothing touches the network or the current project.
 */
async function demo(options: Options): Promise<number> {
  const { p } = options;
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-demo-"));
  const server = fileURLToPath(new URL("./demo-server.js", import.meta.url));
  const cli = fileURLToPath(import.meta.url);
  const writeConfig = (stage: string): void =>
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { notes: { command: process.execPath, args: [server], env: { MCPKEEL_DEMO_STAGE: stage } } } }, null, 2));
  const step = (args: string[]): { code: number; out: string } => {
    const child = spawnSync(process.execPath, [cli, ...args, ...(options.color ? [] : ["--no-color"])], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...(options.color ? { FORCE_COLOR: "1" } : {}) },
    });
    return { code: child.status ?? 2, out: `${child.stdout}${child.stderr}`.trimEnd() };
  };

  try {
    print(p.bold("1. A notes server you reviewed and trust. mcpkeel pins what it tells your agent:"));
    writeConfig("clean");
    const init = step(["init"]);
    print(`${indent(init.out)}
`);
    if (init.code !== 0) return init.code;

    print(p.bold("2. A new release of the server ships. Same name, same command, new tool descriptions."));
    print(p.bold("   Your agent would read them as instructions. In CI, `mcpkeel verify` runs:"));
    writeConfig("poisoned");
    const verify = step(["verify"]);
    print(`${indent(verify.out)}
`);

    if (verify.code !== 1) {
      print(p.red(`The demo expected verify to exit 1, and it exited ${verify.code}.`));
      return 2;
    }
    print(p.bold(`3. verify exited 1, so the build fails before an agent sees the new text.`));
    print("   Try it on your own servers: npx mcpkeel init, commit mcp.lock, run npx mcpkeel verify in CI.");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `   ${line}` : line))
    .join("\n");
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
  const notes = collectNotes(specs, lock, results);

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
  const { specs, results, configPath } = await snapshot(options);
  keepLockedPins(specs, results, locked, options);
  const failed = results.filter((r) => !r.ok);
  const changes = diffLockfiles(locked, toLockfile(results), new Set(failed.map((r) => r.name)));
  changes.push(...probeChanges(results));
  const policy = loadPolicy(options);
  const strays = policy ? unknownServers(policy, locked) : [];
  const kept = policy ? applyPolicy(changes, policy) : changes;
  changes.splice(0, changes.length, ...kept);
  sortChanges(changes);
  // In verify, a review that cannot run leaves the stricter rule-based severities
  // in place, so a missing key (a pull request from a fork, say) never loosens the gate.
  const reviewError = options.explain ? await review(changes, options, mode === "verify") : undefined;

  const failing = changes.filter((change) => atLeast(change.severity, options.failOn));
  const incomplete = incompleteSteps(results, reviewError);
  // A check that did not run is not a check that passed. A server that cannot be
  // reached, or a probe that could not finish, fails closed. A review that cannot
  // run does not: the rule-based severities it leaves in place are the stricter ones.
  const blocked = incomplete.some((step) => step.step !== "review");
  const code = blocked ? 2 : mode === "verify" && failing.length ? 1 : 0;

  writeReport(options, {
    heading: changes.length
      ? `mcpkeel: ${plural(changes.length, "change")} (${summaryLine(changes)})`
      : blocked
        ? "mcpkeel: verification incomplete"
        : "mcpkeel: no drift",
    intro: changes.length
      ? `What your MCP servers send today no longer matches ${codeName(rel(options, options.lockfile))}.`
      : blocked
        ? `Nothing read so far differs from ${codeName(rel(options, options.lockfile))}, but part of the check did not run.`
        : `Every MCP server matches ${codeName(rel(options, options.lockfile))}.`,
    changes,
    errors: errorList(results),
    incomplete: incomplete.filter((step) => step.step !== "connect"),
    footer: reviewError ? "Review unavailable, so severities are rule-based only." : undefined,
  });
  writeSarif(options, changes, options.lockfile);

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
          changes: changes.map(withCodes),
          errors: errorList(results),
          complete: incomplete.length === 0,
          incomplete,
          ...(policy ? { policy: { path: policy.path, entries: policy.accept.length, unknownServers: strays.map((entry) => entry.server) } } : {}),
          ...(options.explain ? { review: { available: reviewError === undefined, error: reviewError } } : {}),
        },
        null,
        2,
      ),
      code,
    );
  }

  const { p } = options;
  const out: string[] = [p.dim(`config  ${rel(options, configPath)}`), p.dim(`lock    ${rel(options, options.lockfile)}`), ""];
  out.push(...renderGroups(results, changes, p));
  out.push("", ...footer(changes, failed.length, mode, options, failing.length, incomplete));
  if (reviewError) out.push(p.yellow(`Review unavailable, so severities are rule-based only: ${reviewError}`));
  for (const result of results) {
    if (result.ok && result.probeNote) out.push(p.yellow(`Probe incomplete: ${visible(result.name)} ${visible(result.probeNote)}`));
    if (result.ok && result.packageNote) out.push(p.yellow(`${visible(result.name)}: ${visible(result.packageNote)}`));
  }
  for (const entry of strays) {
    out.push(p.yellow(`${rel(options, policy!.path)}: ${entry.rule} names server "${visible(entry.server)}", which is not in ${rel(options, options.lockfile)}, so it does nothing.`));
  }
  const unpinned = results.filter((r) => r.ok && r.entry.package && !locked.servers[r.name]?.package).map((r) => visible(r.name));
  if (unpinned.length) {
    out.push(p.dim(`${unpinned.join(", ")}: the package that runs is not pinned in ${rel(options, options.lockfile)} yet. \`mcpkeel update\` adds the pin.`));
  }
  return print(out.join("\n"), code);
}

async function diffFiles(options: Options, oldPath: string, newPath: string): Promise<number> {
  const before = readLockfile(resolve(options.cwd, oldPath));
  const after = readLockfile(resolve(options.cwd, newPath));
  const policy = loadPolicy(options);
  const changes = policy ? applyPolicy(diffLockfiles(before, after), policy) : diffLockfiles(before, after);
  if (options.explain) await review(changes, options, false);
  writeSarif(options, changes, resolve(options.cwd, newPath));

  writeReport(options, {
    heading: changes.length ? `mcpkeel: ${plural(changes.length, "change")} (${summaryLine(changes)})` : "mcpkeel: no changes",
    changes,
  });

  if (options.json) {
    return print(JSON.stringify({ drift: changes.length > 0, summary: summarize(changes), changes: changes.map(withCodes) }, null, 2));
  }
  const { p } = options;
  const out: string[] = [p.dim(`old  ${oldPath}`), p.dim(`new  ${newPath}`), ""];
  if (changes.length === 0) out.push(`${p.green("✓")} The two lockfiles pin the same definitions.`);
  else {
    out.push(...renderChangesByServer(changes, p));
    out.push("", `${plural(changes.length, "change")}: ${summaryLine(changes)}.`);
  }
  return print(out.join("\n"));
}

/* ---------------------------------------------------------------- update */

async function update(options: Options, only: string[]): Promise<number> {
  const previous = existsSync(options.lockfile) ? readLockfile(options.lockfile) : undefined;
  const { specs, results, configPath } = await snapshot(options);
  keepLockedPins(specs, results, previous, options);
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
  writeReport(options, {
    heading: changes.length ? `mcpkeel: accepted ${plural(changes.length, "change")} (${summaryLine(changes)})` : "mcpkeel: lockfile already up to date",
    changes,
    errors: errorList(selected),
  });

  if (options.json) {
    return print(
      JSON.stringify(
        { ok: failed.length === 0, config: configPath, lockfile: options.lockfile, accepted: changes.map(withCodes), errors: errorList(selected) },
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
  const pinned = Object.entries(next.servers)
    .filter(([name, entry]) => entry.package && previous?.servers[name] && !previous.servers[name]!.package)
    .map(([name]) => visible(name));
  if (previous && changes.length === 0) {
    out.push(
      pinned.length
        ? `${p.green("✓")} Pinned the package that runs for ${pinned.join(", ")}. Nothing else changed.`
        : `${p.green("✓")} ${rel(options, options.lockfile)} is already up to date.`,
    );
    return print(out.join("\n"));
  }
  if (changes.length) {
    out.push(...renderChangesByServer(changes, p), "");
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
  const results = await snapshotAll(specs, {
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    version: VERSION,
    probe: options.probe,
    // The reviewer's key is mcpkeel's own, so the servers it starts do not get it.
    hiddenEnv: options.explain && options.provider === "openai" ? ["OPENAI_API_KEY"] : [],
    resolve: options.resolve
      ? { timeoutMs: options.timeoutMs, npmRegistry: process.env.MCPKEEL_NPM_REGISTRY, pypiUrl: process.env.MCPKEEL_PYPI_URL }
      : false,
  });
  return { specs, results, configPath };
}

/**
 * When a package could not be looked up, or lookups are off, the current
 * reading has no pin. Keep the locked one, so that is not reported as the pin
 * being removed. The lookup failure itself is reported as incomplete.
 */
function keepLockedPins(specs: ServerSpec[], results: SnapshotResult[], locked: Lockfile | undefined, options: Options): void {
  for (const result of results) {
    if (!result.ok || result.entry.package) continue;
    const pin = locked?.servers[result.name]?.package;
    if (!pin || (options.resolve && !result.resolveError)) continue;
    const ref = packageRef(specs.find((spec) => spec.name === result.name)!);
    if (ref && ref.ecosystem === pin.ecosystem && ref.name === pin.name) result.entry = { ...result.entry, package: pin };
  }
}

function toLockfile(results: SnapshotResult[]): Lockfile {
  const servers: Record<string, ServerEntry> = {};
  for (const result of results) if (result.ok) servers[result.name] = result.entry;
  return { lockfileVersion: 1, servers };
}

/**
 * Ask the reviewer about the changes that carry text, and let it adjust their
 * severity. Returns a message when the review could not run and `lenient` says
 * to carry on without it; otherwise a failure is thrown.
 */
async function review(changes: Change[], options: Options, lenient: boolean): Promise<string | undefined> {
  const targets = reviewable(changes);
  if (targets.length === 0) return undefined;
  const reviewer =
    options.provider === "openai"
      ? openaiReviewer({
          apiKey: process.env.MCPKEEL_REVIEW_API_KEY || process.env.OPENAI_API_KEY || undefined,
          model: options.model,
          baseUrl: options.reviewUrl ?? process.env.OPENAI_BASE_URL,
        })
      : claudeReviewer({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: options.model ?? DEFAULT_MODEL,
          baseUrl: options.reviewUrl ?? process.env.ANTHROPIC_BASE_URL,
        });
  if (!options.json && process.stderr.isTTY) {
    process.stderr.write(options.p.dim(`Asking ${reviewer.name === "claude" ? "Claude" : "the reviewer"} (${reviewer.model}) to review ${plural(targets.length, "change")}…\n`));
  }
  try {
    applyReviews(targets, await reviewer.review(targets), reviewer);
  } catch (err) {
    if (lenient && err instanceof UserError) return err.message;
    throw err;
  }
  sortChanges(changes);
  return undefined;
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Keep each server's changes worst-first after a review moved severities around. */
function sortChanges(changes: Change[]): void {
  const order = new Map(changes.map((change, index) => [change, index]));
  changes.sort((a, b) =>
    a.server !== b.server
      ? a.server < b.server
        ? -1
        : 1
      : RANK[a.severity] - RANK[b.severity] || order.get(a)! - order.get(b)!,
  );
}

function loadPolicy(options: Options): Policy | undefined {
  return readPolicy(options.policy ?? join(dirname(options.lockfile), POLICY_NAME), options.policy !== undefined);
}

function writeSarif(options: Options, changes: Change[], lockfile: string): void {
  if (!options.sarif) return;
  let text = "";
  try {
    text = readFileSync(lockfile, "utf8");
  } catch {
    // A missing lockfile only costs the line numbers.
  }
  const uri = relative(options.cwd, lockfile).split(sep).join("/");
  try {
    writeFileSync(options.sarif, renderSarif({ version: VERSION, changes, lockfile: { uri: uri.startsWith("..") ? lockfile : uri, text } }));
  } catch (err) {
    throw new UserError(`Could not write SARIF to ${options.sarif}: ${(err as Error).message}`);
  }
}

function writeReport(options: Options, report: Parameters<typeof renderMarkdown>[0]): void {
  if (!options.report) return;
  try {
    appendFileSync(options.report, `${renderMarkdown(report)}\n`);
  } catch (err) {
    throw new UserError(`Could not write the report to ${options.report}: ${(err as Error).message}`);
  }
}

/** A path mcpkeel chose, shown as code in a Markdown report. */
function codeName(text: string): string {
  return `\`${text.replace(/`/g, "")}\``;
}

function renderGroups(results: SnapshotResult[], changes: Change[], p: Palette): string[] {
  const out: string[] = [];
  const byServer = groupByServer(changes);
  const seen = new Set<string>();
  for (const result of results) {
    seen.add(result.name);
    const own = byServer.get(result.name) ?? [];
    if (!result.ok || own.length === 0) out.push(serverLine(result, p));
    else {
      out.push(`${p.red("✗")} ${p.bold(visible(result.name))}  ${p.dim(plural(own.length, "change"))}`);
      for (const change of own) out.push(renderChange(change, p));
    }
  }
  for (const [name, own] of byServer) {
    if (seen.has(name)) continue;
    out.push(`${p.red("✗")} ${p.bold(visible(name))}  ${p.dim(plural(own.length, "change"))}`);
    for (const change of own) out.push(renderChange(change, p));
  }
  return out;
}

function renderChangesByServer(changes: Change[], p: Palette): string[] {
  const out: string[] = [];
  for (const [name, own] of groupByServer(changes)) {
    out.push(`${p.red("✗")} ${p.bold(visible(name))}  ${p.dim(plural(own.length, "change"))}`);
    for (const change of own) out.push(renderChange(change, p));
  }
  return out;
}

function groupByServer(changes: Change[]): Map<string, Change[]> {
  const map = new Map<string, Change[]>();
  for (const change of changes) map.set(change.server, [...(map.get(change.server) ?? []), change]);
  return map;
}

function serverLine(result: SnapshotResult, p: Palette): string {
  const name = visible(result.name);
  if (!result.ok) {
    const [first, ...more] = result.error.split("\n").map((line) => visible(line));
    return [`${p.red("✗")} ${p.bold(name)}  ${p.red(`could not connect: ${first}`)}`, ...more.map((line) => `    ${p.dim(line)}`)].join("\n");
  }
  const { entry } = result;
  const tools = Object.keys(entry.tools).length;
  const prompts = Object.keys(entry.prompts ?? {}).length;
  const parts = [plural(tools, "tool")];
  if (prompts) parts.push(plural(prompts, "prompt"));
  if (entry.instructions) parts.push("instructions");
  const info = entry.serverInfo?.name ? `  ${entry.serverInfo.name}${entry.serverInfo.version ? `@${entry.serverInfo.version}` : ""}` : "";
  return `${p.green("✓")} ${p.bold(name)}  ${p.dim(`${entry.transport} · ${parts.join(", ")}${visible(info) ? `  ${visible(info)}` : ""}`)}`;
}

function footer(
  changes: Change[],
  failedCount: number,
  mode: "verify" | "diff",
  options: Options,
  failingCount: number,
  incomplete: IncompleteStep[],
): string[] {
  const { p } = options;
  const lines: string[] = [];
  if (failedCount) lines.push(p.red(`${plural(failedCount, "server")} could not be reached, so ${failedCount === 1 ? "it was" : "they were"} not verified.`));
  const probes = incomplete.filter((step) => step.step === "probe").length;
  if (probes) lines.push(p.red(`--probe could not finish for ${plural(probes, "server")}, so ${probes === 1 ? "it was" : "they were"} not fully verified.`));
  const lookups = incomplete.filter((step) => step.step === "resolve");
  for (const step of lookups) lines.push(p.red(`${visible(step.server ?? "")}: ${visible(step.reason)}. The package it runs was not checked.`));
  if (changes.length === 0) {
    if (!failedCount && !probes && !lookups.length) lines.push(`${p.green("✓")} No drift. Every server matches ${rel(options, options.lockfile)}.`);
    return lines;
  }
  lines.push(`${p.bold("Drift:")} ${plural(changes.length, "change")} (${summaryLine(changes)}).`);
  if (mode === "verify" && failingCount === 0) {
    lines.push(p.dim(`Nothing at or above --fail-on ${options.failOn}, so this run passes.`));
  }
  const unstable = changes.filter((change) => change.kind.startsWith("probe.")).length;
  if (unstable < changes.length) lines.push("Review the changes, then run `mcpkeel update` to accept them.");
  if (unstable) {
    lines.push(
      `${plural(unstable, "finding")} came from --probe: the server gave different answers within one check. ` +
        "That cannot be accepted with `mcpkeel update`. Treat the server as untrusted until it holds still.",
    );
  }
  if (!options.explain && unstable < changes.length) lines.push(p.dim("Add --explain to have Claude read the changed text."));
  return lines;
}

/**
 * A server whose second reading did not match its first cannot be pinned at
 * all, so every difference is reported, and none of them can be accepted with
 * `update` or lowered by a review.
 */
function probeChanges(results: SnapshotResult[]): Change[] {
  const changes: Change[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    for (const finding of result.probes ?? []) {
      for (const change of diffEntries(result.name, result.entry, finding.entry)) {
        changes.push({
          ...change,
          kind: `probe.${finding.kind}.${change.kind}`,
          // Changing mid-session has no innocent reading. Answering by client name occasionally does.
          severity: finding.kind === "session" || change.severity === "critical" ? "critical" : "high",
          message: `${change.message} ${finding.how}`,
        });
      }
    }
  }
  return changes;
}

interface Note {
  server: string;
  subject: string;
  message: string;
}

/** Things worth knowing at init time, when there is no earlier lockfile to diff against. */
function collectNotes(specs: ServerSpec[], lock: Lockfile, results: SnapshotResult[]): Note[] {
  const notes: Note[] = [];
  for (const spec of specs) {
    const entry = lock.servers[spec.name];
    if (!entry) continue;
    for (const hit of scanServer(entry)) {
      for (const flag of hit.flags) notes.push({ server: spec.name, subject: visible(hit.subject), message: `${flag.label}: "${flag.excerpt}"` });
    }
    const result = results.find((r) => r.name === spec.name);
    if (result?.ok) {
      for (const finding of result.probes ?? []) {
        const differences = diffEntries(spec.name, result.entry, finding.entry);
        const first = differences[0];
        notes.push({
          server: spec.name,
          subject: "server",
          message: `gave different definitions ${finding.how} (${plural(differences.length, "difference")}${first ? `, starting with ${visible(first.subject)} ${visible(first.message)}` : ""}). The lockfile pins the first reading, and \`verify --probe\` will keep failing while this lasts.`,
        });
      }
      if (result.probeNote) notes.push({ server: spec.name, subject: "server", message: result.probeNote });
      if (result.resolveError) notes.push({ server: spec.name, subject: "package", message: `${result.resolveError}. It is not pinned.` });
      if (result.packageNote) notes.push({ server: spec.name, subject: "package", message: result.packageNote });
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
  for (const note of crossServerNotes(lock)) notes.push({ ...note, subject: visible(note.subject) });
  return notes;
}

/** Package runners that fetch the latest release unless a version is given. */
/** A package the config runs without naming a release, shown as written. */
function unpinnedPackage(spec: ServerSpec): string | undefined {
  const ref = packageRef(spec);
  if (!ref || ref.digest || (ref.requested && ref.requested !== "latest")) return undefined;
  return ref.ecosystem === "oci" ? ref.name : `${ref.name}${ref.requested ? `@${ref.requested}` : ""}`;
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

/** A part of the check that did not run. `server` is absent for the review, which covers every server at once. */
interface IncompleteStep {
  step: "connect" | "resolve" | "probe" | "review";
  server?: string;
  reason: string;
}

function incompleteSteps(results: SnapshotResult[], reviewError: string | undefined): IncompleteStep[] {
  const steps: IncompleteStep[] = [];
  for (const result of results) {
    if (!result.ok) {
      steps.push({ step: "connect", server: result.name, reason: result.error.split("\n")[0] ?? "" });
      continue;
    }
    if (result.resolveError) steps.push({ step: "resolve", server: result.name, reason: result.resolveError });
    if (result.probeNote) steps.push({ step: "probe", server: result.name, reason: result.probeNote });
  }
  if (reviewError !== undefined) steps.push({ step: "review", reason: reviewError });
  return steps;
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
