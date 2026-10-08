import type { Flag } from "./types.js";

/**
 * Heuristics for text that reads like an instruction to the model rather than
 * documentation for it. These are deliberately narrow: a hit is a reason for a
 * human to look, not a verdict. A clean scan does not mean a definition is safe.
 */
interface Rule {
  id: string;
  label: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "invisible-characters",
    label: "invisible or bidirectional control characters",
    pattern: /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|\uDB40[\uDC00-\uDC7F]/,
  },
  {
    id: "instruction-markup",
    label: "instruction-like markup",
    pattern: /<\s*\/?\s*(important|system|secret|instructions?|admin|override|hidden)\b[^>]*>/i,
  },
  {
    id: "override-instructions",
    label: "tells the model to disregard other instructions",
    pattern: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|other|all|system)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|guidelines)\b/i,
  },
  {
    id: "conceal-from-user",
    label: "tells the model to hide something from the user",
    pattern: /\b(do not|don't|never|without)\b[^.\n]{0,30}\b(tell|telling|mention|mentioning|inform|informing|notify|notifying|reveal|revealing|show|showing|alert|alerting)\b[^.\n]{0,30}\b(user|human|operator)\b/i,
  },
  {
    id: "sensitive-paths",
    label: "references credentials or secret files",
    pattern: /(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.npmrc\b|\.netrc\b|(^|[\s"'`\/])\.env\b|\/etc\/(passwd|shadow)\b|\bmcp\.json\b|claude_desktop_config\.json)/i,
  },
  {
    id: "cross-tool-steering",
    label: "tries to change how other tools are used",
    pattern: /\b(before|whenever|every time|each time|always)\b[^.\n]{0,60}\b(any|every|all|other|another)\s+(tool|tools|function|functions|server|servers)\b/i,
  },
  {
    id: "exfiltration",
    label: "asks for data to be sent or passed along",
    pattern: /\b(send|post|forward|upload|exfiltrate|transmit)\b[^.\n]{0,60}\b(https?:\/\/|to (this|the following) (url|address|endpoint|email))/i,
  },
];

export function scanText(text: string | undefined): Flag[] {
  if (!text) return [];
  const flags: Flag[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    flags.push({ id: rule.id, label: rule.label, excerpt: excerptAround(text, match.index, match[0].length) });
  }
  return flags;
}

/** Flags present in `after` whose rule did not already fire on `before`. */
export function newFlags(before: string | undefined, after: string | undefined): Flag[] {
  const had = new Set(scanText(before).map((f) => f.id));
  return scanText(after).filter((f) => !had.has(f.id));
}

/** Every string that sits under a `description` or `title` key, at any depth. */
export function collectSchemaText(schema: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === "description" || key === "title") && typeof value === "string") parts.push(value);
      else if (key === "enum" || key === "default" || key === "examples" || key === "const") {
        JSON.stringify(value, (_k, v) => {
          if (typeof v === "string") parts.push(v);
          return v;
        });
      } else walk(value);
    }
  };
  walk(schema);
  return parts.join("\n");
}

function excerptAround(text: string, index: number, length: number): string {
  let start = Math.max(0, index - 30);
  let end = Math.min(text.length, index + length + 30);
  // Snap to word boundaries so the excerpt does not open or close mid-word.
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space < index) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space >= index + length) end = space;
  }
  return (start > 0 ? "…" : "") + visible(text.slice(start, end)) + (end < text.length ? "…" : "");
}

/** Make invisible characters show up as escapes so a reviewer can see them. */
export function visible(text: string): string {
  return text
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`)
    .replace(/\uDB40[\uDC00-\uDC7F]/g, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase()}}`)
    .replace(/\s+/g, " ")
    .trim();
}
