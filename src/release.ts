import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { PackagePin } from "./types.js";

/**
 * What changed in the code between two releases of an npm package.
 *
 * mcpkeel pins the release a launcher runs. When that release changes, a
 * reviewer otherwise sees two version numbers and two digests. This reads both
 * releases, as the registry serves them, and says what the new one adds: the
 * kind of change a backdoor needs (an address to send data to, an install
 * script, a way to run a process or code), and the changed lines themselves
 * when there are few of them.
 *
 * Nothing here executes or writes anything. Each archive is checked against
 * the registry's digest before a byte of it is read, unpacked in memory within
 * fixed limits, and only its text is looked at.
 */

export class ReleaseError extends Error {}

export interface ReleaseOptions {
  timeoutMs: number;
  npmRegistry?: string;
}

export interface Limits {
  /** Largest compressed archive downloaded. */
  maxTarballBytes: number;
  /** Largest archive once decompressed. */
  maxUnpackedBytes: number;
  /** Most entries read from one archive. */
  maxEntries: number;
  /** Largest single file looked at; larger ones are counted, not read. */
  maxFileBytes: number;
}

export const LIMITS: Limits = {
  maxTarballBytes: 40 * 1024 * 1024,
  maxUnpackedBytes: 160 * 1024 * 1024,
  maxEntries: 20_000,
  maxFileBytes: 4 * 1024 * 1024,
};

/** The text files of a release, by path inside the package. */
export type ReleaseFiles = Map<string, string>;

export type SignalKind =
  | "install-script"
  | "dependency"
  | "email"
  | "hidden-recipient"
  | "url-host"
  | "ip-address"
  | "child-process"
  | "eval"
  | "dynamic-code"
  | "decoded-string";

export interface Signal {
  kind: SignalKind;
  value: string;
  file: string;
  /** The line it was found on, trimmed, so a reviewer reads it in place. */
  line?: string;
}

export interface ReleaseComparison {
  /** Signals the new release has that the old one did not. */
  added: Signal[];
  files: { changed: number; added: number; removed: number };
  /** Lines of code the new release adds, when there are few enough to read. */
  lines?: { file: string; text: string }[];
  /** Lines of code added, whether or not they are listed. Documentation and type declarations are not counted. */
  linesAdded: number;
}

/* -------------------------------------------------------------- fetching */

/**
 * Download one release of an npm package and return its text files. The
 * archive must match `pin.integrity`, the digest the lockfile or the registry
 * gave for that version; anything else is refused before it is read.
 */
export async function fetchNpmRelease(pin: PackagePin, options: ReleaseOptions, limits: Limits = LIMITS): Promise<ReleaseFiles> {
  if (pin.ecosystem !== "npm") throw new ReleaseError(`only npm releases can be read, not ${pin.ecosystem}`);
  const registry = new URL((options.npmRegistry ?? "https://registry.npmjs.org").replace(/\/+$/, "") + "/");
  const doc = (await getJson(new URL(pin.name.replace("/", "%2f"), registry), options)) as {
    versions?: Record<string, { dist?: { tarball?: string; integrity?: string; shasum?: string } }>;
  };
  const dist = doc.versions?.[pin.version]?.dist;
  if (!dist?.tarball) throw new ReleaseError(`${pin.name}@${pin.version} is no longer on the registry`);
  const tarball = new URL(dist.tarball);
  // The archive is read only from the registry that was asked, never from a
  // host its metadata points somewhere else.
  if (tarball.origin !== registry.origin) throw new ReleaseError(`the registry points ${pin.name}@${pin.version} at another host (${tarball.host})`);
  const bytes = await download(tarball, options, limits.maxTarballBytes);
  verifyIntegrity(bytes, pin.integrity, `${pin.name}@${pin.version}`);
  return readTarball(bytes, limits);
}

