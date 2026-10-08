import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ServerSpec, Transport } from "./types.js";

/** Config files mcpkeel looks for, in order, when --config is not given. */
export const DEFAULT_CONFIGS = [".mcp.json", "mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"];

export class UserError extends Error {}

export function findConfig(cwd: string, explicit?: string): string {
  if (explicit) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new UserError(`Config file not found: ${explicit}`);
    return path;
  }
  for (const candidate of DEFAULT_CONFIGS) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) return path;
  }
  throw new UserError(
    `No MCP config found. Looked for ${DEFAULT_CONFIGS.join(", ")} in ${cwd}.\n` +
      `Point mcpkeel at one with --config <path>.`,
  );
}

export function loadConfig(path: string): ServerSpec[] {
  let parsed: unknown;
  const raw = readFileSync(path, "utf8");
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      throw new UserError(`${path} is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (parsed === null || typeof parsed !== "object") throw new UserError(`${path} does not contain a JSON object.`);
  const root = parsed as Record<string, unknown>;
  // Claude Code, Claude Desktop and Cursor use `mcpServers`; VS Code uses `servers`.
  const servers = (root.mcpServers ?? root.servers) as Record<string, unknown> | undefined;
  if (servers === undefined || servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new UserError(`${path} has no "mcpServers" (or "servers") object.`);
  }

  const specs: ServerSpec[] = [];
  for (const [name, value] of Object.entries(servers)) {
    if (value === null || typeof value !== "object") throw new UserError(`Server "${name}" in ${path} is not an object.`);
    const entry = value as Record<string, unknown>;
    if (entry.disabled === true) continue;
    const type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;

    if (typeof entry.command === "string") {
      specs.push({
        name,
        transport: "stdio",
        command: entry.command,
        args: stringArray(entry.args, name, "args"),
        env: stringRecord(entry.env, name, "env"),
      });
    } else if (typeof entry.url === "string") {
      const transport: Transport = type === "sse" ? "sse" : "http";
      specs.push({ name, transport, url: entry.url, headers: stringRecord(entry.headers, name, "headers") });
    } else {
      throw new UserError(`Server "${name}" in ${path} has neither "command" nor "url".`);
    }
  }
  return specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function stringArray(value: unknown, server: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new UserError(`Server "${server}": "${field}" must be an array.`);
  return value.map((v) => String(v));
}

function stringRecord(value: unknown, server: string, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`Server "${server}": "${field}" must be an object.`);
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/**
 * Expand ${VAR}, ${VAR:-default} and VS Code's ${env:VAR}. A reference to an
 * unset variable with no default is an error rather than an empty string, so a
 * missing token fails loudly instead of launching a half-configured server.
 */
export function expandEnv(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback;
    throw new UserError(`environment variable ${name} is not set`);
  });
}

/** What goes in the lockfile for a server: no env values, no headers, no URL credentials. */
export function lockSource(spec: ServerSpec): { command?: string; args?: string[]; url?: string } {
  if (spec.transport === "stdio") return { command: spec.command, args: spec.args ?? [] };
  return { url: redactUrl(spec.url ?? "") };
}

export function redactUrl(url: string): string {
  // Keep ${VAR} references readable; only parse when the URL is literal.
  const withoutQuery = url.replace(/[?#].*$/, "");
  return withoutQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

/** Remove // and block comments and trailing commas, leaving string contents alone. */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
