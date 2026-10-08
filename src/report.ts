import { visible } from "./scan.js";
import type { Change, Severity } from "./types.js";

export interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  magenta: (s: string) => string;
}

export function palette(enabled: boolean): Palette {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

const LABEL: Record<Severity, string> = { critical: "CRITICAL", high: "HIGH", medium: "MEDIUM", low: "LOW" };
const INDENT = " ".repeat(12);

export function severityLabel(severity: Severity, p: Palette): string {
  const text = LABEL[severity].padEnd(8);
  if (severity === "critical") return p.bold(p.red(text));
  if (severity === "high") return p.red(text);
  if (severity === "medium") return p.yellow(text);
  return p.dim(text);
}

export function renderChange(change: Change, p: Palette): string {
  const lines = [`  ${severityLabel(change.severity, p)}  ${p.bold(change.subject)} ${change.message}`];
  if (change.before !== undefined || change.after !== undefined) {
    const [before, after] = excerptPair(change.before ?? "", change.after ?? "");
    if (change.before !== undefined && before) lines.push(INDENT + p.red(`- ${before}`));
    if (change.after !== undefined && after) lines.push(INDENT + p.green(`+ ${after}`));
  }
  for (const flag of change.flags ?? []) {
    lines.push(INDENT + p.magenta(`! ${flag.label}: `) + p.dim(`"${flag.excerpt}"`));
  }
  return lines.join("\n");
}

export function summarize(changes: Change[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const change of changes) counts[change.severity]++;
  return counts;
}

export function summaryLine(changes: Change[]): string {
  const counts = summarize(changes);
  return (Object.keys(counts) as Severity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`)
    .join(", ");
}

/**
 * Two long strings that differ in one place are unreadable side by side, so
 * show a window around the part that actually changed.
 */
export function excerptPair(before: string, after: string, width = 200): [string, string] {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  const start = Math.max(0, prefix - 40);
  const cut = (text: string): string => {
    const end = Math.min(text.length, Math.max(text.length - suffix + 40, start + 1));
    let slice = text.slice(start, end);
    let clipped = end < text.length;
    if (slice.length > width) {
      slice = slice.slice(0, width);
      clipped = true;
    }
    return (start > 0 ? "…" : "") + visible(slice) + (clipped ? "…" : "");
  };
  return [before ? cut(before) : "", after ? cut(after) : ""];
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
