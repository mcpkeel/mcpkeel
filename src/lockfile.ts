import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalize, integrity } from "./canonical.js";
import { UserError } from "./config.js";
import type { Lockfile, PromptEntry, ServerEntry, ToolEntry } from "./types.js";

export const LOCKFILE_NAME = "mcp.lock";

export function toolEntry(def: Omit<ToolEntry, "integrity">): ToolEntry {
  const clean = canonicalize(def) as Omit<ToolEntry, "integrity">;
  return { integrity: integrity(clean), ...clean };
}

export function promptEntry(def: Omit<PromptEntry, "integrity">): PromptEntry {
  const clean = canonicalize(def) as Omit<PromptEntry, "integrity">;
  return { integrity: integrity(clean), ...clean };
}

/** Digest over everything the model can see from this server. Launch details are left out. */
export function serverIntegrity(entry: Omit<ServerEntry, "integrity">): string {
  const digests = (items: Record<string, { integrity: string }> | undefined) =>
    Object.fromEntries(Object.entries(items ?? {}).map(([name, item]) => [name, item.integrity]));
  return integrity({ instructions: entry.instructions, tools: digests(entry.tools), prompts: digests(entry.prompts) });
}

export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) {
    throw new UserError(`No lockfile at ${path}. Run \`mcpkeel init\` to create one.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const lock = parsed as Partial<Lockfile> | null;
  if (lock === null || typeof lock !== "object" || lock.lockfileVersion !== 1) {
    throw new UserError(`${path} is not a version 1 mcp.lock. This mcpkeel only reads lockfileVersion 1.`);
  }
  if (lock.servers === undefined || lock.servers === null || typeof lock.servers !== "object") {
    throw new UserError(`${path} has no "servers" object.`);
  }
  for (const [name, server] of Object.entries(lock.servers)) {
    if (server === null || typeof server !== "object" || typeof server.tools !== "object" || server.tools === null) {
      throw new UserError(`${path}: server "${name}" is malformed.`);
    }
  }
  return lock as Lockfile;
}

/** Deterministic output: same servers in, byte-identical file out. No timestamps. */
export function serializeLockfile(lock: Lockfile): string {
  return JSON.stringify(canonicalize(lock), null, 2) + "\n";
}

export function writeLockfile(path: string, lock: Lockfile): void {
  writeFileSync(path, serializeLockfile(lock));
}
