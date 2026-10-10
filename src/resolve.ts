import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename } from "node:path";
import { integrity } from "./canonical.js";
import { expandEnv } from "./config.js";
import type { PackagePin, ServerSpec } from "./types.js";

/**
 * A package a launcher fetches and runs, read from a server's command line.
 * `requested` is what the config asks for: an exact version, a tag, a range,
 * or nothing, which means the newest release.
 */
export interface PackageRef {
  ecosystem: PackagePin["ecosystem"];
  name: string;
  requested?: string;
  /** For OCI images, a digest the config already pins. */
  digest?: string;
}

/** What resolving a server's package came to. */
export type Resolution =
  | { kind: "pinned"; pin: PackagePin }
  /** The command does not fetch a package mcpkeel knows how to read, such as a local binary. */
  | { kind: "none" }
  /** The package was found, but what it asks for cannot be pinned to one release. */
  | { kind: "unpinnable"; reason: string };

export interface ResolveOptions {
  timeoutMs: number;
  /** Base URLs, overridable for tests and private mirrors. */
  npmRegistry?: string;
  pypiUrl?: string;
}

/* ---------------------------------------------------------------- parsing */

const NPM_LAUNCHERS = new Set(["npx", "bunx"]);
/** Launchers that take a subcommand first, such as `pnpm dlx`. */
const NPM_SUBCOMMAND_LAUNCHERS: Record<string, string> = { pnpm: "dlx", yarn: "dlx" };
/** npx options that take a value in the next argument. */
const NPX_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--registry", "--cache", "--userconfig", "-w", "--workspace"]);
const UVX_VALUE_FLAGS = new Set(["--from", "--with", "--with-requirements", "--python", "-p", "--index", "--index-url", "--extra-index-url", "--default-index", "--constraint", "-c", "--override", "--cache-dir", "--directory", "--project", "--config-file"]);
const PIPX_VALUE_FLAGS = new Set(["--spec", "--python", "--pip-args", "--index-url"]);
/** `docker run` options that take a value in the next argument. Options of the form `--x=y` need no listing. */
const DOCKER_VALUE_FLAGS = new Set([
  "-e", "--env", "--env-file", "-v", "--volume", "--mount", "-p", "--publish", "--name", "--network", "--net",
  "-w", "--workdir", "-u", "--user", "--entrypoint", "--platform", "-l", "--label", "--label-file", "-h",
  "--hostname", "--add-host", "--cpus", "-m", "--memory", "--memory-swap", "--pull", "--restart", "--runtime",
  "--cap-add", "--cap-drop", "--device", "--dns", "--dns-search", "--dns-option", "--gpus", "--ipc", "--pid",
  "--log-driver", "--log-opt", "--security-opt", "--shm-size", "--stop-signal", "--stop-timeout", "--tmpfs",
  "--ulimit", "--uts", "--userns", "--group-add", "--cidfile", "--cgroup-parent", "--cgroupns", "--expose",
  "--health-cmd", "--health-interval", "--health-retries", "--health-timeout", "--health-start-period",
  "--isolation", "--link", "--mac-address", "--ip", "--ip6", "--network-alias", "--volumes-from", "--attach", "-a",
]);

/** The package a stdio server's command fetches, if it is one mcpkeel can resolve. */
export function packageRef(spec: ServerSpec): PackageRef | undefined {
  if (spec.transport !== "stdio" || !spec.command) return undefined;
  const program = basename(expandEnv(spec.command)).replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
  const args = (spec.args ?? []).map((arg) => expandEnv(arg));

  if (NPM_LAUNCHERS.has(program)) return npmRef(args);
  if (NPM_SUBCOMMAND_LAUNCHERS[program] && args[0] === NPM_SUBCOMMAND_LAUNCHERS[program]) return npmRef(args.slice(1));
  if (program === "npm" && (args[0] === "exec" || args[0] === "x")) return npmRef(args.slice(1));
  if (program === "uvx") return pypiRef(args, UVX_VALUE_FLAGS, "--from");
  if (program === "uv" && args[0] === "tool" && args[1] === "run") return pypiRef(args.slice(2), UVX_VALUE_FLAGS, "--from");
  if (program === "pipx" && args[0] === "run") return pypiRef(args.slice(1), PIPX_VALUE_FLAGS, "--spec");
  if ((program === "docker" || program === "podman") && args[0] === "run") return ociRef(args.slice(1));
  return undefined;
}

