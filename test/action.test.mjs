// The GitHub Action is a shell script, so it is tested by running it: against a
// local build of mcpkeel, a bare git repository standing in for GitHub, and a
// stand-in `gh` that records what it was asked to do.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CLI = join(root, "dist", "cli.js");
const SCRIPT = join(root, "action", "run.sh");
const FIXTURE = join(here, "fixtures", "server.mjs");
const skip = process.platform === "win32" ? "the action runs on bash" : false;

const FAKE_GH = `#!/usr/bin/env bash
echo "token=\${GH_TOKEN:+set} $*" >>"$GH_FAKE_LOG"
keep_body() { while [ $# -gt 0 ]; do if [ "$1" = "--body-file" ]; then cp "$2" "$GH_FAKE_LOG.body"; fi; shift; done; }
case "$1 $2" in
  "pr list") if [ -f "$GH_FAKE_LOG.open" ]; then echo 7; fi ;;
  "pr create") keep_body "$@"; touch "$GH_FAKE_LOG.open"; echo "https://github.com/acme/app/pull/7" ;;
  "pr edit") keep_body "$@" ;;
  "pr view") echo "https://github.com/acme/app/pull/7" ;;
esac
`;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A repository with a committed MCP config and lockfile, and a remote to push to. */
function workspace() {
  const base = mkdtempSync(join(tmpdir(), "mcpkeel-action-"));
  const remote = join(base, "remote.git");
  const work = join(base, "work");
  const bin = join(base, "bin");
  mkdirSync(work);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);

  git(base, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "config", "user.name", "Test");
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "origin", remote);
  writeFileSync(
    join(work, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        github: {
          command: process.execPath,
          args: [FIXTURE],
          env: { FIXTURE_VARIANT: "${FIXTURE_VARIANT:-v1}", FIXTURE_ENV_DUMP: join(base, "server-env.json") },
        },
      },
    }),
  );
  execFileSync(process.execPath, [CLI, "init"], { cwd: work, env: { ...process.env, FIXTURE_VARIANT: "v1" } });
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "Pin MCP servers");
  git(work, "push", "--quiet", "origin", "main");
  return { base, remote, work, bin, log: join(base, "gh.log"), output: join(base, "output"), summary: join(base, "summary.md") };
}

