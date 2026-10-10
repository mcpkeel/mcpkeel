import { existsSync, readFileSync } from "node:fs";
import { UserError, stripJsonComments } from "./config.js";
import { CHANGE_CODES, CHECK_CODES, flagRule, kindRule } from "./findings.js";
import { SEVERITIES, type Change, type Lockfile, type Severity } from "./types.js";

export const POLICY_NAME = "mcpkeel.json";

/**
 * A decision a team has made about a finding, kept in the repository and
 * reviewed like the lockfile.
 *
 * - A check code (MK2xx) accepts that check for the server, and optionally
 *   one tool or prompt: its hit is taken off the change, which goes back to
 *   the severity it had without it.
 * - A change code (MK1xx) sets the severity that kind of change gets. A
 *   change is never hidden; at most it becomes quieter.
 */
export interface PolicyEntry {
  rule: string;
  /** A server name, or "*" for every server. */
  server: string;
  /** "tool <name>" or "prompt <name>", as mcpkeel prints it. Absent means the whole server. */
  subject?: string;
  /** For change codes only. */
  severity?: Severity;
  reason: string;
}

export interface Policy {
  path: string;
  accept: PolicyEntry[];
}

export function readPolicy(path: string, required: boolean): Policy | undefined {
  if (!existsSync(path)) {
    if (required) throw new UserError(`Policy file not found: ${path}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch (err) {
    throw new UserError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const root = parsed as { accept?: unknown } | null;
  if (root === null || typeof root !== "object" || !Array.isArray(root.accept)) {
    throw new UserError(`${path} needs an "accept" array.`);
  }
  const accept = root.accept.map((value, index) => validate(value, `${path}: accept[${index}]`));
  return { path, accept };
}

function validate(value: unknown, where: string): PolicyEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new UserError(`${where} must be an object.`);
  const entry = value as Record<string, unknown>;
  const rule = entry.rule;
  if (typeof rule !== "string" || !/^MK[12]\d\d$/.test(rule)) throw new UserError(`${where}: "rule" must be a code such as MK112 or MK207.`);
  const known = rule.startsWith("MK2") ? CHECK_CODES.has(rule) : CHANGE_CODES.has(rule);
  if (!known) throw new UserError(`${where}: ${rule} is not a code mcpkeel reports.`);
  if (typeof entry.server !== "string" || entry.server === "") throw new UserError(`${where}: "server" must be a server name, or "*" for all of them.`);
  if (entry.subject !== undefined && (typeof entry.subject !== "string" || !/^(tool|prompt) .+/.test(entry.subject))) {
    throw new UserError(`${where}: "subject" must look like "tool <name>" or "prompt <name>".`);
  }
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
    throw new UserError(`${where}: "reason" must say why, in a sentence. It is what a reviewer reads.`);
  }
  let severity: Severity | undefined;
  if (rule.startsWith("MK1")) {
    if (typeof entry.severity !== "string" || !SEVERITIES.includes(entry.severity as Severity)) {
      throw new UserError(`${where}: a change code needs "severity": one of ${SEVERITIES.join(", ")}.`);
    }
    severity = entry.severity as Severity;
  } else if (entry.severity !== undefined) {
    throw new UserError(`${where}: a check code takes no "severity". Accepting the check takes its hit off the change.`);
  }
  return { rule, server: entry.server, subject: entry.subject as string | undefined, severity, reason: entry.reason.trim() };
}

/**
 * Apply the policy to a run's changes, in place, before any review. Returns
 * the changes that remain, which is all of them except a cross-field finding
 * whose every check was accepted: that change exists only to carry the hits.
 */
export function applyPolicy(changes: Change[], policy: Policy): Change[] {
  const matches = (entry: PolicyEntry, change: Change): boolean =>
    (entry.server === "*" || entry.server === change.server) && (entry.subject === undefined || entry.subject === change.subject);

  const kept: Change[] = [];
  for (const change of changes) {
    for (const entry of policy.accept) {
      if (!matches(entry, change)) continue;
      if (entry.rule.startsWith("MK2")) {
        const before = change.flags?.length ?? 0;
        change.flags = change.flags?.filter((flag) => flagRule(flag.id).code !== entry.rule);
        if ((change.flags?.length ?? 0) === before) continue;
        if (!change.flags?.length) {
          change.flags = undefined;
          if (change.baseSeverity) change.severity = change.baseSeverity;
          change.baseSeverity = undefined;
        }
        record(change, entry, "check accepted");
      } else if (kindRule(change.kind).code === entry.rule && entry.severity && entry.severity !== change.severity) {
        record(change, entry, `severity set from ${change.severity} to ${entry.severity}`);
        change.severity = entry.severity;
      }
    }
    if (change.kind === "tool.text.flagged" && !change.flags?.length) continue;
    kept.push(change);
  }
  return kept;
}

function record(change: Change, entry: PolicyEntry, effect: string): void {
  change.policy = [...(change.policy ?? []), { rule: entry.rule, reason: entry.reason, effect }];
}

/** Entries that name a server the lockfile does not have: most often a typo, which would make the entry do nothing. */
export function unknownServers(policy: Policy, lock: Lockfile): PolicyEntry[] {
  return policy.accept.filter((entry) => entry.server !== "*" && !lock.servers[entry.server]);
}
