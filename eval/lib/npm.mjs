// Downloads an npm release once, checks it against its digest, and caches it
// in eval/.cache/npm. Shared by eval/releases.mjs and eval/heldout.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTarball, verifyIntegrity } from "../../dist/release.js";

export const REGISTRY = "https://registry.npmjs.org";
const cache = join(dirname(fileURLToPath(import.meta.url)), "..", ".cache", "npm");

/** The files of name@version, after its archive matched `integrity`. */
export async function release(name, version, integrity) {
  const file = join(cache, `${name.replace("/", "__")}-${version}.tgz`);
  let bytes;
  if (existsSync(file)) bytes = readFileSync(file);
  else {
    const base = name.includes("/") ? name.split("/")[1] : name;
    const response = await fetch(`${REGISTRY}/${name}/-/${base}-${version}.tgz`, { redirect: "error" });
    if (!response.ok) throw new Error(`${name}@${version}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(cache, { recursive: true });
    writeFileSync(file, bytes);
  }
  verifyIntegrity(bytes, integrity, `${name}@${version}`);
  return readTarball(bytes);
}

/** The registry document of a package: versions, digests and publish times. */
export async function packument(name) {
  const response = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, { redirect: "error" });
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return response.json();
}

/** Stable versions with a digest and a publish time, oldest first. */
export function stableVersions(doc) {
  return Object.keys(doc.versions ?? {})
    .filter((v) => !v.includes("-") && doc.versions[v].dist?.integrity && doc.time?.[v])
    .sort((a, b) => (doc.time[a] < doc.time[b] ? -1 : 1));
}
