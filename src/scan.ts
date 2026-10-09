import type { Flag } from "./types.js";

/**
 * Heuristics for text that reads like an instruction to the model rather than
 * documentation for it. These are deliberately narrow: a hit is a reason for a
 * human to look, not a verdict. A clean scan does not mean a definition is safe.
 */
interface Match {
  index: number;
  length: number;
}

interface Rule {
  id: string;
  label: string;
  find: (text: string) => Match | undefined;
}

type Range = readonly [number, number];

/**
 * Code points that render as nothing, or that reorder the text around them.
 * They are listed by number so this file never contains the characters it
 * looks for.
 */
const INVISIBLE: readonly Range[] = [
  [0x200b, 0x200f], // zero-width space and joiners, direction marks
  [0x202a, 0x202e], // bidirectional embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x2069], // bidirectional isolates
  [0xfeff, 0xfeff], // zero-width no-break space
  [0xe0000, 0xe007f], // tag characters
];

/** Control characters other than tab, line feed and carriage return. */
const CONTROL: readonly Range[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
];

function inRanges(codePoint: number, ranges: readonly Range[]): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high);
}

function findCodePoint(text: string, ranges: readonly Range[]): Match | undefined {
  let index = 0;
  for (const char of text) {
    if (inRanges(char.codePointAt(0)!, ranges)) return { index, length: char.length };
    index += char.length;
  }
  return undefined;
}

function regex(pattern: RegExp): (text: string) => Match | undefined {
  return (text) => {
    const match = pattern.exec(text);
    return match ? { index: match.index, length: match[0].length } : undefined;
  };
}

