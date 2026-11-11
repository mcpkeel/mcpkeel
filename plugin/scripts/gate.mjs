// PreToolUse hook on MCP tools: a call to a server that no longer matches
// mcp.lock asks the user first, or is denied, as the plugin is configured.
// It reads the state the last check wrote and never touches the network, so
// it adds nothing noticeable to a tool call.
import { options, plainName, projectDir, readState, readStdin, skillName } from "./lib.mjs";

const input = await readStdin();
const server = input.mcp_server?.name ?? /^mcp__(.+?)__/.exec(input.tool_name ?? "")?.[1];
if (!server) process.exit(0);

const state = readState(projectDir(input));
if (state?.untrusted) {
  // A record this user cannot vouch for may have been planted to clear a
  // server, so no MCP call goes through on its word.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Blocked by mcpkeel: its record of this project's MCP servers is not private to this user (${state.path}). Tell the user; deleting that file and starting a new session lets mcpkeel check again.`,
      },
    }),
  );
  process.exit(0);
}
// No lockfile, or a server the lockfile does not cover, such as one from the
// user's own config: not mcpkeel's to decide.
const entry = state?.servers?.[server];
if (!entry) process.exit(0);

const opts = options();
const decision = entry.status === "drifted" ? opts.onDrift : entry.status === "unverified" ? opts.onUnverified : "allow";
if (decision === "allow" || decision === "warn") process.exit(0);

const name = plainName(server);
// An "ask" reason is shown to the user in the prompt; a "deny" reason is shown
// to the model, so it carries only what mcpkeel itself wrote.
const reason =
  decision === "ask"
    ? entry.status === "drifted"
      ? `mcpkeel: ${name} no longer matches mcp.lock (${entry.changes} change${entry.changes === 1 ? "" : "s"}, ${entry.highest}: ${entry.subjects.join("; ")}). Allow only if you have reviewed it; ${skillName("review")} shows the diff.`
      : `mcpkeel could not verify ${name} against mcp.lock this session.`
    : entry.status === "drifted"
      ? `Blocked by mcpkeel: MCP server ${name} no longer matches mcp.lock (${entry.highest}; ${entry.codes.join(", ") || "no code"}). Do not retry. Tell the user, and suggest ${skillName("review")}.`
      : `Blocked by mcpkeel: MCP server ${name} could not be verified against mcp.lock. Do not retry. Tell the user, and suggest ${skillName("verify")}.`;

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }),
);
