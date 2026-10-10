#!/usr/bin/env node
// Measures mcpkeel's built-in checks on the MCPTox benchmark: how many of its
// poisoned tool descriptions they flag, and how many of the real tools of the
// same 45 servers they flag by mistake.
//
// The benchmark's data is downloaded at a pinned commit and checked against a
// known digest, into eval/.cache. It is not part of this repository; only the
// numbers this script derives are.
//
//   npm run build && node eval/mcptox.mjs [--write]
//
// --write saves the summary to eval/results/mcptox.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffLockfiles, scanServer } from "../dist/diff.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cache = join(here, ".cache", "mcptox");
const REPOSITORY = "zhiqiangwang4/MCPTox-Benchmark";
const COMMIT = "f85189f9ad12504c197c7f920ab818a40657b1fa";
const FILES = {
  "pure_tool.json": "54b1eb0e9d7b2f18465266aa9d9dfda828cd558b1269b74731ec2c5d8579e617",
  "response_all.json": "79a90049be931c59e71446d6180b1d7f0d196d123d08a59bc155d142b5041c03",
};

async function fetchPinned(name, digest) {
  const path = join(cache, name);
  if (!existsSync(path)) {
    mkdirSync(cache, { recursive: true });
    const url = `https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}/${name}`;
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest) throw new Error(`${name}: expected sha256 ${digest}, got ${actual}. Delete ${path} to download it again.`);
  return JSON.parse(bytes.toString("utf8"));
}

/** A tool as mcpkeel pins it: a description and a schema with each argument's description. */
function toolEntry(description, args = []) {
  const properties = Object.fromEntries(args.map(({ name, description: text }) => [name, text ? { type: "string", description: text } : { type: "string" }]));
  return { integrity: "", description, inputSchema: { type: "object", properties } };
}

/** The benchmark gives each server's real tools as the system prompt an agent saw: "Tool: …", "Description: …", "Arguments: - name: …". */
function parseCleanTools(prompt) {
  const tools = [];
  for (const block of prompt.split(/\n(?=Tool: )/).slice(1)) {
    const name = /^Tool: (.+)$/m.exec(block)?.[1]?.trim();
    const description = /^Description: ([\s\S]*?)(?:\nArguments:|$)/m.exec(block)?.[1]?.trim() ?? "";
    const args = [...block.matchAll(/^- ([^:\n]+): (.*?)(?: \((?:required|optional)\))?$/gm)].map((m) => ({
      name: m[1].trim(),
      description: m[2].trim() === "No description" ? "" : m[2].trim(),
    }));
    if (name) tools.push({ name, entry: toolEntry(description, args) });
  }
  return tools;
}

/** The ids of the built-in checks that fire on one tool, the way `mcpkeel init` reads a server. */
function checks(entry) {
  const hits = scanServer({ transport: "stdio", source: {}, integrity: "", tools: { t: entry } });
  return [...new Set(hits.flatMap((hit) => hit.flags.map((flag) => flag.id)))].sort();
}

const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);

function tally(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row[key]) ?? { total: 0, flagged: 0 };
    group.total++;
    if (row.checks.length) group.flagged++;
    groups.set(row[key], group);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, g]) => [name, { ...g, rate: pct(g.flagged, g.total) }]));
}

const poisoned = await fetchPinned("pure_tool.json", FILES["pure_tool.json"]);
const responses = await fetchPinned("response_all.json", FILES["response_all.json"]);

const cleanTools = new Map(Object.values(responses.servers).map((server) => [server.server_name, parseCleanTools(server.clean_system_promot)]));
const lockOf = (tools) => ({ lockfileVersion: 1, servers: { s: { transport: "stdio", source: {}, integrity: "", tools } } });

/**
 * The way mcpkeel meets a poisoned tool in use: the server was pinned with its
 * real tools, and the poisoned one appears later. Returns the most severe
 * change `verify` reports for it, or undefined if it reports none.
 */
