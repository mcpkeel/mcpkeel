import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseTomlText } from "smol-toml";
import type { ServerSpec, Transport } from "./types.js";

/** Config files mcpkeel looks for, in order, when --config is not given. */
export const DEFAULT_CONFIGS = [
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  "opencode.json",
  "opencode.jsonc",
  ".codex/config.toml",
  ".gemini/settings.json",
];

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
  const raw = readFileSync(path, "utf8");
  const specs = path.endsWith(".toml") ? codexServers(parseToml(raw, path), path) : jsonServers(parseJson(raw, path), path);
  return specs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function parseJson(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      throw new UserError(`${path} is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new UserError(`${path} does not contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

function parseToml(raw: string, path: string): Record<string, unknown> {
  try {
    return parseTomlText(raw) as Record<string, unknown>;
  } catch (err) {
    throw new UserError(`${path} is not valid TOML: ${(err as Error).message.split("\n")[0]}`);
  }
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

/**
 * Claude Code, Claude Desktop, Cursor and Gemini CLI use `mcpServers`; VS Code
 * uses `servers`; opencode uses `mcp`.
 */
function jsonServers(root: Record<string, unknown>, path: string): ServerSpec[] {
  if (root.mcpServers === undefined && root.servers === undefined && root.mcp !== undefined) {
    return opencodeServers(asObject(root.mcp, `"mcp" in ${path}`), path);
  }
  const servers = (root.mcpServers ?? root.servers) as Record<string, unknown> | undefined;
  if (servers === undefined || servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new UserError(`${path} has no "mcpServers", "servers" or "mcp" object.`);
  }
  // Gemini CLI reads `$VAR` as well as `${VAR}`, and its `url` means SSE.
  const gemini = /(^|[\\/])\.gemini[\\/]settings\.json$/.test(path);
  const text = (value: string): string => (gemini ? value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, "${$1}") : value);

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
        command: text(entry.command),
        args: stringArray(entry.args, name, "args").map(text),
        env: mapValues(stringRecord(entry.env, name, "env"), text),
        cwd: typeof entry.cwd === "string" ? text(entry.cwd) : undefined,
      });
    } else if (typeof entry.httpUrl === "string") {
      specs.push({ name, transport: "http", url: text(entry.httpUrl), headers: mapValues(stringRecord(entry.headers, name, "headers"), text) });
    } else if (typeof entry.url === "string") {
      const transport: Transport = type === "sse" || (gemini && type === undefined) ? "sse" : "http";
      specs.push({ name, transport, url: text(entry.url), headers: mapValues(stringRecord(entry.headers, name, "headers"), text) });
    } else {
      throw new UserError(`Server "${name}" in ${path} has neither "command" nor "url".`);
    }
  }
  return specs;
}

/**
 * opencode: `{ "type": "local", "command": ["npx", "-y", "pkg"], "environment": {} }`
 * or `{ "type": "remote", "url": "...", "headers": {} }`, with `{env:VAR}` and
 * `{file:path}` substitution. An unset variable is an error here too, rather
 * than the empty string opencode would use.
 */
function opencodeServers(servers: Record<string, unknown>, path: string): ServerSpec[] {
  const base = dirname(path);
  const text = (value: string): string =>
    value
      .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}")
      .replace(/\{file:([^}]+)\}/g, (_m, file: string) => {
        const target = file.startsWith("~/") ? join(homedir(), file.slice(2)) : isAbsolute(file) ? file : join(base, file);
        try {
          return readFileSync(target, "utf8").trim();
        } catch {
          throw new UserError(`${path} refers to {file:${file}}, which cannot be read.`);
        }
      });

  const specs: ServerSpec[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const entry = asObject(value, `Server "${name}" in ${path}`);
    if (entry.enabled === false) continue;
    if (entry.type === "local") {
      const command = stringArray(entry.command, name, "command").map(text);
      if (command.length === 0) throw new UserError(`Server "${name}" in ${path} has an empty "command".`);
      specs.push({ name, transport: "stdio", command: command[0], args: command.slice(1), env: mapValues(stringRecord(entry.environment, name, "environment"), text) });
    } else if (entry.type === "remote" && typeof entry.url === "string") {
      specs.push({ name, transport: "http", url: text(entry.url), headers: mapValues(stringRecord(entry.headers, name, "headers"), text) });
    } else {
      throw new UserError(`Server "${name}" in ${path} needs "type": "local" with a "command", or "type": "remote" with a "url".`);
    }
  }
  return specs;
}

/**
 * Codex: `[mcp_servers.<name>]` tables in TOML, with `command`, `args`, `env`
 * and `cwd`, or `url` with `http_headers`, `env_http_headers` (header name to
 * variable name) and `bearer_token_env_var`.
 */
function codexServers(root: Record<string, unknown>, path: string): ServerSpec[] {
  if (root.mcp_servers === undefined) throw new UserError(`${path} has no [mcp_servers] tables.`);
  const servers = asObject(root.mcp_servers, `[mcp_servers] in ${path}`);
  const specs: ServerSpec[] = [];
  for (const [name, value] of Object.entries(servers)) {
    const entry = asObject(value, `[mcp_servers.${name}] in ${path}`);
    if (entry.enabled === false) continue;
    if (typeof entry.command === "string") {
      specs.push({
        name,
        transport: "stdio",
        command: entry.command,
        args: stringArray(entry.args, name, "args"),
        env: stringRecord(entry.env, name, "env"),
        cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      });
    } else if (typeof entry.url === "string") {
      const headers = stringRecord(entry.http_headers, name, "http_headers");
      for (const [header, variable] of Object.entries(stringRecord(entry.env_http_headers, name, "env_http_headers"))) headers[header] = `\${${variable}}`;
      if (typeof entry.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${entry.bearer_token_env_var}}`;
      specs.push({ name, transport: "http", url: entry.url, headers });
    } else {
      throw new UserError(`[mcp_servers.${name}] in ${path} has neither "command" nor "url".`);
    }
  }
  return specs;
}

function mapValues(record: Record<string, string>, fn: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));
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
export function lockSource(spec: ServerSpec): { command?: string; args?: string[]; cwd?: string; url?: string } {
  if (spec.transport === "stdio") return { command: spec.command, args: spec.args ?? [], cwd: spec.cwd };
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
