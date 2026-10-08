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

export interface ServerEntry {
  transport: Transport;
  /** How the server is reached, as written in the config. Never env values or headers. */
  source: { command?: string; args?: string[]; url?: string };
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
  url?: string;
  headers?: Record<string, string>;
}

export interface Flag {
  id: string;
  label: string;
  excerpt: string;
}

export interface Change {
  severity: Severity;
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
