// Facts about the site and the project that more than one page uses.

export const SITE = {
  url: "https://mcpkeel.app",
  description:
    "An MCP server can rewrite the tool descriptions your agent trusts, or ship new code under the same name. mcpkeel pins both in mcp.lock and fails the build when they change.",
  repo: "https://github.com/mcpkeel/mcpkeel",
  npm: "https://www.npmjs.com/package/mcpkeel",
  example: "https://github.com/mcpkeel/mcpkeel-example",
  evidence: "https://github.com/mcpkeel/mcpkeel/blob/main/docs/EVIDENCE.md",
  measured: "https://github.com/mcpkeel/mcpkeel#measured",
  agentEval: "https://github.com/mcpkeel/mcpkeel#agents-in-real-sessions",
  email: "hello@mcpkeel.app",
  version: "0.6.0",
  // The day that version was published to npm. Update with the version.
  released: "2026-11-11",
  releases: "https://github.com/mcpkeel/mcpkeel/releases",
} as const;
