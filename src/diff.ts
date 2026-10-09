import { canonicalJson } from "./canonical.js";
import { collectAllText, excerptAround, newFlags, scanText, sentenceLikeName } from "./scan.js";
import type { Change, Flag, Lockfile, PromptEntry, ServerEntry, Severity, ToolEntry } from "./types.js";

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function atLeast(severity: Severity, threshold: Severity): boolean {
  return RANK[severity] <= RANK[threshold];
}

/**
 * Compare what was pinned against what is being served now.
 *
 * Severity follows one idea: the closer a change is to text the model reads as
 * guidance, the worse it is. Descriptions and instructions are high. Anything
 * that newly trips an injection heuristic is critical. Schema shape is medium.
 * Version bumps are low. A changed launch command is high, because it decides
 * what runs on the machine.
 */
export function diffLockfiles(before: Lockfile, after: Lockfile, skip: ReadonlySet<string> = new Set()): Change[] {
  const changes: Change[] = [];
  const names = new Set([...Object.keys(before.servers), ...Object.keys(after.servers)]);
  for (const name of [...names].sort()) {
    if (skip.has(name)) continue;
    const a = before.servers[name];
    const b = after.servers[name];
    if (a && !b) {
      changes.push({
        severity: "medium",
        server: name,
        kind: "server.removed",
        subject: "server",
        message: "is pinned in mcp.lock but no longer in the config",
      });
    } else if (!a && b) {
      const flags = scanServer(b).flatMap((hit) => hit.flags);
      const toolCount = Object.keys(b.tools).length;
      changes.push({
        severity: flags.length ? "critical" : "high",
        server: name,
        kind: "server.added",
        subject: "server",
        message: `is not pinned in mcp.lock (${toolCount} ${toolCount === 1 ? "tool" : "tools"})`,
        flags: flags.length ? dedupeFlags(flags) : undefined,
      });
    } else if (a && b) {
      changes.push(...diffServer(name, a, b));
    }
  }
  applyCrossServer(changes, after);
  return changes.sort((x, y) => (x.server === y.server ? RANK[x.severity] - RANK[y.severity] : x.server < y.server ? -1 : 1));
}

/** The differences between two snapshots of one server, without any cross-server context. */
export function diffEntries(server: string, a: ServerEntry, b: ServerEntry): Change[] {
  return diffServer(server, a, b).sort((x, y) => RANK[x.severity] - RANK[y.severity]);
}

function diffServer(server: string, a: ServerEntry, b: ServerEntry): Change[] {
  const changes: Change[] = [];
  const push = (change: Omit<Change, "server">): void => void changes.push({ server, ...change });

  if ((a.instructions ?? "") !== (b.instructions ?? "")) {
    const flags = newFlags(a.instructions, b.instructions);
    push({
      severity: flags.length ? "critical" : "high",
      kind: "server.instructions.changed",
      subject: "server instructions",
      message: !a.instructions ? "added" : !b.instructions ? "removed" : "changed",
      before: a.instructions,
      after: b.instructions,
      flags: flags.length ? flags : undefined,
    });
  }

  for (const tool of union(a.tools, b.tools)) {
    const ta = a.tools[tool];
    const tb = b.tools[tool];
    const subject = `tool ${tool}`;
    if (ta && !tb) {
      push({ severity: "medium", kind: "tool.removed", subject, message: "removed" });
    } else if (!ta && tb) {
      const flags = scanTool(tb);
      push({
        severity: flags.length ? "critical" : "high",
        kind: "tool.added",
        subject,
        message: "added",
        after: tb.description,
        context: collectAllText(tb.inputSchema) || undefined,
        flags: flags.length ? flags : undefined,
      });
    } else if (ta && tb) {
      for (const change of diffTool(subject, ta, tb)) push(change);
    }
  }

  for (const prompt of union(a.prompts ?? {}, b.prompts ?? {})) {
    const pa = a.prompts?.[prompt];
    const pb = b.prompts?.[prompt];
    const subject = `prompt ${prompt}`;
    if (pa && !pb) {
      push({ severity: "low", kind: "prompt.removed", subject, message: "removed" });
    } else if (!pa && pb) {
      const flags = scanText(promptText(pb));
      push({
        severity: flags.length ? "critical" : "medium",
        kind: "prompt.added",
        subject,
        message: "added",
        after: pb.description,
        flags: flags.length ? flags : undefined,
      });
    } else if (pa && pb && canonicalJson(strip(pa)) !== canonicalJson(strip(pb))) {
      const flags = newFlags(promptText(pa), promptText(pb));
      push({
        severity: flags.length ? "critical" : "medium",
        kind: "prompt.changed",
        subject,
        message: "changed",
        before: pa.description,
        after: pb.description,
        flags: flags.length ? flags : undefined,
      });
    }
  }

  const versionA = a.serverInfo?.version;
  const versionB = b.serverInfo?.version;
  if (versionA !== versionB || a.serverInfo?.name !== b.serverInfo?.name) {
    push({
      severity: "low",
      kind: "server.version.changed",
      subject: "server version",
      message: `${describeInfo(a)} → ${describeInfo(b)}`,
    });
  }
  if (a.transport !== b.transport || canonicalJson(a.source) !== canonicalJson(b.source)) {
    // Approval has to follow the content, not the name: a server that keeps its
    // name but starts a different program is a different server.
    const programChanged =
      a.transport !== b.transport || a.source.command !== b.source.command || origin(a.source.url) !== origin(b.source.url);
    push({
      severity: programChanged ? "high" : "medium",
      kind: "server.source.changed",
      subject: "launch config",
      message: programChanged ? "now starts a different program or host" : b.source.url ? "address changed" : "arguments changed",
      before: describeSource(a),
      after: describeSource(b),
    });
  }
  return changes;
}

