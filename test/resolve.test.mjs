import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { isMetadataAddress, packageRef, resolvePackage, splitImage } from "../dist/resolve.js";

const stdio = (command, args) => ({ name: "s", transport: "stdio", command, args });

test("package launchers are read from the command line", () => {
  const cases = [
    [stdio("npx", ["-y", "@modelcontextprotocol/server-memory@2026.8.31"]), { ecosystem: "npm", name: "@modelcontextprotocol/server-memory", requested: "2026.8.31" }],
    [stdio("npx", ["--yes", "--package=demo@1.2.3", "demo-cli", "--flag"]), { ecosystem: "npm", name: "demo", requested: "1.2.3" }],
    [stdio("/usr/local/bin/npx.cmd", ["demo"]), { ecosystem: "npm", name: "demo" }],
    [stdio("pnpm", ["dlx", "demo@latest"]), { ecosystem: "npm", name: "demo", requested: "latest" }],
    [stdio("uvx", ["mcp-server-fetch==2025.4.7"]), { ecosystem: "pypi", name: "mcp-server-fetch", requested: "2025.4.7" }],
    [stdio("uvx", ["--from", "mcp-server-git>=1.0", "mcp-server-git"]), { ecosystem: "pypi", name: "mcp-server-git", requested: ">=1.0" }],
    [stdio("uvx", ["--python", "3.12", "demo[extra]@latest"]), { ecosystem: "pypi", name: "demo" }],
    [stdio("pipx", ["run", "demo==1.0"]), { ecosystem: "pypi", name: "demo", requested: "1.0" }],
    [stdio("docker", ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/org/server:1.4"]), { ecosystem: "oci", name: "ghcr.io/org/server", requested: "1.4", digest: undefined }],
    [stdio("docker", ["run", "--rm", "mcp/fetch@sha256:" + "a".repeat(64)]), { ecosystem: "oci", name: "mcp/fetch", requested: undefined, digest: "sha256:" + "a".repeat(64) }],
  ];
  for (const [spec, expected] of cases) assert.deepEqual(packageRef(spec), expected, JSON.stringify(spec.args));
});

test("commands that do not fetch a package are left alone", () => {
  for (const spec of [
    stdio("node", ["server.js"]),
    stdio("npx", ["./local-server"]),
    stdio("npx", ["github:org/repo"]),
    stdio("npx", ["org/repo"]),
    stdio("uvx", ["--from", "git+https://example.com/repo", "tool"]),
    stdio("docker", ["ps"]),
    { name: "r", transport: "http", url: "https://example.com/mcp" },
  ]) {
    assert.equal(packageRef(spec), undefined, JSON.stringify(spec));
  }
});

test("image names map to their registry", () => {
  assert.deepEqual(splitImage("node"), { registry: "registry-1.docker.io", repository: "library/node" });
  assert.deepEqual(splitImage("mcp/fetch"), { registry: "registry-1.docker.io", repository: "mcp/fetch" });
  assert.deepEqual(splitImage("ghcr.io/org/app"), { registry: "ghcr.io", repository: "org/app" });
  assert.deepEqual(splitImage("localhost:5000/app"), { registry: "localhost:5000", repository: "app" });
});

test("metadata and link-local addresses are recognised, ordinary ones are not", () => {
  for (const address of ["169.254.169.254", "169.254.0.1", "::ffff:169.254.169.254", "fe80::1", "fd00:ec2::254", "100.100.100.200"]) {
    assert.ok(isMetadataAddress(address), address);
  }
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "8.8.8.8", "::1", "2001:db8::1"]) {
    assert.ok(!isMetadataAddress(address), address);
  }
});

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `127.0.0.1:${server.address().port}`;
}

test("a PyPI release is pinned over all of its files", async (t) => {
  const files = [
    { filename: "demo-1.0-py3-none-any.whl", digests: { sha256: "1".repeat(64) } },
    { filename: "demo-1.0.tar.gz", digests: { sha256: "2".repeat(64) } },
  ];
  const host = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ info: { version: "1.0" }, urls: req.url.includes("swapped") ? [...files].reverse() : files }));
  });
  const options = { timeoutMs: 5000, pypiUrl: `http://${host}` };
  const pinned = await resolvePackage({ ecosystem: "pypi", name: "demo", requested: "1.0" }, options);
  assert.equal(pinned.kind, "pinned");
  assert.equal(pinned.pin.version, "1.0");
  // File order from the index does not matter.
  const swapped = await resolvePackage({ ecosystem: "pypi", name: "swapped" }, options);
  assert.equal(swapped.pin.integrity, pinned.pin.integrity);
  const range = await resolvePackage({ ecosystem: "pypi", name: "demo", requested: ">=1.0" }, options);
  assert.equal(range.kind, "unpinnable");
});

test("an image tag is pinned to the digest the registry gives, with an anonymous token when asked", async (t) => {
  const digest = "sha256:" + "c".repeat(64);
  let host;
  host = await serve(t, (req, res) => {
    if (req.url.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "anon" }));
    }
    if (req.headers.authorization !== "Bearer anon") {
      res.writeHead(401, { "www-authenticate": `Bearer realm="http://${host}/token",service="test",scope="repository:app:pull"` });
      return res.end();
    }
    assert.equal(req.method, "HEAD");
    assert.equal(req.url, "/v2/app/manifests/1.4");
    res.writeHead(200, { "docker-content-digest": digest });
    res.end();
  });
  const result = await resolvePackage({ ecosystem: "oci", name: `localhost:${host.split(":")[1]}/app`, requested: "1.4" }, { timeoutMs: 5000 });
  assert.deepEqual(result, { kind: "pinned", pin: { ecosystem: "oci", name: `localhost:${host.split(":")[1]}/app`, version: "1.4", integrity: digest } });
});

test("a registry that redirects is not followed", async (t) => {
  const host = await serve(t, (req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  await assert.rejects(resolvePackage({ ecosystem: "npm", name: "demo" }, { timeoutMs: 5000, npmRegistry: `http://${host}` }), /could not reach/);
});
