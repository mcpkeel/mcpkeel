import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");
const FIXTURE = join(here, "fixtures", "server.mjs");
const HTTP_FIXTURE = join(here, "fixtures", "http-server.mjs");

function run(cwd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_VARIANT: "${FIXTURE_VARIANT:-v1}" } },
      },
    }),
  );
  return dir;
}

test("init pins every tool, prompt and the server instructions", async () => {
  const dir = project();
  const result = await run(dir, ["init"]);
  assert.equal(result.code, 0, result.stderr);
  const lock = JSON.parse(readFileSync(join(dir, "mcp.lock"), "utf8"));
  assert.equal(lock.lockfileVersion, 1);
  const server = lock.servers.github;
  assert.deepEqual(Object.keys(server.tools), ["create_issue", "delete_branch", "search_code"]);
  assert.equal(server.tools.create_issue.description, "Create a new issue in a repository.");
  assert.match(server.tools.create_issue.integrity, /^sha256-/);
  assert.equal(server.instructions, "Use these tools to work with repositories.");
  assert.deepEqual(Object.keys(server.prompts), ["triage"]);
  assert.deepEqual(server.serverInfo, { name: "fixture-server", version: "1.0.0" });
});

test("the lockfile never contains env values", async () => {
  const dir = project();
  await run(dir, ["init"], { FIXTURE_VARIANT: "v1", SECRET_TOKEN: "hunter2" });
  const raw = readFileSync(join(dir, "mcp.lock"), "utf8");
  assert.ok(!raw.includes("FIXTURE_VARIANT"));
  assert.ok(!raw.includes("hunter2"));
});

test("init refuses to overwrite an existing lockfile without --force", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const again = await run(dir, ["init"]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already exists/);
  assert.equal((await run(dir, ["init", "--force"])).code, 0);
});

test("verify passes when nothing changed, and is byte-for-byte deterministic", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const first = readFileSync(join(dir, "mcp.lock"), "utf8");
  assert.equal((await run(dir, ["verify"])).code, 0);
  await run(dir, ["init", "--force"]);
  assert.equal(readFileSync(join(dir, "mcp.lock"), "utf8"), first);
});

test("reordered keys and tools are not drift", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify"], { FIXTURE_VARIANT: "reordered" });
  assert.equal(result.code, 0, result.stdout);
});

test("a poisoned tool description fails verify as critical", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "rugpull" });
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.summary.critical, 1);
  const change = report.changes.find((c) => c.kind === "tool.description.changed");
  assert.equal(change.severity, "critical");
  assert.equal(change.subject, "tool create_issue");
  const flagIds = change.flags.map((f) => f.id).sort();
  assert.deepEqual(flagIds, ["conceal-from-user", "instruction-markup", "sensitive-paths"]);
});

test("ordinary changes are graded by how close they are to model-visible text", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "benign" });
  assert.equal(result.code, 1);
  const bySeverity = Object.fromEntries(JSON.parse(result.stdout).changes.map((c) => [c.kind, c.severity]));
  assert.deepEqual(bySeverity, {
    "tool.description.changed": "high",
    "tool.added": "high",
    "tool.annotations.changed": "high",
    "tool.removed": "medium",
    "tool.param.added": "medium",
    "server.version.changed": "low",
  });
});

test("--fail-on lets lower-severity drift through", async () => {
  const dir = project();
  await run(dir, ["init"]);
  assert.equal((await run(dir, ["verify", "--fail-on", "critical"], { FIXTURE_VARIANT: "benign" })).code, 0);
  assert.equal((await run(dir, ["verify", "--fail-on", "high"], { FIXTURE_VARIANT: "benign" })).code, 1);
  assert.equal((await run(dir, ["verify", "--fail-on", "critical"], { FIXTURE_VARIANT: "rugpull" })).code, 1);
});

test("zero-width characters in a parameter description are critical and shown escaped", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify"], { FIXTURE_VARIANT: "hidden" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CRITICAL/);
  assert.match(result.stdout, /\\u200B/);
});

test("diff reports the same changes but always exits 0", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["diff"], { FIXTURE_VARIANT: "rugpull" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /CRITICAL/);
});

test("update accepts the changes, after which verify passes", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "benign" };
  const updated = await run(dir, ["update"], env);
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /Accepted 6 changes/);
  assert.equal((await run(dir, ["verify"], env)).code, 0);
  assert.equal((await run(dir, ["verify"])).code, 1);
});