function origin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(url);
  return match ? match[0].toLowerCase() : url;
}

function diffTool(subject: string, a: ToolEntry, b: ToolEntry): Omit<Change, "server">[] {
  const changes: Omit<Change, "server">[] = [];

  if ((a.description ?? "") !== (b.description ?? "")) {
    const flags = newFlags(a.description, b.description);
    changes.push({
      severity: flags.length ? "critical" : "high",
      kind: "tool.description.changed",
      subject,
      message: "description changed",
      before: a.description,
      after: b.description,
      flags: flags.length ? flags : undefined,
    });
  }
  if ((a.title ?? "") !== (b.title ?? "")) {
    changes.push({ severity: "medium", kind: "tool.title.changed", subject, message: "title changed", before: a.title, after: b.title });
  }

  changes.push(...diffSchema(subject, a.inputSchema, b.inputSchema));

  if (canonicalJson(a.annotations ?? {}) !== canonicalJson(b.annotations ?? {})) {
    const wasReadOnly = a.annotations?.readOnlyHint === true;
    const isReadOnly = b.annotations?.readOnlyHint === true;
    const becameDestructive = a.annotations?.destructiveHint === false && b.annotations?.destructiveHint !== false;
    const loosened = (wasReadOnly && !isReadOnly) || becameDestructive;
    changes.push({
      severity: loosened ? "high" : "medium",
      kind: "tool.annotations.changed",
      subject,
      message: wasReadOnly && !isReadOnly ? "no longer marked read-only" : becameDestructive ? "no longer marked non-destructive" : "annotations changed",
      before: canonicalJson(a.annotations ?? {}),
      after: canonicalJson(b.annotations ?? {}),
    });
  }
  if (canonicalJson(a.outputSchema ?? null) !== canonicalJson(b.outputSchema ?? null)) {
    changes.push({ severity: "low", kind: "tool.outputSchema.changed", subject, message: "output schema changed" });
  }
  return changes;
}

