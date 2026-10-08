import { createHash } from "node:crypto";

/**
 * Canonical form: object keys sorted, undefined dropped, JSON Schema `required`
 * lists sorted. Two definitions that mean the same thing serialize identically,
 * so reordering keys on the server side never shows up as drift.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v === undefined) continue;
      out[key] =
        key === "required" && Array.isArray(v) && v.every((x) => typeof x === "string")
          ? [...(v as string[])].sort()
          : canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Subresource-Integrity style digest, the same shape npm lockfiles use. */
export function integrity(value: unknown): string {
  return "sha256-" + createHash("sha256").update(canonicalJson(value)).digest("base64");
}
