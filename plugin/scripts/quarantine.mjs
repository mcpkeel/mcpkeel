// Quarantine for servers that drifted: Claude Code does not start a server
// that `disabledMcpjsonServers` names, so a drifted server listed there never
// reaches the agent, its tool descriptions included. Claude Code reads the
// setting when a session starts, so it takes effect from the next session;
// in the current one the gate denies the calls.
//
// Only servers from the project's .mcp.json can be listed there. mcpkeel adds
// and removes only the names it put there itself, recorded in its state.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS = join(".claude", "settings.local.json");

/** Names of the servers in the project's .mcp.json, the only ones the setting covers. */
function projectServers(project) {
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers ?? {}));
  } catch {
    return new Set();
  }
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${SETTINGS} is a symbolic link`);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${SETTINGS} is not a JSON object`);
  return settings;
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(settings, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/**
 * Brings the project's quarantine list in line with the check.
 *   drifted:  names of servers that no longer match mcp.lock
 *   previous: names mcpkeel quarantined before
 *   enabled:  whether quarantine is the configured response to drift
 * Returns the names now quarantined by mcpkeel, the ones added and lifted,
 * the drifted servers the setting cannot cover, and an error when the
 * settings file could not be read or written; on an error the file is left
 * as it was and the previous list is kept.
 */
export function syncQuarantine(project, { drifted, previous, enabled }) {
  const path = join(project, SETTINGS);
  const inConfig = projectServers(project);
  const wanted = new Set(enabled ? drifted.filter((name) => inConfig.has(name)) : []);
  // Drifted servers from other configs, which the setting cannot reach.
  const uncovered = enabled ? drifted.filter((name) => !inConfig.has(name)).sort() : [];
  try {
    const settings = readSettings(path);
    if (settings.disabledMcpjsonServers !== undefined && !Array.isArray(settings.disabledMcpjsonServers)) {
      throw new Error("its disabledMcpjsonServers is not a list");
    }
    const listed = settings.disabledMcpjsonServers ?? [];
    const ours = new Set(previous.filter((name) => listed.includes(name)));
    // A name the user listed themselves stays theirs: never claimed, never lifted.
    const added = [...wanted].filter((name) => !listed.includes(name));
    const lifted = [...ours].filter((name) => !wanted.has(name));
    const quarantined = [...new Set([...[...ours].filter((name) => wanted.has(name)), ...added])].sort();
    if (added.length || lifted.length) {
      const next = [...listed.filter((name) => !lifted.includes(name)), ...added];
      if (next.length) settings.disabledMcpjsonServers = next;
      else delete settings.disabledMcpjsonServers;
      writeSettings(path, settings);
    }
    return { quarantined, added: added.sort(), lifted: lifted.sort(), uncovered };
  } catch (err) {
    return { quarantined: previous, added: [], lifted: [], uncovered, error: `could not update ${SETTINGS}: ${err.message}` };
  }
}