function diffSchema(subject: string, a: unknown, b: unknown): Omit<Change, "server">[] {
  if (canonicalJson(a ?? null) === canonicalJson(b ?? null)) return [];
  const changes: Omit<Change, "server">[] = [];
  const propsA = properties(a);
  const propsB = properties(b);
  const requiredA = required(a);
  const requiredB = required(b);

  for (const name of union(propsA, propsB)) {
    const pa = propsA[name];
    const pb = propsB[name];
    const param = `parameter "${name}"`;
    if (pa !== undefined && pb === undefined) {
      changes.push({ severity: "medium", kind: "tool.param.removed", subject, message: `${param} removed` });
    } else if (pa === undefined && pb !== undefined) {
      const flags = scanParam(name, pb);
      const isRequired = requiredB.has(name);
      changes.push({
        severity: flags.length ? "critical" : isRequired ? "high" : "medium",
        kind: "tool.param.added",
        subject,
        message: `${isRequired ? "required" : "optional"} ${param} added`,
        after: docs(pb) || undefined,
        flags: flags.length ? flags : undefined,
      });
    } else {
      const flags = newFlags(collectAllText(pa), collectAllText(pb));
      const emitted: Omit<Change, "server">[] = [];
      if (docs(pa) !== docs(pb)) {
        emitted.push({
          severity: "high",
          kind: "tool.param.description.changed",
          subject,
          message: `${param} description changed`,
          before: docs(pa) || undefined,
          after: docs(pb) || undefined,
        });
      }
      if (canonicalJson(stripDocs(pa)) !== canonicalJson(stripDocs(pb))) {
        emitted.push({
          severity: "medium",
          kind: "tool.param.schema.changed",
          subject,
          message: `${param} type or constraints changed`,
          before: canonicalJson(stripDocs(pa)),
          after: canonicalJson(stripDocs(pb)),
        });
      }
      if (emitted[0] && flags.length) {
        emitted[0].severity = "critical";
        emitted[0].flags = flags;
      }
      changes.push(...emitted);
      if (requiredA.has(name) !== requiredB.has(name)) {
        changes.push({
          severity: requiredB.has(name) ? "medium" : "low",
          kind: "tool.param.required.changed",
          subject,
          message: `${param} is now ${requiredB.has(name) ? "required" : "optional"}`,
        });
      }
    }
  }

  if (changes.length === 0) {
    // Something outside `properties` moved: a top-level description, $defs, additionalProperties.
    const flags = newFlags(collectAllText(a), collectAllText(b));
    changes.push({
      severity: flags.length ? "critical" : "medium",
      kind: "tool.inputSchema.changed",
      subject,
      message: "input schema changed",
      flags: flags.length ? flags : undefined,
    });
  }
  return changes;
}

/* ------------------------------------------------------------ cross-server */

const TEXTUAL = new Set([
  "server.instructions.changed",
  "tool.added",
  "tool.description.changed",
  "tool.param.added",
  "tool.param.description.changed",
  "prompt.added",
  "prompt.changed",
]);

/** Which servers expose each tool name. */
function toolOwners(lock: Lockfile): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [server, entry] of Object.entries(lock.servers)) {
    for (const tool of Object.keys(entry.tools)) owners.set(tool, [...(owners.get(tool) ?? []), server]);
  }
  return owners;
}

/** Names specific enough that seeing one in prose means the tool, not the English word. */
function distinctive(name: string): boolean {
  return name.length >= 6 && (/[_\-.]/.test(name) || /[a-z][A-Z]/.test(name));
}

