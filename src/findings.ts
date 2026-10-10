import { createHash } from "node:crypto";
import { visible } from "./scan.js";
import type { Change, Flag, Severity } from "./types.js";

/**
 * Stable codes for everything mcpkeel reports. A code never changes meaning
 * and is never reused, so a policy, a dashboard or a code-scanning alert can
 * refer to it across versions. MK1xx are kinds of change; MK2xx are the
 * built-in checks on what new text says.
 *
 * `owasp` is the closest category of the OWASP MCP Top 10 (2025, beta), for
 * teams that file findings against it. Removals map to none.
 */
export interface RuleInfo {
  code: string;
  name: string;
  summary: string;
  owasp?: OwaspCategory;
}

export type OwaspCategory = "MCP01:2025" | "MCP02:2025" | "MCP03:2025" | "MCP04:2025" | "MCP06:2025" | "MCP09:2025" | "MCP10:2025";

export const OWASP_TITLES: Record<OwaspCategory, string> = {
  "MCP01:2025": "Token Mismanagement & Secret Exposure",
  "MCP02:2025": "Privilege Escalation via Scope Creep",
  "MCP03:2025": "Tool Poisoning",
  "MCP04:2025": "Software Supply Chain Attacks & Dependency Tampering",
  "MCP06:2025": "Prompt Injection via Contextual Payloads",
  "MCP09:2025": "Shadow MCP Servers",
  "MCP10:2025": "Context Injection & Over-Sharing",
};

const KINDS: Record<string, RuleInfo> = {
  "server.added": { code: "MK101", name: "ServerNotPinned", summary: "A server is in the config but not in the lockfile.", owasp: "MCP09:2025" },
  "server.removed": { code: "MK102", name: "ServerRemoved", summary: "A pinned server is no longer in the config." },
  "server.instructions.changed": { code: "MK103", name: "ServerInstructionsChanged", summary: "The server's instructions changed.", owasp: "MCP03:2025" },
  "server.source.changed": { code: "MK104", name: "LaunchCommandChanged", summary: "The command or address that starts the server changed.", owasp: "MCP04:2025" },
  "server.version.changed": { code: "MK105", name: "ServerVersionChanged", summary: "The version the server reports changed.", owasp: "MCP04:2025" },
  "server.package.changed": { code: "MK106", name: "PackageReleaseChanged", summary: "The launcher runs a different release of its package.", owasp: "MCP04:2025" },
  "server.package.tampered": { code: "MK107", name: "PackageContentsChanged", summary: "A published release now has different contents.", owasp: "MCP04:2025" },
  "tool.added": { code: "MK110", name: "ToolAdded", summary: "A tool was added.", owasp: "MCP02:2025" },
  "tool.removed": { code: "MK111", name: "ToolRemoved", summary: "A tool was removed." },
  "tool.description.changed": { code: "MK112", name: "ToolDescriptionChanged", summary: "A tool's description changed.", owasp: "MCP03:2025" },
  "tool.title.changed": { code: "MK113", name: "ToolTitleChanged", summary: "A tool's title changed.", owasp: "MCP03:2025" },
  "tool.annotations.changed": { code: "MK114", name: "ToolAnnotationsChanged", summary: "A tool's annotations changed, such as no longer being read-only.", owasp: "MCP02:2025" },
  "tool.inputSchema.changed": { code: "MK115", name: "ToolInputSchemaChanged", summary: "A tool's input schema changed.", owasp: "MCP03:2025" },
  "tool.outputSchema.changed": { code: "MK116", name: "ToolOutputSchemaChanged", summary: "A tool's output schema changed.", owasp: "MCP03:2025" },
  "tool.param.added": { code: "MK117", name: "ParameterAdded", summary: "A parameter was added.", owasp: "MCP02:2025" },
  "tool.param.removed": { code: "MK118", name: "ParameterRemoved", summary: "A parameter was removed." },
  "tool.param.description.changed": { code: "MK119", name: "ParameterDescriptionChanged", summary: "A parameter's description changed.", owasp: "MCP03:2025" },
  "tool.param.required.changed": { code: "MK120", name: "ParameterRequirementChanged", summary: "Whether a parameter is required changed.", owasp: "MCP03:2025" },
  "tool.param.schema.changed": { code: "MK121", name: "ParameterSchemaChanged", summary: "A parameter's type or constraints changed.", owasp: "MCP03:2025" },
  "tool.text.flagged": { code: "MK122", name: "ToolTextFlaggedAcrossFields", summary: "A tool's fields read together match an attack pattern.", owasp: "MCP03:2025" },
  "prompt.added": { code: "MK130", name: "PromptAdded", summary: "A prompt was added.", owasp: "MCP06:2025" },
  "prompt.changed": { code: "MK131", name: "PromptChanged", summary: "A prompt changed.", owasp: "MCP06:2025" },
  "prompt.removed": { code: "MK132", name: "PromptRemoved", summary: "A prompt was removed." },
  "probe.session": { code: "MK140", name: "ChangesWithinSession", summary: "The server changed its definitions partway through a session.", owasp: "MCP03:2025" },
  "probe.identity": { code: "MK141", name: "AnswersDependOnClient", summary: "The server answers differently under another client name.", owasp: "MCP03:2025" },
};

