export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

export type Transport = "stdio" | "http" | "sse";

/** One pinned tool. Everything here is text or schema the model gets to see. */
export interface ToolEntry {
  integrity: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface PromptEntry {
  integrity: string;
  title?: string;
  description?: string;
  arguments?: unknown[];
}

/**
 * The release a launcher such as npx, uvx or docker runs, and the registry's
 * digest of it. Definitions can stay the same while the code behind them
 * changes; this is what catches that.
 */
export interface PackagePin {
  ecosystem: "npm" | "pypi" | "oci";
  name: string;
  version: string;
  /** npm's `dist.integrity`, a digest over PyPI's files for the release, or an image digest. */
  integrity: string;
}

export interface ServerEntry {
  transport: Transport;
  /** How the server is reached, as written in the config. Never env values or headers. */
  source: { command?: string; args?: string[]; cwd?: string; url?: string };
  /** The package the command runs, when mcpkeel can resolve it. Not part of `integrity`. */
  package?: PackagePin;
  serverInfo?: { name?: string; version?: string };
  /** Server-level instructions, which clients may add to the system prompt. */
  instructions?: string;
  integrity: string;
  tools: Record<string, ToolEntry>;
  prompts?: Record<string, PromptEntry>;
}

export interface Lockfile {
  lockfileVersion: 1;
  servers: Record<string, ServerEntry>;
}

/** A server as declared in an MCP config file, before env expansion. */
export interface ServerSpec {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for a stdio server, as written in the config. */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface Flag {
  id: string;
  label: string;
  excerpt: string;
}

/** How a reviewer model read a change. */
export type Verdict = "cosmetic" | "functional" | "adversarial";

export interface ReviewOutcome {
  /** Which reviewer produced this, for example "claude". */
  by: string;
  model: string;
  verdict: Verdict;
  reason: string;
  /** What the verdict did to the severity. */
  effect: "raised" | "lowered" | "kept";
}

export interface Change {
  severity: Severity;
  /** The severity the fixed rules assigned, kept when a review changed it. */
  ruleSeverity?: Severity;
  /** The severity without the built-in check hits, when they raised it. */
  baseSeverity?: Severity;
  /** Policy entries that applied to this change. */
  policy?: { rule: string; reason: string; effect: string }[];
  review?: ReviewOutcome;
  server: string;
  kind: string;
  subject: string;
  message: string;
  before?: string;
  after?: string;
  /** Extra model-visible text that belongs to this change, such as a new tool's parameter descriptions. */
  context?: string;
  flags?: Flag[];
}