function mentionIndex(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`).exec(text);
  return match ? match.index : -1;
}

/**
 * Checks that need more than one server in view.
 *
 * A low-trust server cannot touch another server's definitions, but it can talk
 * about them: "before calling send_email, also..." steers a tool it does not
 * own. And a tool that arrives with the same name as one on another server may
 * be called in its place.
 */
function applyCrossServer(changes: Change[], after: Lockfile): void {
  const owners = toolOwners(after);
  for (const change of changes) {
    if (change.kind === "tool.added") {
      const name = change.subject.replace(/^tool /, "");
      const others = (owners.get(name) ?? []).filter((server) => server !== change.server);
      if (others.length) change.message = `added, with the same name as a tool on ${others.map((s) => `"${s}"`).join(" and ")}`;
    }
    if (!TEXTUAL.has(change.kind)) continue;
    const text = [change.after, change.context].filter(Boolean).join("\n");
    if (!text) continue;
    const found: Flag[] = [];
    for (const [tool, servers] of owners) {
      if (servers.includes(change.server) || !distinctive(tool)) continue;
      const index = mentionIndex(text, tool);
      if (index === -1 || mentionIndex(change.before ?? "", tool) !== -1) continue;
      found.push({
        id: "cross-server-reference",
        label: `refers to ${tool}, a tool on "${servers[0]}"`,
        excerpt: excerptAround(text, index, tool.length),
      });
      break;
    }
    if (found.length) {
      change.flags = [...(change.flags ?? []), ...found];
      change.severity = "critical";
    }
  }
}

/** The same two checks over a whole lockfile, for init, when there is nothing to diff against. */
export function crossServerNotes(lock: Lockfile): { server: string; subject: string; message: string }[] {
  const notes: { server: string; subject: string; message: string }[] = [];
  const owners = toolOwners(lock);
  for (const [tool, servers] of owners) {
    if (servers.length > 1) {
      notes.push({
        server: servers[0]!,
        subject: `tool ${tool}`,
        message: `the same tool name is also exposed by ${servers.slice(1).map((s) => `"${s}"`).join(" and ")}, so an agent may call either`,
      });
    }
  }
  for (const [server, entry] of Object.entries(lock.servers)) {
    const texts: [string, string][] = [["server instructions", entry.instructions ?? ""]];
    for (const [name, tool] of Object.entries(entry.tools)) texts.push([`tool ${name}`, `${tool.description ?? ""}\n${collectAllText(tool.inputSchema)}`]);
    for (const [subject, text] of texts) {
      for (const [tool, servers] of owners) {
        if (servers.includes(server) || !distinctive(tool)) continue;
        const index = mentionIndex(text, tool);
        if (index === -1) continue;
        notes.push({ server, subject, message: `refers to ${tool}, a tool on "${servers[0]}": "${excerptAround(text, index, tool.length)}"` });
        break;
      }
    }
  }
  return notes;
}

/** Heuristic hits across everything a server exposes. Used at init, when there is no baseline to diff against. */
export function scanServer(entry: ServerEntry): { subject: string; flags: Flag[] }[] {
  const hits: { subject: string; flags: Flag[] }[] = [];
  const add = (subject: string, flags: Flag[]): void => {
    if (flags.length) hits.push({ subject, flags });
  };
  add("server instructions", scanText(entry.instructions));
  for (const [name, tool] of Object.entries(entry.tools)) add(`tool ${name}`, scanTool(tool));
  for (const [name, prompt] of Object.entries(entry.prompts ?? {})) add(`prompt ${name}`, scanText(promptText(prompt)));
  return hits;
}

function scanTool(tool: ToolEntry): Flag[] {
  const flags = [...scanText(tool.description), ...scanText(collectAllText(tool.inputSchema))];
  for (const name of Object.keys(properties(tool.inputSchema))) flags.push(...nameFlags(name));
  return dedupeFlags(flags);
}

/** Everything a model reads about one parameter: its name, and every key and string under it. */
function scanParam(name: string, schema: unknown): Flag[] {
  return dedupeFlags([...scanText(`${name}\n${collectAllText(schema)}`), ...nameFlags(name)]);
}

function nameFlags(name: string): Flag[] {
  return sentenceLikeName(name)
    ? [{ id: "sentence-like-name", label: "parameter name reads like a sentence", excerpt: name.slice(0, 80) }]
    : [];
}

function dedupeFlags(flags: Flag[]): Flag[] {
  const seen = new Set<string>();
  return flags.filter((flag) => (seen.has(flag.id) ? false : (seen.add(flag.id), true)));
}

function promptText(prompt: PromptEntry): string {
  return [prompt.description ?? "", collectAllText(prompt.arguments)].join("\n");
}

function strip<T extends { integrity: string }>(entry: T): Omit<T, "integrity"> {
  const { integrity: _ignored, ...rest } = entry;
  return rest;
}

function union(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}

function properties(schema: unknown): Record<string, unknown> {
  const props = (schema as { properties?: unknown } | null | undefined)?.properties;
  return props !== null && typeof props === "object" && !Array.isArray(props) ? (props as Record<string, unknown>) : {};
}

function required(schema: unknown): Set<string> {
  const list = (schema as { required?: unknown } | null | undefined)?.required;
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
}

const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

/** The human-readable text of a schema node: every description and title, at any depth. */
function docs(node: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown, namesOnly: boolean): void => {
    if (Array.isArray(value)) return value.forEach((v) => walk(v, false));
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!namesOnly && (key === "description" || key === "title") && typeof child === "string") parts.push(child);
      else walk(child, !namesOnly && NAME_MAPS.has(key));
    }
  };
  walk(node, false);
  return parts.join("\n");
}

/** The same schema with descriptions and titles removed, so shape can be compared on its own. */
function stripDocs(node: unknown, namesOnly = false): unknown {
  if (Array.isArray(node)) return node.map((v) => stripDocs(v));
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (!namesOnly && (key === "description" || key === "title") && typeof child === "string") continue;
    out[key] = stripDocs(child, !namesOnly && NAME_MAPS.has(key));
  }
  return out;
}

function describeInfo(entry: ServerEntry): string {
  const { name, version } = entry.serverInfo ?? {};
  return name || version ? `${name ?? "?"}@${version ?? "?"}` : "unknown";
}

function describeSource(entry: ServerEntry): string {
  if (entry.source.url) return `${entry.transport} ${entry.source.url}`;
  return [entry.source.command, ...(entry.source.args ?? [])].join(" ");
}