function drift(serverName, toolName, entry) {
  const pinned = Object.fromEntries((cleanTools.get(serverName) ?? []).map(({ name, entry: e }) => [name, e]));
  const changes = diffLockfiles(lockOf(pinned), lockOf({ ...pinned, [toolName]: entry }));
  return ["critical", "high", "medium", "low"].find((level) => changes.some((change) => change.severity === level));
}

const attacks = poisoned.flatMap((server) =>
  Object.values(server).map((tool) => {
    const entry = toolEntry(tool.tool_content.trim());
    return {
      server: tool.server_name,
      paradigm: tool.paradigm,
      risk: tool["security risk"],
      checks: checks(entry),
      drift: drift(tool.server_name, tool.tool_name, entry),
    };
  }),
);
const benign = [...cleanTools].flatMap(([server, tools]) => tools.map(({ name, entry }) => ({ server, tool: name, checks: checks(entry) })));

const flaggedAttacks = attacks.filter((row) => row.checks.length).length;
const reportedHigh = attacks.filter((row) => row.drift === "critical" || row.drift === "high").length;
const reportedCritical = attacks.filter((row) => row.drift === "critical").length;
const flaggedBenign = benign.filter((row) => row.checks.length);
const byCheck = {};
for (const row of attacks) for (const id of row.checks) byCheck[id] = (byCheck[id] ?? 0) + 1;

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const summary = {
  benchmark: { name: "MCPTox", repository: `https://github.com/${REPOSITORY}`, commit: COMMIT, files: FILES },
  mcpkeel: version,
  what: "Built-in checks only, no model review. `flagged`: a check fires on the tool as `mcpkeel init` reads it. `drift`: the server is pinned with its real tools and the poisoned tool then appears, as `mcpkeel verify` sees it.",
  attacks: {
    total: attacks.length,
    drift: { reportedAtHighOrAbove: reportedHigh, critical: reportedCritical, rate: pct(reportedHigh, attacks.length) },
    flagged: flaggedAttacks, rate: pct(flaggedAttacks, attacks.length), byTemplate: tally(attacks, "paradigm"), byRisk: tally(attacks, "risk"), byCheck },
  benign: {
    total: benign.length,
    flagged: flaggedBenign.length,
    rate: pct(flaggedBenign.length, benign.length),
    // Names only: the benchmark's text stays in the benchmark.
    flaggedTools: flaggedBenign.map((row) => ({ server: row.server, tool: row.tool, checks: row.checks })),
  },
};

const line = (label, part, whole) => `${label.padEnd(28)} ${String(part).padStart(4)} / ${String(whole).padEnd(4)} ${pct(part, whole).toFixed(1).padStart(5)}%`;
console.log(`MCPTox at ${COMMIT.slice(0, 7)}, mcpkeel ${version}, built-in checks only\n`);
console.log(line("Poisoned tools as drift ≥ high", reportedHigh, attacks.length));
console.log(line("  of which critical", reportedCritical, attacks.length));
console.log(line("Poisoned tools flagged", flaggedAttacks, attacks.length));
for (const [name, g] of Object.entries(summary.attacks.byTemplate)) console.log(line(`  ${name}`, g.flagged, g.total));
console.log(line("Real tools flagged", flaggedBenign.length, benign.length));
console.log("\nBy risk category:");
for (const [name, g] of Object.entries(summary.attacks.byRisk)) console.log(line(`  ${name}`, g.flagged, g.total));
console.log("\nChecks that fired on poisoned tools:");
for (const [id, count] of Object.entries(byCheck).sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(26)} ${count}`);
if (flaggedBenign.length) {
  console.log("\nReal tools flagged:");
  for (const row of flaggedBenign) console.log(`  ${row.server} / ${row.tool}: ${row.checks.join(", ")}`);
}

if (process.argv.includes("--write")) {
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", "mcptox.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\nWrote eval/results/mcptox.json");
}