test("diff <old> <new> compares two lockfiles offline", async () => {
  const dir = project();
  await run(dir, ["init", "--lockfile", "old.lock"]);
  await run(dir, ["init", "--lockfile", "new.lock"], { FIXTURE_VARIANT: "rugpull" });
  // No config in this directory: proves no server is contacted.
  const empty = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  const result = await run(empty, ["diff", join(dir, "old.lock"), join(dir, "new.lock"), "--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).summary.critical, 1);
});

test("a server added to the config but not pinned is reported", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  config.mcpServers.extra = { command: process.execPath, args: [FIXTURE] };
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify(config));
  const result = await run(dir, ["verify", "--json"]);
  assert.equal(result.code, 1);
  const change = JSON.parse(result.stdout).changes.find((c) => c.kind === "server.added");
  assert.equal(change.server, "extra");
  assert.equal(change.severity, "high");
  // update with a server name pins just that one.
  assert.equal((await run(dir, ["update", "extra"])).code, 0);
  assert.equal((await run(dir, ["verify"])).code, 0);
});

test("verify fails closed with exit 2 when a server cannot be reached", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  config.mcpServers.github.command = "mcpkeel-no-such-command";
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify(config));
  const result = await run(dir, ["verify"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /could not connect/);
});

test("init writes nothing when a server cannot be reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { gone: { command: "mcpkeel-no-such-command" } } }));
  const result = await run(dir, ["init"]);
  assert.equal(result.code, 2);
  assert.ok(!existsSync(join(dir, "mcp.lock")));
});

test("a missing environment variable is a clear error, not an empty string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { api: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${MCPKEEL_TEST_UNSET_TOKEN}" } } } }),
  );
  const result = await run(dir, ["init"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /MCPKEEL_TEST_UNSET_TOKEN is not set/);
});

test("reads VS Code style configs with comments and a `servers` key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(
    join(dir, "vscode.json"),
    `{
  // comment with a "quote" and a // inside
  "servers": {
    /* block */
    "github": { "command": ${JSON.stringify(process.execPath)}, "args": [${JSON.stringify(FIXTURE)}], },
  },
}`,
  );
  const result = await run(dir, ["init", "--config", "vscode.json"]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
});

test("works over Streamable HTTP with headers, and pins the URL without its query string", async (t) => {
  const child = spawn(process.execPath, [HTTP_FIXTURE], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk).trim())));

  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: { orders: { type: "http", url: `http://127.0.0.1:${port}/mcp?key=sekret`, headers: { Authorization: "Bearer ${ORDERS_TOKEN}" } } },
    }),
  );
  const ok = await run(dir, ["init"], { ORDERS_TOKEN: "test-token" });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const raw = readFileSync(join(dir, "mcp.lock"), "utf8");
  const lock = JSON.parse(raw);
  assert.equal(lock.servers.orders.transport, "http");
  assert.equal(lock.servers.orders.source.url, `http://127.0.0.1:${port}/mcp`);
  assert.ok(!raw.includes("test-token") && !raw.includes("sekret"));
  assert.deepEqual(Object.keys(lock.servers.orders.tools), ["get_order"]);

  const denied = await run(dir, ["verify"], { ORDERS_TOKEN: "wrong" });
  assert.equal(denied.code, 2);
  assert.match(denied.stdout, /needs authentication/);
});

/**
 * The JSON inside the request's delimiter, after checking that the delimiter is
 * the one the system prompt names and that it appears exactly once each way.
 */
function unwrap(system, content) {
  const tag = system.match(/between <(untrusted-[0-9a-f]{32})> and <\/\1>/)?.[1];
  assert.ok(tag, "the system prompt names the delimiter");
  assert.equal(content.split(`<${tag}>`).length, 2);
  assert.equal(content.split(`</${tag}>`).length, 2);
  assert.ok(content.startsWith(`<${tag}>\n`) && content.endsWith(`\n</${tag}>`));
  return content.slice(tag.length + 3, -(tag.length + 4));
}