const FLAGS: Record<string, RuleInfo> = {
  "invisible-characters": { code: "MK201", name: "InvisibleCharacters", summary: "Invisible, control or bidirectional characters.", owasp: "MCP06:2025" },
  "mixed-alphabets": { code: "MK202", name: "MixedAlphabets", summary: "A word mixes letters from different alphabets.", owasp: "MCP06:2025" },
  "instruction-markup": { code: "MK203", name: "InstructionMarkup", summary: "Instruction-like markup.", owasp: "MCP06:2025" },
  "encoded-content": { code: "MK204", name: "EncodedContent", summary: "Encoded text a model can decode.", owasp: "MCP06:2025" },
  "override-instructions": { code: "MK205", name: "OverrideInstructions", summary: "Tells the model to disregard other instructions.", owasp: "MCP06:2025" },
  "conceal-from-user": { code: "MK206", name: "ConcealFromUser", summary: "Tells the model to hide something from the user.", owasp: "MCP06:2025" },
  "sensitive-paths": { code: "MK207", name: "SensitivePaths", summary: "References credentials or secret files.", owasp: "MCP01:2025" },
  "cross-tool-steering": { code: "MK208", name: "CrossToolSteering", summary: "Tries to change how other tools are used.", owasp: "MCP03:2025" },
  exfiltration: { code: "MK209", name: "Exfiltration", summary: "Asks for data to be sent or passed along.", owasp: "MCP10:2025" },
  "conversation-harvest": { code: "MK210", name: "ConversationHarvest", summary: "Asks for the conversation or the system prompt to be passed in.", owasp: "MCP10:2025" },
  "secret-harvest": { code: "MK211", name: "SecretHarvest", summary: "Asks for keys, passwords or tokens the user has shared.", owasp: "MCP01:2025" },
  "sentence-like-name": { code: "MK212", name: "SentenceLikeName", summary: "A parameter name reads like a sentence.", owasp: "MCP03:2025" },
  "cross-server-reference": { code: "MK213", name: "CrossServerReference", summary: "Text refers to a tool on another server.", owasp: "MCP03:2025" },
};

/** Every code mcpkeel reports for a kind of change, and for a built-in check. */
export const CHANGE_CODES: ReadonlySet<string> = new Set(Object.values(KINDS).map((info) => info.code));
export const CHECK_CODES: ReadonlySet<string> = new Set(Object.values(FLAGS).map((info) => info.code));

const UNKNOWN: RuleInfo = { code: "MK100", name: "OtherChange", summary: "A change mcpkeel has no specific code for." };

export function kindRule(kind: string): RuleInfo {
  // Probe findings carry the kind of the underlying change after the probe.
  const probe = /^probe\.(session|identity)\./.exec(kind);
  return (probe ? KINDS[`probe.${probe[1]}`] : KINDS[kind]) ?? UNKNOWN;
}

export function flagRule(id: string): RuleInfo {
  return FLAGS[id] ?? { code: "MK200", name: "OtherCheck", summary: "A built-in check." };
}

/** The stable code and OWASP category of a change and of each of its flags, as they appear in JSON output. */
export function withCodes(change: Change): Change & { rule: string; owasp?: string } {
  const info = kindRule(change.kind);
  return {
    ...change,
    rule: info.code,
    owasp: info.owasp,
    flags: change.flags?.map((flag: Flag) => ({ ...flag, rule: flagRule(flag.id).code, owasp: flagRule(flag.id).owasp })),
  };
}

