import { flagRule, kindRule } from "./findings.js";
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

const ESC = String.fromCharCode(27);

export function palette(enabled: boolean): Palette {
  const wrap = (open: number, close: number) => (s: string) => (enabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : s);
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

/* --------------------------------------------------------------- terminal */

export function renderChange(change: Change, p: Palette): string {
  // Tool names, versions and descriptions all come from the server, so every
  // piece is passed through visible() before it reaches the terminal.
  const lines = [`  ${severityLabel(change.severity, p)}  ${p.bold(visible(change.subject))} ${visible(change.message)}`];
  if (change.before !== undefined || change.after !== undefined) {
    const [before, after] = excerptPair(change.before ?? "", change.after ?? "");
    if (change.before !== undefined && before) lines.push(INDENT + p.red(`- ${before}`));
    if (change.after !== undefined && after) lines.push(INDENT + p.green(`+ ${after}`));
  }
  for (const flag of change.flags ?? []) {
    lines.push(INDENT + p.magenta(`! ${flag.label}: `) + p.dim(`"${flag.excerpt}"`));
  }
  if (change.review) {
    const { verdict } = change.review;
    const tint = verdict === "adversarial" ? p.red : verdict === "functional" ? p.yellow : p.green;
    lines.push(`${INDENT}${p.cyan(`${reviewerName(change)}:`)} ${tint(verdict)}. ${visible(change.review.reason)}${effectNote(change, p)}`);
  }
  return lines.join("\n");
}

function reviewerName(change: Change): string {
  const by = change.review?.by ?? "review";
  return by.charAt(0).toUpperCase() + by.slice(1);
}

function effectNote(change: Change, p: Palette): string {
  const effect = change.review?.effect;
  if (!change.ruleSeverity || !effect || effect === "kept") return "";
  return ` ${p.dim(`(${effect} from ${LABEL[change.ruleSeverity]})`)}`;
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

/* --------------------------------------------------------------- markdown */

export interface MarkdownReport {
  heading: string;
  /** One or two sentences under the heading. Trusted text written by mcpkeel. */
  intro?: string;
  changes: Change[];
  errors?: { server: string; error: string }[];
  /** Steps that did not run. The reasons can quote a server, so they are shown as code. */
  incomplete?: { step: string; server?: string; reason: string }[];
  footer?: string;
}

/**
 * The same report as Markdown, for pull request bodies and job summaries.
 *
 * Those places render Markdown, and most of what is shown here was written by
 * the server being checked. So nothing from a server is ever emitted as
 * Markdown: names go in code spans, changed text goes in fenced blocks, and
 * prose such as a reviewer's reason is escaped. A description cannot add a
 * link, an image, a mention or a heading to the page.
 */
export function renderMarkdown(report: MarkdownReport): string {
  const out: string[] = [`## ${report.heading}`, ""];
  if (report.intro) out.push(report.intro, "");

  const byServer = new Map<string, Change[]>();
  for (const change of report.changes) byServer.set(change.server, [...(byServer.get(change.server) ?? []), change]);

  for (const [server, changes] of byServer) {
    out.push(`### ${codeSpan(server)}`, "");
    for (const change of changes) {
      out.push(`- **${LABEL[change.severity]}** ${codeSpan(change.subject)} ${escapeMarkdown(change.message)} · ${kindRule(change.kind).code}`);
      if (change.before !== undefined || change.after !== undefined) {
        const [before, after] = excerptPair(change.before ?? "", change.after ?? "", 600);
        const lines: string[] = [];
        if (change.before !== undefined && before) lines.push(`- ${before}`);
        if (change.after !== undefined && after) lines.push(`+ ${after}`);
        if (lines.length) out.push(...fenced(lines, "diff").map((line) => `  ${line}`));
      }
      for (const flag of change.flags ?? []) out.push(`  - Flag ${flagRule(flag.id).code}: ${flag.label}: ${codeSpan(flag.excerpt)}`);
      if (change.review) {
        const effect =
          change.ruleSeverity && change.review.effect !== "kept"
            ? ` Severity ${change.review.effect} from ${change.ruleSeverity}.`
            : "";
        out.push(`  - ${reviewerName(change)}: **${change.review.verdict}**. ${escapeMarkdown(change.review.reason)}${effect}`);
      }
    }
    out.push("");
  }

  if (report.errors?.length) {
    out.push("### Could not be reached", "");
    for (const error of report.errors) out.push(`- ${codeSpan(error.server)}: ${codeSpan(error.error.split("\n")[0] ?? "")}`);
    out.push("");
  }
  if (report.incomplete?.length) {
    out.push("### Not checked", "");
    for (const step of report.incomplete) {
      const where = step.server === undefined ? "" : ` for ${codeSpan(step.server)}`;
      out.push(`- ${escapeMarkdown(step.step)}${where}: ${codeSpan(step.reason.split("\n")[0] ?? "")}`);
    }
    out.push("");
  }
  if (report.footer) out.push(report.footer, "");
  return out.join("\n");
}

/** Inline code that cannot be closed early by backticks inside the text. */
export function codeSpan(text: string): string {
  const clean = visible(text);
  const longest = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  const pad = clean.startsWith("`") || clean.endsWith("`") || clean === "" ? " " : "";
  return `${ticks}${pad}${clean}${pad}${ticks}`;
}

/** A fenced block that cannot be closed early by a fence inside the text. */
export function fenced(lines: string[], language = ""): string[] {
  const longest = Math.max(2, ...lines.flatMap((line) => (line.match(/`+/g) ?? []).map((run) => run.length)));
  const fence = "`".repeat(longest + 1);
  return [`${fence}${language}`, ...lines, fence];
}

/** Prose that renders as the characters it contains and nothing else. */
export function escapeMarkdown(text: string): string {
  return visible(text)
    .replace(/&/g, "&amp;")
    .replace(/[\\`*_[\]()|~#!]/g, (char) => `\\${char}`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/:\/\//g, ":&#47;/")
    .replace(/\bwww\./gi, "www&#46;");
}