/** A stand-in for the Claude API that answers every change with the verdict `decide` picks. */
async function mockClaude(t, decide, status = 200) {
  const calls = [];
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ url: req.url, headers: req.headers, body });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "overloaded" } }));
    }
    const items = JSON.parse(unwrap(body.system, body.messages[0].content));
    const verdicts = items.map((item) => ({ index: item.index, ...decide(item) }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: `Here you go:\n${JSON.stringify(verdicts)}` }] }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  return { calls, env: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}` } };
}

test("--explain sends only the changed definitions to the Claude API and prints the verdict", async (t) => {
  const claude = await mockClaude(t, () => ({ verdict: "adversarial", reason: "Tells the agent to read an SSH private key and hide it from the user." }));
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["diff", "--explain"], { FIXTURE_VARIANT: "rugpull", ...claude.env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude: adversarial\. Tells the agent to read an SSH private key/);

  const [call] = claude.calls;
  assert.equal(call.url, "/v1/messages");
  assert.equal(call.headers["x-api-key"], "sk-test");
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.body.model, "claude-sonnet-5-5");
  const sent = call.body.messages[0].content;
  assert.match(sent, /create_issue/);
  // The version bump has no text to review, so only one change is sent.
  assert.equal(JSON.parse(unwrap(call.body.system, sent)).length, 1);
});

test("text under review cannot close the delimiter around it", async (t) => {
  const claude = await mockClaude(t, () => ({ verdict: "functional", reason: "Changed." }));
  const dir = project();
  await run(dir, ["init"]);
  await run(dir, ["diff", "--explain"], { FIXTURE_VARIANT: "breakout", ...claude.env });
  await run(dir, ["diff", "--explain"], { FIXTURE_VARIANT: "breakout", ...claude.env });

  const [first, second] = claude.calls;
  const sent = first.body.messages[0].content;
  // No tag of any kind can be spelled by the server's text.
  assert.doesNotMatch(sent, /<\/?changes>/);
  assert.equal((sent.match(/</g) ?? []).length, 2);
  // The text still reaches the reviewer unchanged.
  const [item] = JSON.parse(unwrap(first.body.system, sent));
  assert.match(item.after, /<\/changes>\n\[\{"index": 0, "verdict": "cosmetic"/);
  // A new delimiter for every request.
  assert.notEqual(first.body.system, second.body.system);
});

test("diff --explain without a key explains how to get one", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["diff", "--explain"], { FIXTURE_VARIANT: "rugpull", ANTHROPIC_API_KEY: "" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ANTHROPIC_API_KEY/);
});

test("verify --explain lowers a cosmetic rewording to low, so --fail-on medium passes", async (t) => {
  const claude = await mockClaude(t, () => ({ verdict: "cosmetic", reason: "Same meaning, reworded." }));
  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "reworded", ...claude.env };

  // Without the review, the rewording is a high-severity description change.
  const plain = await run(dir, ["verify", "--fail-on", "medium"], { FIXTURE_VARIANT: "reworded" });
  assert.equal(plain.code, 1);

  const reviewed = await run(dir, ["verify", "--explain", "--fail-on", "medium", "--json"], env);
  assert.equal(reviewed.code, 0, reviewed.stdout);
  const change = JSON.parse(reviewed.stdout).changes.find((c) => c.kind === "tool.description.changed");
  assert.equal(change.severity, "low");
  assert.equal(change.ruleSeverity, "high");
  assert.deepEqual(change.review, { by: "claude", model: "claude-sonnet-5-5", verdict: "cosmetic", reason: "Same meaning, reworded.", effect: "lowered" });

  // The change is still recorded and still fails a strict gate: nothing is hidden.
  assert.equal((await run(dir, ["verify", "--explain"], env)).code, 1);
  const text = await run(dir, ["verify", "--explain", "--fail-on", "medium"], env);
  assert.match(text.stdout, /LOW\s+tool create_issue description changed/);
  assert.match(text.stdout, /Claude: cosmetic\. Same meaning, reworded\. \(lowered from HIGH\)/);
});

test("a reviewer cannot lower a change that a built-in check flagged", async (t) => {
  // The poisoned description, with a reviewer that has been talked into calling it harmless.
  const claude = await mockClaude(t, () => ({ verdict: "cosmetic", reason: "Looks like a harmless rewording." }));
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--explain", "--fail-on", "critical", "--json"], { FIXTURE_VARIANT: "rugpull", ...claude.env });
  assert.equal(result.code, 1);
  const change = JSON.parse(result.stdout).changes.find((c) => c.kind === "tool.description.changed");
  assert.equal(change.severity, "critical");
  assert.equal(change.review.effect, "kept");
  assert.equal(change.ruleSeverity, undefined);
});

test("verify --explain raises a change no pattern caught to critical", async (t) => {
  const claude = await mockClaude(t, () => ({ verdict: "adversarial", reason: "Asks the agent to copy issue contents to another tool." }));
  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "subtle" };

  // The built-in checks see an ordinary description change, which --fail-on critical lets through.
  assert.equal((await run(dir, ["verify", "--fail-on", "critical"], env)).code, 0);

  const result = await run(dir, ["verify", "--explain", "--fail-on", "critical", "--json"], { ...env, ...claude.env });
  assert.equal(result.code, 1);
  const change = JSON.parse(result.stdout).changes[0];
  assert.equal(change.kind, "tool.description.changed");
  assert.equal(change.severity, "critical");
  assert.equal(change.ruleSeverity, "high");
  assert.equal(change.review.effect, "raised");
});

test("verify --explain falls back to rule-based severities when the review cannot run", async (t) => {
  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "reworded" };

  const down = await mockClaude(t, () => ({}), 529);
  const failed = await run(dir, ["verify", "--explain", "--fail-on", "medium"], { ...env, ...down.env });
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /HIGH\s+tool create_issue description changed/);
  assert.match(failed.stdout, /Review unavailable, so severities are rule-based only: Claude API returned 529: overloaded/);

  // No key at all, as on a pull request from a fork: the gate stays as strict as without --explain.
  const noKey = await run(dir, ["verify", "--explain", "--fail-on", "medium", "--json"], { ...env, ANTHROPIC_API_KEY: "" });
  assert.equal(noKey.code, 1);
  const report = JSON.parse(noKey.stdout);
  assert.equal(report.review.available, false);
  assert.match(report.review.error, /ANTHROPIC_API_KEY/);
});

test("a request for the conversation and the user's keys is critical without any review", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "harvest" });
  assert.equal(result.code, 1);
  const change = JSON.parse(result.stdout).changes[0];
  assert.equal(change.kind, "tool.param.description.changed");
  assert.equal(change.severity, "critical");
  assert.deepEqual(change.flags.map((f) => f.id).sort(), ["conversation-harvest", "secret-harvest"]);
});

test("escape sequences from a server never reach the terminal", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify"], { FIXTURE_VARIANT: "ansi" });
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes(String.fromCharCode(27)), "raw ESC in output");
  assert.match(result.stdout, /\\x1B\[2J/);
  assert.match(result.stdout, /CRITICAL/);
});

test("--report appends a Markdown report that cannot be hijacked by the text it quotes", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--report", "report.md", "--json"], { FIXTURE_VARIANT: "rugpull" });
  assert.equal(result.code, 1);
  JSON.parse(result.stdout); // --report does not disturb the JSON on stdout
  const report = readFileSync(join(dir, "report.md"), "utf8");
  assert.match(report, /^## mcpkeel: 2 changes \(1 critical, 1 low\)/);
  assert.match(report, /### `github`/);
  assert.match(report, /- \*\*CRITICAL\*\* `tool create_issue` description changed/);
  // The poisoned text sits inside a fenced block, never as live markup.
  assert.match(report, /  ```diff\n  - Create a new issue in a repository\.\n  \+ Create a new issue in a repository\. <IMPORTANT>/);

  // A second run appends rather than overwrites, as a job summary expects.
  await run(dir, ["verify", "--report", "report.md"], { FIXTURE_VARIANT: "rugpull" });
  assert.equal(readFileSync(join(dir, "report.md"), "utf8").match(/^## mcpkeel/gm).length, 2);
});

