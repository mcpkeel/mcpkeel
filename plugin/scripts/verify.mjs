// /mcpkeel:verify: check again now, refresh what the gate reads, and print a
// summary made of names, grades and codes only.
import { runCheck, summarize } from "./check.mjs";
import { options, plainName, projectDir, skillName } from "./lib.mjs";

const project = projectDir();
const state = runCheck(project, process.env.CLAUDE_SESSION_ID);
const opts = options();

if (state.error) {
  console.log(`mcpkeel could not verify the MCP servers: ${state.error}`);
  process.exit(0);
}
if (!state.lockfile) {
  console.log("This project has no mcp.lock, so there is nothing to verify. `npx mcpkeel init` creates one from the project's MCP config.");
  process.exit(0);
}

const { drifted, unverified, ok } = summarize(state);
for (const [name, s] of drifted) console.log(`CHANGED     ${plainName(name)}: ${s.changes} change(s), highest ${s.highest}, codes ${s.codes.join(", ")}`);
for (const [name] of unverified) console.log(`UNVERIFIED  ${plainName(name)}: the check could not finish`);
for (const [name] of ok) console.log(`OK          ${plainName(name)}`);
console.log("");
if (drifted.length) {
  console.log(`Calls to changed servers: ${opts.onDrift === "ask" ? "ask first" : opts.onDrift === "deny" ? "blocked" : "not gated"}. ${skillName("review")} shows what changed.`);
} else if (!unverified.length) {
  console.log("Every server matches mcp.lock.");
}
