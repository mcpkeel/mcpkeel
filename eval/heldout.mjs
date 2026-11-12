#!/usr/bin/env node
// Measures the release diff on releases it was not tuned on: every stable
// release of the eval's 14 servers published after the cutoff frozen in
// eval/data/heldout.json, compared with the release before it.
//
//   npm run build && node eval/heldout.mjs [--write]
//
// It refuses to run when the graded signals or src/release.ts differ from
// what was frozen, since a number measured with a detector changed after the
// freeze is in-sample again. --allow-changed runs anyway and labels the result.
// Not run in CI: the set grows as servers publish, and it needs the network.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GRADED, compareReleases, gradedSignals } from "../dist/release.js";
import { packument, release, stableVersions } from "./lib/npm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { values: args } = parseArgs({ options: { write: { type: "boolean" }, "allow-changed": { type: "boolean" } } });

const frozen = JSON.parse(readFileSync(join(here, "data", "heldout.json"), "utf8"));
const inSample = JSON.parse(readFileSync(join(here, "data", "npm-releases.json"), "utf8"));

/* ------------------------------------------------- is it still frozen? */

const changed = [];
const graded = [...GRADED].sort();
if (JSON.stringify(graded) !== JSON.stringify(frozen.graded)) changed.push(`graded signals are ${graded.join(", ")}, frozen ${frozen.graded.join(", ")}`);
const detectorSha = createHash("sha256").update(readFileSync(join(root, frozen.detector.file))).digest("hex");
if (detectorSha !== frozen.detector.sha256) changed.push(`${frozen.detector.file} changed since the freeze`);
if (changed.length && !args["allow-changed"]) {
  console.error(`Not held out any more: ${changed.join("; ")}.\nMeasure from commit ${frozen.commit.slice(0, 7)}, or pass --allow-changed to label the result.`);
  process.exit(1);
}

/* ---------------------------------------------------------- the pairs */

const known = new Map(inSample.packages.map((p) => [p.name, new Set(p.versions.map((v) => v.version))]));
const cutoff = Date.parse(frozen.cutoff);
const pairs = [];
for (const name of frozen.packages) {
  const doc = await packument(name);
  const stable = stableVersions(doc);
  for (let i = 1; i < stable.length; i++) {
    const to = stable[i];
    if (Date.parse(doc.time[to]) <= cutoff || known.get(name)?.has(to)) continue;
    const from = stable[i - 1];
    const comparison = compareReleases(
      await release(name, from, doc.versions[from].dist.integrity),
      await release(name, to, doc.versions[to].dist.integrity),
    );
    const hits = gradedSignals(comparison);
    pairs.push({ name, from, to, published: doc.time[to], critical: hits.length > 0, graded: [...new Set(hits.map((s) => s.kind))].sort() });
  }
}

/* -------------------------------------------------------- the numbers */

const critical = pairs.filter((p) => p.critical);
const result = {
  what: "The release diff on releases published after the freeze in eval/data/heldout.json. `critical`: a graded signal fired on a real release, a false positive.",
  measured: new Date().toISOString(),
  mcpkeel: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
  heldOut: changed.length === 0,
  changedSinceFreeze: changed.length ? changed : undefined,
  pairs: pairs.length,
  critical: critical.length,
  servers: new Set(pairs.map((p) => p.name)).size,
  list: pairs,
};

console.log(`Held-out release pairs since ${frozen.cutoff}: ${pairs.length}, from ${result.servers} of ${frozen.packages.length} servers`);
for (const p of pairs) console.log(`  ${p.critical ? "CRITICAL" : "ok      "} ${p.name} ${p.from} → ${p.to}${p.graded.length ? `  (${p.graded.join(", ")})` : ""}`);
console.log(`\nGraded critical: ${critical.length} of ${pairs.length}${changed.length ? "  [NOT held out: detector changed since the freeze]" : ""}`);

if (args.write) {
  const out = join(here, "results", "heldout.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log("Wrote eval/results/heldout.json");
}