test("--probe catches a server that rewrites its definitions partway through a session", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "deadbugz" };

  // Read once, at connect, the server looks exactly like what was pinned.
  assert.equal((await run(dir, ["verify"], env)).code, 0);

  const result = await run(dir, ["verify", "--probe", "--json"], env);
  assert.equal(result.code, 1);
  const change = JSON.parse(result.stdout).changes[0];
  assert.equal(change.kind, "probe.session.tool.description.changed");
  assert.equal(change.severity, "critical");
  assert.equal(change.message, "description changed after 5 more requests in the same session");
  assert.match(change.after, /<IMPORTANT>/);
});

test("--probe catches a server that answers a checker differently from an agent", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "twofaced" };
  assert.equal((await run(dir, ["verify"], env)).code, 0);

  const result = await run(dir, ["verify", "--probe"], env);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CRITICAL\s+tool create_issue description changed when the client is named "claude-code"/);

  // update pins what mcpkeel itself was shown, so the finding cannot be accepted away.
  assert.equal((await run(dir, ["update"], env)).code, 0);
  assert.equal((await run(dir, ["verify", "--probe"], env)).code, 1);
});

test("--probe is quiet on a server that gives the same answer every time", async () => {
  const dir = project();
  assert.equal((await run(dir, ["init", "--probe"])).code, 0);
  const result = await run(dir, ["verify", "--probe"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /No drift/);
});

test("init --probe says so when a server will not hold still", async () => {
  const dir = project();
  const result = await run(dir, ["init", "--probe"], { FIXTURE_VARIANT: "deadbugz" });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /gave different definitions after 5 more requests in the same session \(1 difference, starting with tool create_issue description changed\)/);
});