const RULES: Rule[] = [
  {
    id: "invisible-characters",
    label: "invisible, control or bidirectional characters",
    find: (text) => findCodePoint(text, [...INVISIBLE, ...CONTROL]),
  },
  {
    id: "mixed-alphabets",
    label: "one word mixes letters from different alphabets",
    find: (text) => findMixedAlphabets(text),
  },
  {
    id: "instruction-markup",
    label: "instruction-like markup",
    find: regex(/<!--|<\s*\/?\s*(important|system|secret|instructions?|admin|override|hidden)\b[^>]*>/i),
  },
  {
    // Models decode hex, entities and escapes without being asked to, so a
    // payload does not have to be readable to a reviewer to be read by an agent.
    id: "encoded-content",
    label: "encoded text a model can decode",
    find: regex(/(?:\\u[0-9a-f]{4}){6,}|(?:\\x[0-9a-f]{2}){8,}|(?:&#x?[0-9a-f]{2,6};){6,}|(?:%[0-9a-f]{2}){8,}|(?<![0-9a-f])(?:[0-9a-f]{2}[ :,-]?){33,}(?![0-9a-f])|(?<![A-Za-z0-9+\/=])(?=[A-Za-z0-9+]*[G-Zg-z+])[A-Za-z0-9+]{60,}={0,2}/i),
  },
  {
    id: "override-instructions",
    label: "tells the model to disregard other instructions",
    find: regex(/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|other|all|system)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|guidelines)\b/i),
  },
  {
    id: "conceal-from-user",
    label: "tells the model to hide something from the user",
    find: regex(/\b(do not|don't|never|without)\b[^.\n]{0,30}\b(tell|telling|mention|mentioning|inform|informing|notify|notifying|reveal|revealing|show|showing|alert|alerting)\b(?!\s+(more|fewer|less|over|above|up to|at most|\d))[^.\n]{0,30}\b(user|human|operator)\b/i),
  },
  {
    id: "sensitive-paths",
    label: "references credentials or secret files",
    find: regex(/(~\/\.ssh|(?<![A-Za-z0-9])id_(rsa|ed25519|ecdsa)(?![A-Za-z0-9])|\.aws\/credentials|\.npmrc\b|\.netrc\b|(^|[\s"'`\/])\.env\b(?!\.(example|sample|template|dist)\b)|\/etc\/(passwd|shadow)\b|\bmcp\.json\b|claude_desktop_config\.json)/i),
  },
  {
    id: "cross-tool-steering",
    label: "tries to change how other tools are used",
    find: regex(/\b(before|whenever|every time|each time|always)\b[^.\n]{0,60}\b(any|every|all|other|another)\s+(tool|tools|function|functions|server|servers)\b|\b(must|has to|needs to|required to)\b[^.\n]{0,30}\b(run|called|invoked|executed|used)\s+(first|before)\b/i),
  },
  {
    id: "exfiltration",
    label: "asks for data to be sent or passed along",
    find: regex(/\b(send|post|forward|upload|exfiltrate|transmit)\b[^.\n]{0,60}\b(https?:\/\/|to (this|the following) (url|address|endpoint|email))/i),
  },
  {
    // "Get conversation history" is an ordinary chat tool. "Put the complete
    // conversation so far into this field" is not, so a verb of inclusion is required.
    id: "conversation-harvest",
    label: "asks for the conversation or the system prompt to be passed in",
    find: regex(/\b(include|put|pass|add|attach|append|copy|paste|insert|provide|place|write|supply)\b[^.\n]{0,60}\b((entire|complete|full|whole)\s+(conversation|chat|dialogue|context)|(conversation|chat|message)\s+(so far|history|transcript|log)|system prompt|(previous|prior|earlier)\s+messages)\b/i),
  },
  {
    id: "secret-harvest",
    label: "asks for keys, passwords or tokens the user has shared",
    find: regex(/\b(keys?|passwords?|tokens?|secrets?|credentials)\b[^.\n]{0,40}\buser\b[^.\n]{0,25}\b(pasted|shared|mentioned|typed|entered|gave|sent|said)\b|\b(any|all)\s+(api\s+)?(keys|passwords|tokens|secrets|credentials)\b[^.\n]{0,60}\b(in|from)\s+(the|this|your)\s+(conversation|context|chat)\b/i),
  },
];

/** Rules about what the text says, which still apply once a disguise is undone. */
const PHRASE_RULES = RULES.filter((rule) => !["invisible-characters", "encoded-content", "mixed-alphabets"].includes(rule.id));

interface Disguise {
  how: string;
  text: string;
}

/**
 * Readings of the text with one common disguise undone. Only readings that
 * differ from the original are returned.
 */
export function disguises(text: string): Disguise[] {
  const out: Disguise[] = [];
  const add = (how: string, candidate: string): void => {
    if (candidate !== text && candidate.trim()) out.push({ how, text: candidate });
  };
  add("hidden in tag characters", revealTags(text));
  add("once decoded", decodeRuns(text));
  add("read backwards", [...text].reverse().join(""));
  add("with the spacing removed", text.replace(/(?<![A-Za-z])(?:[A-Za-z][ .\-_*|]){3,}[A-Za-z](?![A-Za-z])/g, (run) => run.replace(/[^A-Za-z]/g, "")));
  add("with digits read as letters", unleet(text));
  add("in ROT13", rot13(text));
  add("with look-alike letters replaced", foldLookalikes(text));
  return out;
}

/**
 * Unicode tag characters (U+E0020 to U+E007E) mirror printable ASCII and render
 * as nothing, but a model can read them. Each becomes the ASCII character it
 * stands for, and the begin and cancel tags are dropped.
 */
export function revealTags(text: string): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint >= 0xe0020 && codePoint <= 0xe007e) out += String.fromCharCode(codePoint - 0xe0000);
    else if (codePoint < 0xe0000 || codePoint > 0xe007f) out += char;
  }
  return out;
}

/** The message spelled in tag characters, if any, with nothing else around it. */
export function hiddenTagText(text: string): string | undefined {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint >= 0xe0020 && codePoint <= 0xe007e) out += String.fromCharCode(codePoint - 0xe0000);
  }
  return out.trim() ? out : undefined;
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/** Undo digit-for-letter swaps, but only inside words that mix the two. */
function unleet(text: string): string {
  return text.replace(/[A-Za-z0-9@$!]+/g, (word) =>
    /[A-Za-z]/.test(word) && /[013457@$]/.test(word) ? word.replace(/[013457@$!]/g, (char) => LEET[char] ?? char) : word,
  );
}

function rot13(text: string): string {
  return text.replace(/[A-Za-z]/g, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** Letters from other alphabets that are drawn like Latin ones, by code point. */
const LOOKALIKES = new Map<number, string>([
  // Cyrillic
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"], [0x0445, "x"], [0x0443, "y"],
  [0x0456, "i"], [0x0458, "j"], [0x0455, "s"], [0x04bb, "h"], [0x0501, "d"],
  [0x0410, "A"], [0x0412, "B"], [0x0415, "E"], [0x041a, "K"], [0x041c, "M"], [0x041d, "H"], [0x041e, "O"],
  [0x0420, "P"], [0x0421, "C"], [0x0422, "T"], [0x0425, "X"],
  // Greek
  [0x03b1, "a"], [0x03bf, "o"], [0x03c1, "p"], [0x03bd, "v"], [0x03b9, "i"],
  [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"], [0x0399, "I"], [0x039a, "K"],
  [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03a1, "P"], [0x03a4, "T"], [0x03a5, "Y"], [0x03a7, "X"],
]);

function foldLookalikes(text: string): string {
  let out = "";
  // NFKC first: full-width and other compatibility forms become plain letters.
  for (const char of text.normalize("NFKC")) out += LOOKALIKES.get(char.codePointAt(0)!) ?? char;
  return out;
}

const LATIN: readonly Range[] = [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0x24f]];
const OTHER_ALPHABETS: readonly Range[] = [[0x370, 0x3ff], [0x400, 0x52f]]; // Greek, Cyrillic

/** A word of four or more letters that mixes Latin with Greek or Cyrillic. Units such as a Greek mu before "m" stay under that length. */
function findMixedAlphabets(text: string): Match | undefined {
  let index = 0;
  let start = -1;
  let latin = false;
  let other = false;
  let letters = 0;
  const flush = (end: number): Match | undefined => {
    const hit = start !== -1 && latin && other && letters >= 4 ? { index: start, length: end - start } : undefined;
    start = -1;
    latin = other = false;
    letters = 0;
    return hit;
  };
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    const isLatin = inRanges(codePoint, LATIN);
    const isOther = inRanges(codePoint, OTHER_ALPHABETS);
    if (isLatin || isOther) {
      if (start === -1) start = index;
      latin ||= isLatin;
      other ||= isOther;
      letters++;
    } else {
      const hit = flush(index);
      if (hit) return hit;
    }
    index += char.length;
  }
  return flush(index);
}

/** Share of characters that are ordinary text, to tell a decoded message from decoded noise. */
function readable(text: string, minimum = 8): boolean {
  if (text.length < minimum) return false;
  let ordinary = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if ((codePoint >= 0x20 && codePoint < 0x7f) || codePoint === 0x0a || codePoint === 0x09 || codePoint > 0xa0) ordinary++;
  }
  return ordinary / [...text].length >= 0.9 && /[A-Za-z]{3}/.test(text) && !text.includes(String.fromCharCode(0xfffd));
}

/** Replace each encoded run with what it decodes to, when that is readable text. */
function decodeRuns(text: string): string {
  // A blob has to decode to a real stretch of text. Entities and escapes spell
  // out single characters on purpose, so a few of them are already a word.
  const keep = (original: string, decoded: string, minimum = 8): string => (readable(decoded, minimum) ? decoded : original);
  return text
    .replace(/(?<![0-9a-f])(?:[0-9a-f]{2}[ :,-]?){12,}(?![0-9a-f])/gi, (run) =>
      keep(run, Buffer.from(run.replace(/[^0-9a-f]/gi, ""), "hex").toString("utf8")),
    )
    .replace(/(?<![A-Za-z0-9+\/=])(?=[A-Za-z0-9+\/]*[G-Zg-z+\/])[A-Za-z0-9+\/]{24,}={0,2}/g, (run) =>
      keep(run, Buffer.from(run, "base64").toString("utf8")),
    )
    .replace(/(?:&#x?[0-9a-f]{2,6};){3,}/gi, (run) =>
      keep(
        run,
        run.replace(/&#(x?)([0-9a-f]{2,6});/gi, (_m, hex: string, digits: string) => safeFromCodePoint(parseInt(digits, hex ? 16 : 10))),
        3,
      ),
    )
    .replace(/(?:%[0-9a-f]{2}){3,}/gi, (run) => {
      try {
        return keep(run, decodeURIComponent(run), 3);
      } catch {
        return run;
      }
    })
    .replace(/(?:\\u[0-9a-f]{4}|\\x[0-9a-f]{2}){3,}/gi, (run) =>
      keep(
        run,
        run.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_m, four: string | undefined, two: string | undefined) =>
          safeFromCodePoint(parseInt(four ?? two ?? "0", 16)),
        ),
        3,
      ),
    );
}

function safeFromCodePoint(codePoint: number): string {
  return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
}

export function scanText(text: string | undefined): Flag[] {
  if (!text) return [];
  const flags: Flag[] = [];
  const seen = new Set<string>();
  const run = (candidate: string, how: string, rules: Rule[]): void => {
    for (const rule of rules) {
      if (seen.has(rule.id)) continue;
      const match = rule.find(candidate);
      if (!match) continue;
      seen.add(rule.id);
      flags.push({
        id: rule.id,
        label: how ? `${rule.label} (${how})` : rule.label,
        excerpt: excerptAround(candidate, match.index, match.length),
      });
    }
  };
  run(text, "", RULES);
  // The invisible characters themselves say nothing. When they spell a message,
  // the message is what a reviewer needs to see.
  const hidden = hiddenTagText(text);
  const invisible = flags.find((flag) => flag.id === "invisible-characters");
  if (hidden && invisible) invisible.excerpt = `hidden text: "${hidden.length > 160 ? `${hidden.slice(0, 160)}…` : hidden}"`;
  // The same rules again over each way of un-hiding the text. A rule only has
  // to describe what an attack says, not every way it could be disguised.
  for (const variant of disguises(text)) run(variant.text, variant.how, PHRASE_RULES);
  return flags;
}

/** Flags present in `after` whose rule did not already fire on `before`. */
export function newFlags(before: string | undefined, after: string | undefined): Flag[] {
  const had = new Set(scanText(before).map((f) => f.id));
  return scanText(after).filter((f) => !had.has(f.id));
}

/** Every string that sits under a `description` or `title` key, at any depth. */
export function collectSchemaText(schema: unknown): string {
  return schemaStrings(schema).join("\n");
}

/** The strings `collectSchemaText` joins, one entry each. */
export function schemaStrings(schema: unknown): string[] {
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
  return parts;
}

/**
 * Every key and every string in a schema, at any depth. Descriptions are not
 * the only place an instruction can sit: a model reads parameter names, enum
 * values and unknown extra fields too, so all of them are scanned.
 */
export function collectAllText(schema: unknown): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") return void parts.push(node);
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      parts.push(key);
      walk(value);
    }
  };
  walk(schema);
  return parts.join("\n");
}

/** A name that reads like a sentence, such as `content_from_reading_the_users_ssh_key`. */
export function sentenceLikeName(name: string): boolean {
  const words = name.split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  return words.length >= 6 || name.length > 48;
}

export function excerptAround(text: string, index: number, length: number): string {
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

/**
 * Text from a server, made safe to print. Invisible characters become visible
 * escapes so a reviewer can see them, and control characters are neutralised so
 * the text cannot move the cursor, recolour the terminal or hide what follows.
 */
export function visible(text: string): string {
  let out = "";
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    const hex = codePoint.toString(16).toUpperCase();
    if (inRanges(codePoint, INVISIBLE)) out += codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
    else if (inRanges(codePoint, CONTROL)) out += `\\x${hex.padStart(2, "0")}`;
    else out += char;
  }
  return out.replace(/\s+/g, " ").trim();
}
