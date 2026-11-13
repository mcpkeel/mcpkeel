#!/usr/bin/env node
// Builds eval/data/npm-releases.json: the last stable releases of popular MCP
// servers on npm, each with the registry's digest, for eval/releases.mjs.
//
//   node eval/build-release-set.mjs
//
// Consecutive releases of real servers are the benign side of the release
// eval: a signal that fires on them is noise, however good it sounds. The
// digests are pinned here, so the eval later reads exactly these archives.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REGISTRY = "https://registry.npmjs.org";
const PER_PACKAGE = 8;

// Widely installed MCP servers, from the canary's set and the most used
// third-party ones.
const PACKAGES = [
  "@modelcontextprotocol/server-filesystem",
  "@modelcontextprotocol/server-memory",
  "@modelcontextprotocol/server-everything",
  "@modelcontextprotocol/server-sequential-thinking",
  "@playwright/mcp",
  "@upstash/context7-mcp",
  "@notionhq/notion-mcp-server",
  "@supabase/mcp-server-supabase",
  "firecrawl-mcp",
  "tavily-mcp",
  "@sentry/mcp-server",
  "exa-mcp-server",
  "@heroku/mcp-server",
  "mcp-remote",
];

const out = [];
for (const name of PACKAGES) {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, { redirect: "error" });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const doc = await response.json();
  const stable = Object.keys(doc.versions ?? {})
    .filter((v) => !v.includes("-") && doc.versions[v].dist?.integrity && doc.time?.[v])
    .sort((a, b) => (doc.time[a] < doc.time[b] ? -1 : 1))
    .slice(-PER_PACKAGE);
  out.push({ name, versions: stable.map((version) => ({ version, integrity: doc.versions[version].dist.integrity })) });
  console.log(`${name}: ${stable.join(", ")}`);
}

const data = {
  what: "The last stable releases of popular MCP servers on npm, oldest first, with the registry's digest of each. Consecutive releases form the benign pairs of eval/releases.mjs.",
  built: new Date().toISOString().slice(0, 10),
  packages: out,
};
writeFileSync(join(here, "data", "npm-releases.json"), `${JSON.stringify(data, null, 2)}\n`);
console.log(`${out.reduce((n, p) => n + Math.max(0, p.versions.length - 1), 0)} pairs`);