/* ----------------------------------------------------------------- SARIF */

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { critical: "error", high: "error", medium: "warning", low: "note" };
/** GitHub code scanning reads this to rank security alerts (critical ≥ 9, high ≥ 7, medium ≥ 4). */
const SECURITY_SEVERITY: Record<Severity, string> = { critical: "9.5", high: "8.0", medium: "5.5", low: "3.0" };

export interface SarifInput {
  version: string;
  changes: Change[];
  /** The lockfile, as the path code scanning shows (relative to the repository root) and its text, to point at a line. */
  lockfile: { uri: string; text: string };
}

/**
 * SARIF 2.1.0, as GitHub code scanning and other tools read it. One result per
 * change, located at the server or tool it concerns in the lockfile, with the
 * change's code as the rule and its built-in check hits in the message.
 */
export function renderSarif(input: SarifInput): string {
  const used = new Map<string, RuleInfo & { severity: Severity }>();
  const results = input.changes.map((change) => {
    const info = kindRule(change.kind);
    const prior = used.get(info.code);
    if (!prior || rank(change.severity) < rank(prior.severity)) used.set(info.code, { ...info, severity: change.severity });
    const flags = (change.flags ?? []).map((flag) => `${flagRule(flag.id).code} ${flag.label}: ${visible(flag.excerpt)}`);
    const review = change.review ? [`Review (${change.review.model}): ${change.review.verdict}. ${visible(change.review.reason)}`] : [];
    const policy = (change.policy ?? []).map((entry) => `Policy ${entry.rule}: ${entry.effect}. ${visible(entry.reason)}`);
    return {
      ruleId: info.code,
      level: LEVEL[change.severity],
      message: { text: [`${visible(change.server)}: ${visible(change.subject)} ${visible(change.message)} (${change.severity}).`, ...flags, ...review, ...policy].join("\n") },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: input.lockfile.uri },
            region: { startLine: lineOf(input.lockfile.text, change) },
          },
        },
      ],
      partialFingerprints: { "mcpkeel/v1": fingerprint(change) },
      properties: { severity: change.severity, kind: change.kind, server: change.server, ...(info.owasp ? { owasp: info.owasp } : {}) },
    };
  });

  const rules = [...used.values()]
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .map((info) => ({
      id: info.code,
      name: info.name,
      shortDescription: { text: info.summary },
      helpUri: "https://github.com/mcpkeel/mcpkeel#codes",
      properties: {
        tags: ["security", "mcp", ...(info.owasp ? [`owasp-mcp-top-10/${info.owasp}`] : [])],
        "security-severity": SECURITY_SEVERITY[info.severity],
      },
    }));

  const log = {
    $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "mcpkeel", version: input.version, informationUri: "https://mcpkeel.app", rules } },
        results,
      },
    ],
  };
  return `${JSON.stringify(log, null, 2)}\n`;
}

function rank(severity: Severity): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity];
}

/** The same change on the same thing keeps the same fingerprint across runs, so code scanning tracks one alert. */
function fingerprint(change: Change): string {
  return createHash("sha256").update(JSON.stringify([change.server, change.kind, change.subject, change.after ?? ""])).digest("hex").slice(0, 32);
}

/**
 * The line in the lockfile where the change's server, and then its tool or
 * prompt, is written. The lockfile is canonical JSON with two-space indents,
 * so a key at a known depth is found by its exact text. Falls back to the
 * server's line, then to line 1.
 */
function lineOf(text: string, change: Change): number {
  const lines = text.split("\n");
  const find = (needle: string, from: number, to = lines.length): number => {
    for (let i = from; i < to; i++) if (lines[i] === needle) return i;
    return -1;
  };
  const server = find(`    ${JSON.stringify(change.server)}: {`, 0);
  if (server === -1) return 1;
  // The server's block ends where the next server's key begins.
  let end = lines.findIndex((line, i) => i > server && /^ {4}"/.test(line));
  if (end === -1) end = lines.length;
  const item = /^(tool|prompt) (.+)$/.exec(change.subject);
  if (item) {
    const at = find(`        ${JSON.stringify(item[2])}: {`, server + 1, end);
    if (at !== -1) return at + 1;
  }
  return server + 1;
}