function action(ws, env) {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [SCRIPT],
      {
        cwd: ws.work,
        env: {
          ...process.env,
          PATH: `${ws.bin}${delimiter}${process.env.PATH}`,
          NO_COLOR: "1",
          MCPKEEL_BIN: CLI,
          GH_FAKE_LOG: ws.log,
          GITHUB_OUTPUT: ws.output,
          GITHUB_STEP_SUMMARY: ws.summary,
          GITHUB_REF_NAME: "main",
          GITHUB_SERVER_URL: "https://github.com",
          MCPKEEL_GITHUB_TOKEN: "ghs_test_token",
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

test("verify mode passes the exit code through and writes the job summary", { skip }, async () => {
  const ws = workspace();
  const clean = await action(ws, { MCPKEEL_MODE: "verify" });
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(read(ws.output), /drift=false/);
  assert.match(read(ws.summary), /## mcpkeel: no drift/);

  const drift = await action(ws, { MCPKEEL_MODE: "verify", FIXTURE_VARIANT: "rugpull" });
  assert.equal(drift.code, 1);
  assert.match(read(ws.output), /drift=true/);
  assert.match(read(ws.summary), /## mcpkeel: 2 changes \(1 critical, 1 low\)/);

  // --fail-on is honoured.
  const lenient = await action(ws, { MCPKEEL_MODE: "verify", FIXTURE_VARIANT: "benign", MCPKEEL_FAIL_ON: "critical" });
  assert.equal(lenient.code, 0);
});

test("update-pr mode does nothing when no server has changed", { skip }, async () => {
  const ws = workspace();
  const result = await action(ws, { MCPKEEL_MODE: "update-pr" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(ws.output), /drift=false/);
  assert.equal(read(ws.log), "");
  assert.equal(git(ws.remote, "branch", "--list", "mcpkeel/update-lock"), "");
});

test("update-pr mode pushes the new lockfile to a branch and opens a pull request", { skip }, async () => {
  const ws = workspace();
  const before = read(join(ws.work, "mcp.lock"));
  const result = await action(ws, { MCPKEEL_MODE: "update-pr", FIXTURE_VARIANT: "benign" });
  assert.equal(result.code, 0, result.stderr + result.stdout);

  // The branch on the remote holds exactly one new commit, touching only the lockfile.
  assert.equal(git(ws.remote, "log", "--format=%s", "main..mcpkeel/update-lock"), "Update mcp.lock: 6 changes (3 high, 2 medium, 1 low)");
  assert.equal(git(ws.remote, "diff", "--name-only", "main", "mcpkeel/update-lock"), "mcp.lock");
  assert.notEqual(git(ws.remote, "show", "mcpkeel/update-lock:mcp.lock"), before.trim());
  assert.equal(git(ws.remote, "show", "main:mcp.lock"), before.trim());

  // The pull request was opened with the report as its body.
  const log = read(ws.log);
  assert.match(log, /token=set pr list --head mcpkeel\/update-lock --base main/);
  assert.match(log, /token=set pr create --head mcpkeel\/update-lock --base main --title Update mcp\.lock: 6 changes/);
  const body = read(`${ws.log}.body`);
  assert.match(body, /^## mcpkeel: 6 changes \(3 high, 2 medium, 1 low\)/);
  assert.match(body, /- \*\*HIGH\*\* `tool create_issue` description changed/);
  assert.match(body, /Merging this pull request accepts these definitions/);
  assert.match(read(ws.output), /drift=true/);
  assert.match(read(ws.output), /pull-request=https:\/\/github\.com\/acme\/app\/pull\/7/);

  // The token is not left behind in the repository's git config.
  assert.ok(!git(ws.work, "config", "--list").includes("ghs_test_token"));
});

test("update-pr mode updates the pull request that is already open", { skip }, async () => {
  const ws = workspace();
  await action(ws, { MCPKEEL_MODE: "update-pr", FIXTURE_VARIANT: "benign" });
  git(ws.work, "checkout", "--quiet", "main");
  const again = await action(ws, { MCPKEEL_MODE: "update-pr", FIXTURE_VARIANT: "rugpull" });
  assert.equal(again.code, 0, again.stderr + again.stdout);
  assert.match(read(ws.log), /pr edit 7 --title Update mcp\.lock: 2 changes \(1 critical, 1 low\)/);
  assert.equal(read(ws.log).match(/pr create/g).length, 1);
  assert.match(read(`${ws.log}.body`), /\*\*CRITICAL\*\*/);
  assert.equal(git(ws.remote, "log", "--format=%s", "main..mcpkeel/update-lock"), "Update mcp.lock: 2 changes (1 critical, 1 low)");
});

test("the action's secrets are not handed to the MCP servers it starts", { skip }, async () => {
  const ws = workspace();
  const result = await action(ws, { MCPKEEL_MODE: "verify", MCPKEEL_EXPLAIN: "true", MCPKEEL_ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.equal(result.code, 0, result.stderr);
  const names = JSON.parse(read(join(ws.base, "server-env.json")));
  assert.ok(names.includes("FIXTURE_VARIANT"), "the dump is from the server process");
  assert.ok(!names.includes("MCPKEEL_GITHUB_TOKEN"), "GitHub token reached a server");
  assert.ok(!names.includes("MCPKEEL_ANTHROPIC_API_KEY"), "API key input reached a server");
  // mcpkeel itself is given the key for --explain, and does not pass it on either.
  assert.ok(!names.includes("ANTHROPIC_API_KEY"), "API key reached a server");
});

test("update-pr mode refuses to run without a lockfile or a token", { skip }, async () => {
  const ws = workspace();
  const noToken = await action(ws, { MCPKEEL_MODE: "update-pr", MCPKEEL_GITHUB_TOKEN: "" });
  assert.equal(noToken.code, 2);
  assert.match(noToken.stdout, /::error::update-pr needs github-token/);
  const noLock = await action(ws, { MCPKEEL_MODE: "update-pr", MCPKEEL_LOCKFILE: "missing.lock" });
  assert.equal(noLock.code, 2);
  assert.match(noLock.stdout, /::error::No lockfile at missing\.lock/);
  assert.equal((await action(ws, { MCPKEEL_MODE: "deploy" })).code, 2);
});

test("action.yml runs the same mcpkeel version as package.json", () => {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(readFileSync(join(root, "action.yml"), "utf8"), new RegExp(`default: "${version.replace(/\./g, "\\.")}"`));
});