function npmRef(args: string[]): PackageRef | undefined {
  let named: string | undefined;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positional ??= args[i + 1];
      break;
    }
    if (arg.startsWith("--package=")) named ??= arg.slice("--package=".length);
    else if (arg === "-p" || arg === "--package") named ??= args[++i];
    else if (NPX_VALUE_FLAGS.has(arg)) i++;
    else if (arg.startsWith("-")) continue;
    else {
      positional = arg;
      break;
    }
  }
  const spec = named ?? positional;
  const local = /^[./~]|^(file|git|git\+[a-z]+|https?|link|workspace):/i.test(spec ?? "");
  const repoShorthand = (spec ?? "").includes("/") && !(spec ?? "").startsWith("@");
  if (!spec || local || repoShorthand) {
    return undefined;
  }
  const at = spec.indexOf("@", 1);
  return at === -1 ? { ecosystem: "npm", name: spec } : { ecosystem: "npm", name: spec.slice(0, at), requested: spec.slice(at + 1) || undefined };
}

function pypiRef(args: string[], valueFlags: Set<string>, fromFlag: string): PackageRef | undefined {
  let from: string | undefined;
  let positional: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === fromFlag) from = args[++i];
    else if (arg.startsWith(`${fromFlag}=`)) from = arg.slice(fromFlag.length + 1);
    else if (valueFlags.has(arg)) i++;
    else if (arg.startsWith("-")) continue;
    else {
      positional = arg;
      break;
    }
  }
  const spec = from ?? positional;
  if (!spec || /^[./~]|:\/\/|^git\+/i.test(spec)) return undefined;
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:(==|@)\s*([^\s;,]+)|([<>=!~].*))?$/.exec(spec);
  if (!match) return undefined;
  const name = match[1]!;
  if (match[3] && match[3] !== "latest") return { ecosystem: "pypi", name, requested: match[3] };
  if (match[4]) return { ecosystem: "pypi", name, requested: match[4].trim() };
  return { ecosystem: "pypi", name };
}

function ociRef(args: string[]): PackageRef | undefined {
  let image: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (DOCKER_VALUE_FLAGS.has(arg)) i++;
    else if (arg.startsWith("-")) continue;
    else {
      image = arg;
      break;
    }
  }
  if (!image) return undefined;
  const at = image.indexOf("@");
  const digest = at === -1 ? undefined : image.slice(at + 1);
  const withoutDigest = at === -1 ? image : image.slice(0, at);
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const hasTag = colon > slash;
  const name = hasTag ? withoutDigest.slice(0, colon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(colon + 1) : undefined;
  return { ecosystem: "oci", name, requested: tag, digest };
}

/* -------------------------------------------------------------- resolving */

export class ResolveError extends Error {}

/**
 * Find the release a launcher will run today and the registry's digest of it.
 * Every request refuses redirects: a registry answer is read only from the
 * host it was asked of.
 */
export async function resolvePackage(ref: PackageRef, options: ResolveOptions): Promise<Resolution> {
  if (ref.ecosystem === "npm") return resolveNpm(ref, options);
  if (ref.ecosystem === "pypi") return resolvePypi(ref, options);
  return resolveOci(ref, options);
}