test("verify --probe that could not finish is incomplete, never clean", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const report = join(dir, "report.md");

  const text = await run(dir, ["verify", "--probe", "--report", report], { FIXTURE_VARIANT: "shy" });
  assert.equal(text.code, 2, text.stdout);
  assert.doesNotMatch(text.stdout, /No drift/);
  assert.match(text.stdout, /--probe could not finish for 1 server, so it was not fully verified\./);

  const md = readFileSync(report, "utf8");
  assert.match(md, /^## mcpkeel: verification incomplete$/m);
  assert.doesNotMatch(md, /no drift/);
  // The server's error text is quoted as code, never as Markdown.
  assert.match(md, /^- probe for `github`: ``could not be read a second time as "claude-code": .*`busy` <b>try later<\/b>``$/m);

  const json = JSON.parse((await run(dir, ["verify", "--probe", "--json"], { FIXTURE_VARIANT: "shy" })).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.complete, false);
  assert.deepEqual(
    json.incomplete.map(({ step, server }) => ({ step, server })),
    [{ step: "probe", server: "github" }],
  );

  // Without --probe nothing was asked of the probe, so the same server is clean.
  const plain = JSON.parse((await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "shy" })).stdout);
  assert.equal(plain.complete, true);
  assert.deepEqual(plain.incomplete, []);
});

test("a server that cannot be reached never produces a report that says no drift", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  config.mcpServers.github.args = [join(dir, "missing.mjs")];
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify(config));
  const report = join(dir, "report.md");
  const result = await run(dir, ["verify", "--report", report, "--json"]);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).complete, false);
  const md = readFileSync(report, "utf8");
  assert.match(md, /^## mcpkeel: verification incomplete$/m);
  assert.match(md, /### Could not be reached/);
});

test("a review that could not run is listed as not checked, and the gate stays strict", async (t) => {
  const dir = project();
  await run(dir, ["init"]);
  const down = await mockClaude(t, () => ({}), 529);
  const result = await run(dir, ["verify", "--explain", "--json"], { FIXTURE_VARIANT: "reworded", ...down.env });
  assert.equal(result.code, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.complete, false);
  assert.deepEqual(json.incomplete, [{ step: "review", reason: "Claude API returned 529: overloaded" }]);
});

test("a payload split between the description and a parameter is still caught", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "split" });
  assert.equal(result.code, 1);
  const changes = JSON.parse(result.stdout).changes;
  // Each field alone looks ordinary.
  assert.equal(changes.find((c) => c.kind === "tool.description.changed").severity, "high");
  assert.equal(changes.find((c) => c.kind === "tool.param.added").flags, undefined);
  // Read together, they ask for the issue body to be sent to an address.
  const joined = changes.find((c) => c.kind === "tool.text.flagged");
  assert.equal(joined.severity, "critical");
  assert.equal(joined.subject, "tool create_issue");
  assert.deepEqual(joined.flags.map((f) => f.id), ["exfiltration"]);
  assert.match(joined.flags[0].label, /\(across fields\)$/);
});

function twoServers() {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_VARIANT: "${FIXTURE_VARIANT:-v1}" } },
        mail: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_SET: "mail", FIXTURE_VARIANT: "v1" } },
      },
    }),
  );
  return dir;
}

test("a description that starts steering another server's tool is critical", async () => {
  const dir = twoServers();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "steer" });
  assert.equal(result.code, 1);
  const change = JSON.parse(result.stdout).changes.find((c) => c.kind === "tool.description.changed");
  assert.equal(change.server, "github");
  assert.equal(change.severity, "critical");
  assert.deepEqual(change.flags.map((f) => f.id), ["cross-server-reference"]);
  assert.equal(change.flags[0].label, 'refers to send_email, a tool on "mail"');

  // With only one server in view there is nothing to cross-reference, so it stays high.
  const alone = project();
  await run(alone, ["init"]);
  const single = JSON.parse((await run(alone, ["verify", "--json"], { FIXTURE_VARIANT: "steer" })).stdout);
  assert.equal(single.changes.find((c) => c.kind === "tool.description.changed").severity, "high");
});

test("a new tool that takes the name of another server's tool says so", async () => {
  const dir = twoServers();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify"], { FIXTURE_VARIANT: "collide" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /tool send_email added, with the same name as a tool on "mail"/);

  // Pinning it anyway is allowed, and init points the collision out.
  const fresh = twoServers();
  const init = await run(fresh, ["init"], { FIXTURE_VARIANT: "collide" });
  assert.match(init.stdout, /tool send_email: the same tool name is also exposed by "mail"/);
});

test("an instruction hidden in a parameter name is critical", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "paramname" });
  const change = JSON.parse(result.stdout).changes.find((c) => c.kind === "tool.param.added");
  assert.equal(change.severity, "critical");
  assert.deepEqual(change.flags.map((f) => f.id).sort(), ["sensitive-paths", "sentence-like-name"]);
});

test("an instruction written backwards is still read", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["verify"], { FIXTURE_VARIANT: "backwards" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CRITICAL/);
  assert.match(result.stdout, /tells the model to disregard other instructions \(read backwards\): ".*Ignore all previous instructions/);
});

test("works over legacy SSE", async (t) => {
  const child = spawn(process.execPath, [join(here, "fixtures", "sse-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill());
  const port = await new Promise((resolve) => child.stdout.once("data", (chunk) => resolve(String(chunk).trim())));
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { status: { type: "sse", url: `http://127.0.0.1:${port}/sse` } } }));
  const result = await run(dir, ["init"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const lock = JSON.parse(readFileSync(join(dir, "mcp.lock"), "utf8"));
  assert.equal(lock.servers.status.transport, "sse");
  assert.deepEqual(Object.keys(lock.servers.status.tools), ["ping"]);
  assert.equal((await run(dir, ["verify"])).code, 0);
});

test("finds .cursor/mcp.json and .vscode/mcp.json when there is no .mcp.json", async () => {
  const { mkdirSync } = await import("node:fs");
  for (const [folder, key] of [[".cursor", "mcpServers"], [".vscode", "servers"]]) {
    const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, "mcp.json"), JSON.stringify({ [key]: { github: { command: process.execPath, args: [FIXTURE] } } }));
    const result = await run(dir, ["init"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`config  \\${folder}`));
  }
});

test("with no config at all, says where it looked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  const result = await run(dir, ["init"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /No MCP config found/);
  assert.match(result.stderr, /--config/);
});

/* ------------------------------------------------------------ packages */