async function getJson(url: URL, options: ReleaseOptions): Promise<unknown> {
  const response = await request(url, options, { accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" });
  if (response.status === 404) throw new ReleaseError(`not found: ${url.pathname}`);
  if (!response.ok) throw new ReleaseError(`${url.host} answered ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ReleaseError(`${url.host} sent a response that is not JSON`);
  }
}

async function download(url: URL, options: ReleaseOptions, maxBytes: number): Promise<Buffer> {
  const response = await request(url, options, {});
  if (!response.ok || !response.body) throw new ReleaseError(`${url.host} answered ${response.status} for the archive`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new ReleaseError(`the archive is ${declared} bytes, over the ${maxBytes}-byte limit`);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new ReleaseError(`the archive is over the ${maxBytes}-byte limit`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function request(url: URL, options: ReleaseOptions, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new ReleaseError(`could not reach ${url.host}: ${cause ?? (err as Error).message}`);
  }
}

/**
 * Check bytes against a Subresource Integrity value such as npm's `dist.integrity`.
 * The strongest algorithm the value names is the one checked.
 */
export function verifyIntegrity(bytes: Buffer, sri: string, label: string): void {
  const entries = sri
    .trim()
    .split(/\s+/)
    .map((part) => /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(part))
    .filter((m): m is RegExpExecArray => m !== null);
  const order = ["sha512", "sha384", "sha256", "sha1"];
  const best = entries.sort((a, b) => order.indexOf(a[1]!) - order.indexOf(b[1]!))[0];
  if (!best) throw new ReleaseError(`${label} has no digest mcpkeel can check`);
  const actual = createHash(best[1]!).update(bytes).digest("base64");
  if (actual !== best[2]) throw new ReleaseError(`${label} does not match its ${best[1]} digest`);
}

/* --------------------------------------------------------------- reading */

/**
 * Unpack a gzipped tar archive in memory and return its text files. Links,
 * directories and devices are skipped; paths are only names in a map, so an
 * entry that tries to escape the package (`../`) cannot reach anything. Binary
 * files (any with a NUL byte) and files over the per-file limit are left out.
 */
export function readTarball(gz: Buffer, limits: Limits = LIMITS): ReleaseFiles {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: limits.maxUnpackedBytes });
  } catch (err) {
    throw new ReleaseError(/RangeError|maxOutputLength|buffer/i.test(String(err)) ? `the archive unpacks to more than ${limits.maxUnpackedBytes} bytes` : `the archive is not valid gzip`);
  }
  const files: ReleaseFiles = new Map();
  let offset = 0;
  let entries = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if (++entries > limits.maxEntries) throw new ReleaseError(`the archive has more than ${limits.maxEntries} entries`);
    if (!checksumMatches(header)) throw new ReleaseError("the archive has a corrupt entry header");
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ReleaseError("the archive ends inside an entry");
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === "L") {
      longName = cString(data);
      continue;
    }
    if (type === "x") {
      paxPath = paxRecords(data).path;
      continue;
    }
    if (type === "g") continue;
    const name = paxPath ?? longName ?? joinUstarName(header);
    longName = undefined;
    paxPath = undefined;
    // Regular files only: "0", or NUL in old archives, or "7" (contiguous).
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    if (size > limits.maxFileBytes || data.includes(0)) continue;
    files.set(packagePath(name), data.toString("utf8"));
  }
  return files;
}

function checksumMatches(header: Buffer): boolean {
  const stored = octal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
  return sum === stored;
}

function octal(field: Buffer): number {
  // Sizes over 8 GiB use a base-256 form, which no package needs.
  if (field[0]! & 0x80) throw new ReleaseError("the archive has an entry too large to read");
  const text = cString(field).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new ReleaseError("the archive has a malformed entry header");
  return parseInt(text, 8);
}

function cString(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString("utf8");
}

function joinUstarName(header: Buffer): string {
  const name = cString(header.subarray(0, 100));
  const isUstar = header.subarray(257, 262).toString("latin1") === "ustar";
  const prefix = isUstar ? cString(header.subarray(345, 500)) : "";
  return prefix ? `${prefix}/${name}` : name;
}

function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space === -1) break;
    const length = parseInt(data.subarray(i, space).toString("latin1"), 10);
    if (!Number.isFinite(length) || length <= 0 || i + length > data.length) break;
    const record = data.subarray(space + 1, i + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    i += length;
  }
  return records;
}

/** npm archives keep everything under one top folder, usually `package/`. */
function packagePath(name: string): string {
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length > 1 ? parts.slice(1).join("/") : (parts[0] ?? "");
}

/* --------------------------------------------------------------- signals */

const CODE_FILE = /\.(c|m)?(j|t)sx?$/i;
/** Text a reader looks at, not code that runs: left out of the code signals. */
const NOT_CODE = /(\.d\.(c|m)?ts|\.map|\.min\.css|\.md|\.markdown|\.txt|license|licence|changelog|readme)(\.[a-z]+)?$/i;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall", "prepare"];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}\b/g;
/** A blind-copy recipient set in code: how postmark-mcp 1.0.16 copied every email out. */
const HIDDEN_RECIPIENT = /(?<![\w$])["'`]?bcc["'`]?\s*[:=]/gi;
const DECODE = /\bBuffer\.from\s*\(\s*["'`][A-Za-z0-9+/=]{8,}["'`]\s*,\s*["'`]base64["'`]|\batob\s*\(\s*["'`][A-Za-z0-9+/=]{8,}["'`]/g;
const URL_HOST = /\b(?:https?|wss?):\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,24}|\d{1,3}(?:\.\d{1,3}){3})(?=[:/"'`\s?#]|$)/g;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const CHILD_PROCESS = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)["'`](?:node:)?child_process["'`]/g;
const EVAL = /(?<![\w$.])eval\s*\(/g;
const DYNAMIC = /\bnew\s+Function\s*\(|(?:require\s*\(\s*|from\s+|import\s*\(\s*)["'`](?:node:)?vm["'`]/g;

/** Addresses that appear in ordinary code and say nothing about where data goes. */
const QUIET_HOSTS = new Set(["localhost", "www.w3.org", "json-schema.org", "schema.org"]);

/** Names reserved for documentation and tests (RFC 2606, RFC 6761). */
function reservedName(host: string): boolean {
  return /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/.test(host);
}

/**
 * Private, shared, link-local, documentation, multicast and network addresses:
 * they appear in allow and deny lists, not as somewhere to send data.
 */
function quietIp(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 88 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    o[3] === 0
  );
}

/** The trimmed line around a match, for the reviewer. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  if (line.length <= 240) return line;
  const from = Math.max(0, index - start - 100);
  return `…${line.slice(from, from + 220)}…`;
}

/** Everything in a release that matters for where data can go or what can run. */
export function releaseSignals(files: ReleaseFiles): Signal[] {
  const signals: Signal[] = [];
  const manifest = files.get("package.json");
  if (manifest !== undefined) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(manifest);
    } catch {
      // A manifest that does not parse adds no signals; npm would not install it either.
    }
    for (const hook of INSTALL_HOOKS) {
      const script = pkg.scripts?.[hook];
      if (typeof script === "string") signals.push({ kind: "install-script", value: `${hook}: ${script}`, file: "package.json", line: `"${hook}": ${JSON.stringify(script)}` });
    }
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      signals.push({ kind: "dependency", value: name, file: "package.json", line: `"${name}": ${JSON.stringify(range)}` });
    }
  }
  for (const [file, text] of files) {
    if (!CODE_FILE.test(file) || NOT_CODE.test(file)) continue;
    const add = (kind: SignalKind, value: string, index: number) => signals.push({ kind, value, file, line: lineAt(text, index) });
    for (const m of text.matchAll(EMAIL)) {
      const value = m[0].toLowerCase();
      // npm-style "name@1.2.3" and scoped "@scope/name" are not addresses.
      if (/@\d/.test(value) || reservedName(value.slice(value.indexOf("@") + 1))) continue;
      add("email", value, m.index);
    }
    for (const m of text.matchAll(HIDDEN_RECIPIENT)) add("hidden-recipient", "bcc", m.index);
    for (const m of text.matchAll(URL_HOST)) {
      const host = m[1]!.toLowerCase();
      if (QUIET_HOSTS.has(host) || reservedName(host)) continue;
      const octets = host.split(".").map(Number);
      if (octets.length === 4 && octets.every((o) => Number.isInteger(o)) && quietIp(octets)) continue;
      add("url-host", host, m.index);
    }
    for (const m of text.matchAll(IPV4)) {
      const octets = m.slice(1, 5).map(Number);
      if (octets.some((o) => o > 255) || quietIp(octets)) continue;
      add("ip-address", octets.join("."), m.index);
    }
    for (const m of text.matchAll(CHILD_PROCESS)) add("child-process", "child_process", m.index);
    for (const m of text.matchAll(EVAL)) add("eval", "eval()", m.index);
    for (const m of text.matchAll(DYNAMIC)) add("dynamic-code", m[0].includes("Function") ? "new Function()" : "vm", m.index);
    for (const m of text.matchAll(DECODE)) add("decoded-string", m[0].slice(0, 60), m.index);
  }
  return signals;
}

/* ------------------------------------------------------------ comparing */

const MAX_LINES_SHOWN = 12;
const MAX_LINES_FOR_EXCERPT = 40;
const MAX_LINE_CHARS = 240;

/** What the new release adds over the old one. */
export function compareReleases(before: ReleaseFiles, after: ReleaseFiles): ReleaseComparison {
  const key = (s: Signal) => `${s.kind}\0${s.value}`;
  const known = new Set(releaseSignals(before).map(key));
  const seen = new Set<string>();
  const added: Signal[] = [];
  for (const signal of releaseSignals(after)) {
    const k = key(signal);
    if (known.has(k) || seen.has(k)) continue;
    seen.add(k);
    added.push(signal);
  }

  let changed = 0;
  let addedFiles = 0;
  let linesAdded = 0;
  const lines: { file: string; text: string }[] = [];
  for (const [file, text] of after) {
    const old = before.get(file);
    if (old === text) continue;
    if (old === undefined) addedFiles++;
    else changed++;
    // Only what can run, and the manifest, are read line by line: a README
    // that grew says nothing about where data goes.
    if (file !== "package.json" && (!CODE_FILE.test(file) || NOT_CODE.test(file))) continue;
    // Lines in the new file that the old one does not have, counted with
    // multiplicity: a cheap stand-in for a diff that is exact for additions.
    const remaining = new Map<string, number>();
    for (const line of (old ?? "").split("\n")) remaining.set(line, (remaining.get(line) ?? 0) + 1);
    for (const line of text.split("\n")) {
      const left = remaining.get(line) ?? 0;
      if (left > 0) {
        remaining.set(line, left - 1);
        continue;
      }
      if (line.trim() === "") continue;
      linesAdded++;
      const trimmed = line.trim();
      const text = trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
      if (lines.length < MAX_LINES_SHOWN && !lines.some((l) => l.file === file && l.text === text)) lines.push({ file, text });
    }
  }
  let removed = 0;
  for (const file of before.keys()) if (!after.has(file)) removed++;
  return {
    added,
    files: { changed, added: addedFiles, removed },
    lines: linesAdded > 0 && linesAdded <= MAX_LINES_FOR_EXCERPT ? lines : undefined,
    linesAdded,
  };
}

/** Read both releases and compare them. */
export async function inspectRelease(before: PackagePin, after: PackagePin, options: ReleaseOptions): Promise<ReleaseComparison> {
  const [old, next] = await Promise.all([fetchNpmRelease(before, options), fetchNpmRelease(after, options)]);
  return compareReleases(old, next);
}

/* -------------------------------------------------------------- grading */

/**
 * Signals that make a release change critical (MK108): the kinds that fire on
 * no real release of the popular servers eval/releases.mjs reads. The rest
 * are shown to the reviewer as context.
 */
export const GRADED: ReadonlySet<SignalKind> = new Set<SignalKind>(["install-script", "hidden-recipient", "child-process", "eval", "decoded-string"]);

export function gradedSignals(comparison: ReleaseComparison): Signal[] {
  return comparison.added.filter((signal) => GRADED.has(signal.kind));
}
