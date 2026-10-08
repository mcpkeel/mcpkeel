import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

test("--explain sends only the changed definitions to the Claude API and prints the verdict", async (t) => {
  let received;
  const api = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        content: [{ type: "text", text: 'Here you go:\n[{"index":0,"risk":"malicious","reason":"Tells the agent to read an SSH private key and hide it from the user."}]' }],
      }),
    );
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const dir = project();
  await run(dir, ["init"]);
  const env = { FIXTURE_VARIANT: "rugpull", ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}` };
  const result = await run(dir, ["diff", "--explain"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Claude: malicious\. Tells the agent to read an SSH private key/);

  assert.equal(received.url, "/v1/messages");
  assert.equal(received.headers["x-api-key"], "sk-test");
  assert.equal(received.headers["anthropic-version"], "2023-06-01");
  assert.equal(received.body.model, "claude-sonnet-5-5");
  const sent = received.body.messages[0].content;
  assert.match(sent, /create_issue/);
  // The version bump has no text to review, so only one change is sent.
  assert.equal(JSON.parse(sent.replace(/<\/?changes>/g, "")).length, 1);
});

test("--explain without a key explains how to get one", async () => {
  const dir = project();
  await run(dir, ["init"]);
  const result = await run(dir, ["diff", "--explain"], { FIXTURE_VARIANT: "rugpull", ANTHROPIC_API_KEY: "" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ANTHROPIC_API_KEY/);
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