/** A stand-in for the npm registry, serving one package whose releases a test can change. */
async function mockNpm(t, state) {
  const requests = [];
  const api = createServer((req, res) => {
    requests.push(req.url);
    if (state.down) {
      res.writeHead(503);
      return res.end();
    }
    if (req.url !== "/demo-mcp") {
      res.writeHead(404);
      return res.end();
    }
    const versions = Object.fromEntries(Object.entries(state.releases).map(([version, digest]) => [version, { dist: { integrity: digest } }]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ "dist-tags": { latest: state.latest }, versions }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());
  return { requests, env: { MCPKEEL_NPM_REGISTRY: `http://127.0.0.1:${api.address().port}` } };
}

/** A project whose server is launched as `npx -y demo-mcp`, with an `npx` on PATH that starts the fixture instead of fetching anything. */
function npxProject(spec = "demo-mcp") {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npx"), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}"\n`);
  chmodSync(join(bin, "npx"), 0o755);
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "npx", args: ["-y", spec] } } }));
  return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
}

const SHA_A = "sha512-" + "A".repeat(86) + "==";
const SHA_B = "sha512-" + "B".repeat(86) + "==";

test("init pins the release npx runs, and a new release fails verify though the definitions are the same", async (t) => {
  const state = { latest: "1.0.0", releases: { "1.0.0": SHA_A } };
  const npm = await mockNpm(t, state);
  const { dir, env } = npxProject();
  const all = { ...env, ...npm.env };

  assert.equal((await run(dir, ["init"], all)).code, 0);
  const lock = JSON.parse(readFileSync(join(dir, "mcp.lock"), "utf8"));
  assert.deepEqual(lock.servers.demo.package, { ecosystem: "npm", name: "demo-mcp", version: "1.0.0", integrity: SHA_A });
  assert.equal((await run(dir, ["verify"], all)).code, 0);

  state.latest = "1.0.1";
  state.releases["1.0.1"] = SHA_B;
  const result = await run(dir, ["verify", "--json"], all);
  assert.equal(result.code, 1);
  const [change] = JSON.parse(result.stdout).changes;
  assert.equal(change.kind, "server.package.changed");
  assert.equal(change.severity, "high");
  assert.equal(change.message, "runs a different release: demo-mcp@1.0.0 → demo-mcp@1.0.1");
});

test("a published release whose contents changed is critical", async (t) => {
  const state = { latest: "1.0.0", releases: { "1.0.0": SHA_A } };
  const npm = await mockNpm(t, state);
  const { dir, env } = npxProject("demo-mcp@1.0.0");
  const all = { ...env, ...npm.env };
  await run(dir, ["init"], all);

  state.releases["1.0.0"] = SHA_B;
  const result = await run(dir, ["verify", "--json"], all);
  assert.equal(result.code, 1);
  const [change] = JSON.parse(result.stdout).changes;
  assert.equal(change.kind, "server.package.tampered");
  assert.equal(change.severity, "critical");
});

test("a registry that cannot be reached leaves verify incomplete, and --no-resolve skips the lookup on purpose", async (t) => {
  const state = { latest: "1.0.0", releases: { "1.0.0": SHA_A } };
  const npm = await mockNpm(t, state);
  const { dir, env } = npxProject();
  const all = { ...env, ...npm.env };
  await run(dir, ["init"], all);

  state.down = true;
  const result = await run(dir, ["verify", "--json"], all);
  assert.equal(result.code, 2);
  const json = JSON.parse(result.stdout);
  // The pin is not reported as removed: the lookup did not run, and that is what is reported.
  assert.deepEqual(json.changes, []);
  assert.deepEqual(json.incomplete.map((s) => s.step), ["resolve"]);
  assert.match(json.incomplete[0].reason, /could not look up npm package demo-mcp/);

  const before = npm.requests.length;
  const skipped = await run(dir, ["verify", "--no-resolve", "--json"], all);
  assert.equal(skipped.code, 0);
  assert.equal(JSON.parse(skipped.stdout).complete, true);
  assert.equal(npm.requests.length, before);
});

test("a lockfile from before package pins is not drift", async (t) => {
  const state = { latest: "1.0.0", releases: { "1.0.0": SHA_A } };
  const npm = await mockNpm(t, state);
  const { dir, env } = npxProject();
  const all = { ...env, ...npm.env };
  await run(dir, ["init"], all);
  const lock = JSON.parse(readFileSync(join(dir, "mcp.lock"), "utf8"));
  delete lock.servers.demo.package;
  writeFileSync(join(dir, "mcp.lock"), JSON.stringify(lock));

  const result = await run(dir, ["verify"], all);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /demo: the package that runs is not pinned in mcp\.lock yet\. `mcpkeel update` adds the pin\./);
  const updated = await run(dir, ["update"], all);
  assert.match(updated.stdout, /Pinned the package that runs for demo\. Nothing else changed\./);
  assert.equal(JSON.parse(readFileSync(join(dir, "mcp.lock"), "utf8")).servers.demo.package.version, "1.0.0");
});

test("a version range cannot be pinned, and init says so", async (t) => {
  const npm = await mockNpm(t, { latest: "1.2.0", releases: { "1.2.0": SHA_A } });
  const { dir, env } = npxProject("demo-mcp@^1.0.0");
  const result = await run(dir, ["init"], { ...env, ...npm.env });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /demo-mcp@\^1\.0\.0 is a range or an unknown tag/);
  assert.equal(JSON.parse(readFileSync(join(dir, "mcp.lock"), "utf8")).servers.demo.package, undefined);
});

test("a remote server at a cloud metadata address is refused before any request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { meta: { type: "http", url: "http://169.254.169.254/mcp" } } }));
  const result = await run(dir, ["init"], {});
  assert.equal(result.code, 2);
  assert.match(result.stdout, /refused: 169\.254\.169\.254 resolves to 169\.254\.169\.254, a link-local or cloud metadata address/);
});

/* ------------------------------------------------------------- clients */

test("the same server reads the same from Claude Code, opencode, Codex and Gemini CLI configs", async () => {
  const node = process.execPath;
  const formats = {
    ".mcp.json": JSON.stringify({ mcpServers: { github: { command: node, args: [FIXTURE], env: { FIXTURE_VARIANT: "${MCPKEEL_T_VARIANT}" } } } }),
    "opencode.jsonc": `{
      // opencode keeps the command and its arguments in one array.
      "$schema": "https://opencode.ai/config.json",
      "mcp": { "github": { "type": "local", "command": [${JSON.stringify(node)}, ${JSON.stringify(FIXTURE)}], "environment": { "FIXTURE_VARIANT": "{env:MCPKEEL_T_VARIANT}" }, "enabled": true },
               "off": { "type": "local", "command": ["nothing"], "enabled": false } },
    }`,
    ".codex/config.toml": [
      "[mcp_servers.github]",
      `command = ${JSON.stringify(node)}`,
      `args = [${JSON.stringify(FIXTURE)}]`,
      "",
      "[mcp_servers.github.env]",
      'FIXTURE_VARIANT = "${MCPKEEL_T_VARIANT}"',
      "",
      "[mcp_servers.off]",
      'command = "nothing"',
      "enabled = false",
    ].join("\n"),
    ".gemini/settings.json": JSON.stringify({ mcpServers: { github: { command: node, args: [FIXTURE], env: { FIXTURE_VARIANT: "$MCPKEEL_T_VARIANT" } } } }),
  };

  const base = project();
  writeFileSync(join(base, ".mcp.json"), formats[".mcp.json"]);
  const env = { MCPKEEL_T_VARIANT: "v1" };
  assert.equal((await run(base, ["init"], env)).code, 0);
  const lock = readFileSync(join(base, "mcp.lock"), "utf8");

  for (const [file, text] of Object.entries(formats)) {
    const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    writeFileSync(join(dir, "mcp.lock"), lock);
    const clean = await run(dir, ["verify"], env);
    assert.equal(clean.code, 0, `${file}: ${clean.stdout}${clean.stderr}`);
    assert.match(clean.stdout, new RegExp(`config  ${file.replace(/\./g, "\\.")}`));
    // The environment reference is expanded, in each client's own syntax.
    const drifted = await run(dir, ["verify"], { MCPKEEL_T_VARIANT: "rugpull" });
    assert.equal(drifted.code, 1, file);
  }
});

test("Codex and Gemini CLI remote servers keep their headers and transport", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const dir = mkdtempSync(join(tmpdir(), "mcpkeel-test-"));
  mkdirSync(join(dir, ".codex"));
  writeFileSync(
    join(dir, ".codex", "config.toml"),
    '[mcp_servers.figma]\nurl = "https://mcp.example.com/mcp"\nbearer_token_env_var = "FIGMA_TOKEN"\nhttp_headers = { "X-Region" = "us" }\nenv_http_headers = { "X-Key" = "KEY_VAR" }\n',
  );
  assert.deepEqual(loadConfig(join(dir, ".codex", "config.toml")), [
    { name: "figma", transport: "http", url: "https://mcp.example.com/mcp", headers: { "X-Region": "us", "X-Key": "${KEY_VAR}", Authorization: "Bearer ${FIGMA_TOKEN}" } },
  ]);

  mkdirSync(join(dir, ".gemini"));
  writeFileSync(
    join(dir, ".gemini", "settings.json"),
    JSON.stringify({ mcpServers: { sse: { url: "http://localhost:8080/sse" }, http: { httpUrl: "http://localhost:3000/mcp", headers: { Authorization: "Bearer $TOKEN" } } } }),
  );
  assert.deepEqual(
    loadConfig(join(dir, ".gemini", "settings.json")).map(({ name, transport, headers }) => ({ name, transport, headers })),
    [
      { name: "http", transport: "http", headers: { Authorization: "Bearer ${TOKEN}" } },
      { name: "sse", transport: "sse", headers: {} },
    ],
  );
});

/* --------------------------------------------------------------- codes */

test("verify --sarif writes code-scanning results with stable codes, OWASP categories and lockfile lines", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const sarifPath = join(dir, "mcpkeel.sarif");
  const result = await run(dir, ["verify", "--sarif", sarifPath], { FIXTURE_VARIANT: "rugpull" });
  assert.equal(result.code, 1);

  const sarif = JSON.parse(readFileSync(sarifPath, "utf8"));
  assert.equal(sarif.version, "2.1.0");
  const [runLog] = sarif.runs;
  assert.equal(runLog.tool.driver.name, "mcpkeel");
  const poisoned = runLog.results.find((r) => r.ruleId === "MK112");
  assert.equal(poisoned.level, "error");
  assert.equal(poisoned.properties.owasp, "MCP03:2025");
  assert.match(poisoned.message.text, /^github: tool create_issue description changed \(critical\)\./);
  assert.match(poisoned.message.text, /MK203 instruction-like markup/);
  // The result points at the tool's line in the lockfile.
  const location = poisoned.locations[0].physicalLocation;
  assert.equal(location.artifactLocation.uri, "mcp.lock");
  const lines = readFileSync(join(dir, "mcp.lock"), "utf8").split("\n");
  assert.equal(lines[location.region.startLine - 1], '        "create_issue": {');

  const rule = runLog.tool.driver.rules.find((r) => r.id === "MK112");
  assert.equal(rule.properties["security-severity"], "9.5");
  assert.ok(rule.properties.tags.includes("owasp-mcp-top-10/MCP03:2025"));

  // The same change keeps the same fingerprint, so code scanning tracks one alert.
  await run(dir, ["verify", "--sarif", sarifPath], { FIXTURE_VARIANT: "rugpull" });
  const again = JSON.parse(readFileSync(sarifPath, "utf8")).runs[0].results.find((r) => r.ruleId === "MK112");
  assert.deepEqual(again.partialFingerprints, poisoned.partialFingerprints);

  // A clean run writes an empty result list rather than nothing.
  await run(dir, ["verify", "--sarif", sarifPath]);
  assert.deepEqual(JSON.parse(readFileSync(sarifPath, "utf8")).runs[0].results, []);
});

test("JSON output carries the stable code and OWASP category of each change and flag", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const json = JSON.parse((await run(dir, ["verify", "--json"], { FIXTURE_VARIANT: "rugpull" })).stdout);
  const change = json.changes.find((c) => c.kind === "tool.description.changed");
  assert.equal(change.rule, "MK112");
  assert.equal(change.owasp, "MCP03:2025");
  const flag = change.flags.find((f) => f.id === "sensitive-paths");
  assert.equal(flag.rule, "MK207");
  assert.equal(flag.owasp, "MCP01:2025");
});