async function resolveNpm(ref: PackageRef, options: ResolveOptions): Promise<Resolution> {
  const registry = (options.npmRegistry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
  const doc = (await getJson(`${registry}/${ref.name.replace("/", "%2f")}`, options, {
    accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
  })) as { "dist-tags"?: Record<string, string>; versions?: Record<string, { dist?: { integrity?: string; shasum?: string } }> };
  const versions = doc.versions ?? {};
  const wanted = ref.requested ?? "latest";
  const version = versions[wanted] ? wanted : doc["dist-tags"]?.[wanted];
  if (!version || !versions[version]) {
    return {
      kind: "unpinnable",
      reason: `${ref.name}@${wanted} is a range or an unknown tag, so the release that runs cannot be named. Pin an exact version.`,
    };
  }
  const dist = versions[version]!.dist ?? {};
  const digest = dist.integrity ?? (dist.shasum ? `sha1-${Buffer.from(dist.shasum, "hex").toString("base64")}` : undefined);
  if (!digest) throw new ResolveError(`the npm registry gave no digest for ${ref.name}@${version}`);
  return { kind: "pinned", pin: { ecosystem: "npm", name: ref.name, version, integrity: digest } };
}

async function resolvePypi(ref: PackageRef, options: ResolveOptions): Promise<Resolution> {
  const base = (options.pypiUrl ?? "https://pypi.org/pypi").replace(/\/+$/, "");
  if (ref.requested && !/^[A-Za-z0-9._+!-]+$/.test(ref.requested)) {
    return {
      kind: "unpinnable",
      reason: `${ref.name}${ref.requested} is a range, so the release that runs cannot be named. Pin an exact version with ==.`,
    };
  }
  const url = ref.requested ? `${base}/${encodeURIComponent(ref.name)}/${encodeURIComponent(ref.requested)}/json` : `${base}/${encodeURIComponent(ref.name)}/json`;
  const doc = (await getJson(url, options)) as { info?: { version?: string }; urls?: { filename?: string; digests?: { sha256?: string } }[] };
  const version = doc.info?.version;
  const files = (doc.urls ?? [])
    .filter((file) => file.filename && file.digests?.sha256)
    .map((file) => ({ filename: file.filename!, sha256: file.digests!.sha256! }))
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  if (!version || files.length === 0) throw new ResolveError(`PyPI gave no files for ${ref.name}${ref.requested ? `==${ref.requested}` : ""}`);
  // A release can have several files (a wheel per platform, an sdist). The pin
  // covers all of them, so a file added or replaced later changes it.
  return { kind: "pinned", pin: { ecosystem: "pypi", name: ref.name, version, integrity: integrity(files) } };
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function resolveOci(ref: PackageRef, options: ResolveOptions): Promise<Resolution> {
  const tag = ref.requested ?? "latest";
  if (ref.digest) {
    // The config already names the exact image. Nothing to look up.
    return { kind: "pinned", pin: { ecosystem: "oci", name: ref.name, version: ref.requested ?? "", integrity: ref.digest } };
  }
  const { registry, repository } = splitImage(ref.name);
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(registry) ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/manifests/${encodeURIComponent(tag)}`;

  let response = await request(url, options, { method: "HEAD", headers: { accept: MANIFEST_TYPES } });
  if (response.status === 401) {
    const token = await bearerToken(response.headers.get("www-authenticate"), repository, options);
    response = await request(url, options, { method: "HEAD", headers: { accept: MANIFEST_TYPES, authorization: `Bearer ${token}` } });
  }
  if (!response.ok) throw new ResolveError(`${registry} answered ${response.status} for ${ref.name}:${tag}`);
  const digest = response.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new ResolveError(`${registry} gave no digest for ${ref.name}:${tag}`);
  return { kind: "pinned", pin: { ecosystem: "oci", name: ref.name, version: tag, integrity: digest } };
}

/** `ghcr.io/org/app` → ghcr.io + org/app. `node` → Docker Hub + library/node. */
export function splitImage(name: string): { registry: string; repository: string } {
  const first = name.split("/")[0]!;
  const isRegistry = name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (isRegistry) return { registry: first, repository: name.slice(first.length + 1) };
  const repository = name.includes("/") ? name : `library/${name}`;
  return { registry: "registry-1.docker.io", repository };
}

/** An anonymous pull token, as registries hand out from the realm named in their 401. */
async function bearerToken(challenge: string | null, repository: string, options: ResolveOptions): Promise<string> {
  const params = Object.fromEntries([...(challenge ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
  if (!params.realm || !/^bearer\b/i.test(challenge ?? "")) throw new ResolveError("the image registry asked for credentials mcpkeel does not have");
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set("service", params.service);
  url.searchParams.set("scope", params.scope ?? `repository:${repository}:pull`);
  const doc = (await getJson(url.toString(), options)) as { token?: string; access_token?: string };
  const token = doc.token ?? doc.access_token;
  if (!token) throw new ResolveError("the image registry gave no pull token");
  return token;
}

async function getJson(url: string, options: ResolveOptions, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await request(url, options, { headers: { accept: "application/json", ...headers } });
  if (response.status === 404) throw new ResolveError(`not found: ${url}`);
  if (!response.ok) throw new ResolveError(`${new URL(url).host} answered ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new ResolveError(`${new URL(url).host} sent a response that is not JSON`);
  }
}

async function request(url: string, options: ResolveOptions, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs) });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new ResolveError(`could not reach ${new URL(url).host}: ${cause ?? (err as Error).message}`);
  }
}

/* ------------------------------------------------------- network guard */

/**
 * Addresses a config must never point mcpkeel at: link-local ranges, where
 * cloud providers serve instance credentials, and the metadata endpoints that
 * sit outside them. On a CI runner, a request there can hand out the
 * runner's cloud identity.
 */
export function isMetadataAddress(address: string): boolean {
  const v4 = isIP(address) === 4 ? address : /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (v4) {
    const [a, b] = v4.split(".").map(Number);
    return (a === 169 && b === 254) || v4 === "100.100.100.200";
  }
  const v6 = address.toLowerCase();
  return /^fe[89ab][0-9a-f]:/.test(v6) || v6 === "fd00:ec2::254";
}

/** Refuse a remote server whose host is, or resolves to, a metadata address. */
export async function assertSafeHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
  const bad = addresses.find(isMetadataAddress);
  if (bad) {
    throw new Error(`refused: ${url.hostname} resolves to ${bad}, a link-local or cloud metadata address`);
  }
}

/** `fetch` for remote MCP servers: the same, except that a redirect is an error rather than followed. */
export const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });
