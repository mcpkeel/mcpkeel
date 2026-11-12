import type { Metadata } from "next";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What mcpkeel, its GitHub Action, its plugins for Claude Code and Codex, and this website collect: nothing about you.",
  alternates: { canonical: "/privacy" },
};

export default function Privacy() {
  return (
    <main id="main" className="wrap page">
      <h1>Privacy</h1>
      <p className="lede">mcpkeel collects nothing about you. It has no account, no telemetry and no server of its own.</p>
      <p className="fine">
        Last updated 2026-11-12. This page covers the mcpkeel command-line tool, its GitHub Action, its plugins for Claude Code and Codex, and this
        website.
      </p>

      <h2>The command-line tool</h2>
      <ul className="plain">
        <li>
          It runs on your machine or in your CI. It reads your MCP config and <code>mcp.lock</code>, and writes <code>mcp.lock</code> and the reports
          you ask for.
        </li>
        <li>It starts the MCP servers in your config, or connects to the remote ones, to read what they tell an agent.</li>
        <li>
          For servers started through <code>npx</code>, <code>uvx</code>, <code>pipx</code> or <code>docker</code>, it asks the npm registry, PyPI or
          the image&apos;s registry which release will run. <code>--no-resolve</code> turns this off.
        </li>
        <li>
          When an npm package&apos;s release changed, it downloads the old and the new release from the same registry, to read what the new code adds.
          Nothing in them is run or saved. <code>--no-release-diff</code> or <code>--no-resolve</code> turns this off.
        </li>
        <li>
          Only with <code>--explain</code>, it sends the changed tool definitions, and nothing else, to the review endpoint you choose, with the key you
          provide. Your config, environment values and headers are never sent.
        </li>
        <li>It does not send anything to the mcpkeel project.</li>
      </ul>

      <h2>The GitHub Action</h2>
      <ul className="plain">
        <li>
          It runs the same tool inside your own workflow, on GitHub&apos;s runners or yours. What it reads, writes and contacts is the same as above,
          plus the job summary and the pull requests it opens in your repository.
        </li>
      </ul>

      <h2>The plugins for Claude Code and Codex</h2>
      <ul className="plain">
        <li>
          They run the same tool on your machine when a session starts, and keep one small record per project, with each server&apos;s name, status
          and change codes, in the plugin&apos;s data directory on your machine.
        </li>
        <li>
          With the <code>quarantine</code> setting, the Claude Code plugin also adds a changed server to, and later removes it from, the project&apos;s
          <code>.claude/settings.local.json</code>, a file on your machine.
        </li>
        <li>They do not use the model review and send nothing beyond what the tool itself contacts.</li>
      </ul>

      <h2>This website</h2>
      <ul className="plain">
        <li>
          It has no cookies, no analytics and no third-party scripts or fonts. It is served by Cloudflare, which processes requests to deliver it, as
          any host does.
        </li>
        <li>The drift feed page reads its data from GitHub on Cloudflare&apos;s side. Your browser only contacts mcpkeel.app.</li>
      </ul>

      <h2>Contact</h2>
      <p>
        Questions about privacy: <a href={`mailto:${SITE.email}`}>{SITE.email}</a>.
      </p>
    </main>
  );
}
