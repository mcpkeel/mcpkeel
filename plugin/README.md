# mcpkeel for Claude Code and Codex

An MCP server can change the tool descriptions your agent trusts, or ship new code under the same name, at any time. [mcpkeel](https://github.com/mcpkeel/mcpkeel) pins what a project's MCP servers tell the agent in `mcp.lock`, a file committed to the repository. This plugin checks the project's servers against that file when a session starts, and holds back calls to a server that no longer matches it, until the change has been reviewed.

## What it does

- **When a session starts**, it runs `mcpkeel verify` in the project. If a server changed since `mcp.lock` was written, you see which one and how severe the change is, and the agent is told not to trust that server's tool descriptions. The agent is never handed the changed text itself.
- **When the agent calls a tool** of a server that changed, Claude Code asks you first. You can set it to block the call instead, or only to warn. In Codex, which cannot ask, the call is blocked.
- **Quarantine**, if you choose it, also keeps a changed server from starting in new sessions, so the agent never reads its tool descriptions. See [Quarantine](#quarantine).
- **`/mcpkeel:verify`** checks again. **`/mcpkeel:review`** shows what changed, with the server's text marked as data, and accepts it into `mcp.lock` only when you say so.

A project without `mcp.lock`, and servers the lockfile does not cover, are left alone. To start using mcpkeel in a project, run `npx mcpkeel init` and commit the `mcp.lock` it writes.

## Install

Claude Code:

```
/plugin install mcpkeel --marketplace mcpkeel/mcpkeel
```

Codex: `codex plugin marketplace add mcpkeel/mcpkeel`, then install mcpkeel from `/plugins`.

## Settings

In Claude Code, `/plugin configure mcpkeel@mcpkeel`. In Codex, the same settings are environment variables.

| Setting | Codex variable | Values | Default |
| --- | --- | --- | --- |
| When a server changed | `MCPKEEL_ON_DRIFT` | `ask`, `deny`, `warn`, `quarantine` | `ask` (`deny` in Codex) |
| When a server could not be checked | `MCPKEEL_ON_UNVERIFIED` | `allow`, `ask`, `deny` | `allow` |
| Lowest severity that counts | `MCPKEEL_FAIL_ON` | `critical`, `high`, `medium`, `low` | `low` |
| Per-server timeout in seconds | `MCPKEEL_TIMEOUT` | 5 to 120 | `20` |

## Quarantine

Blocking a call does not keep the agent from reading the changed server's tool descriptions: the server is running, and its tools are listed. In mcpkeel's agent eval, agents still read the planted secret in 40 of 80 sessions with calls blocked, though none sent it anywhere.

With `quarantine`, the plugin also adds a changed server to `disabledMcpjsonServers` in the project's `.claude/settings.local.json`. Claude Code does not start a server listed there, so from the next session on the agent never sees it. When a later check finds the server matches `mcp.lock` again, for example after you accept the change with `/mcpkeel:review` and run `/mcpkeel:verify`, the plugin removes the entry, and the server starts again from the next session.

- **It takes effect from the next session.** Claude Code reads the setting when a session starts, and the check runs as it starts, so in the session that finds the change the server is already running, and its calls are denied. To keep a changed server from reaching the agent at all, run `mcpkeel verify` in CI, or before you start a session.
- **It covers servers in the project's `.mcp.json`.** That is what the setting lists. A changed server from another config is denied in the session, and not quarantined.
- **It removes only what it added.** A server you listed there yourself stays listed. If the settings file is not valid JSON, the plugin leaves it alone and says so.
- **Codex has no such setting**, so there `quarantine` blocks the call, like `deny`.

## What it runs, reads, writes and contacts

Everything the plugin does is listed here.

- **It runs mcpkeel**, the version pinned in this plugin's `package-lock.json`, which Claude Code installs with the plugin from the npm registry. If that copy is missing, it uses a copy the project installed, and otherwise runs the same pinned version with `npx`. The Codex skills run it with `npx` at that version.
- **mcpkeel starts the MCP servers in the project's config** to read their definitions, the same servers the agent itself starts. For servers launched through `npx`, `uvx`, `pipx` or `docker`, it asks the npm registry, PyPI or the image's registry which release will run.
- **It reads** the project's MCP config and `mcp.lock`.
- **It writes** one small record per project, with each server's name, status, severity and change codes, to the plugin's data directory, which is private to your user. That record is what the tool-call check reads. It writes to your project in two cases only: when you accept a change with `/mcpkeel:review`, which updates `mcp.lock`, and, with `quarantine` set, to add or remove a changed server in `.claude/settings.local.json`.
- **It sends nothing anywhere else.** There is no telemetry and no account. The optional model review in mcpkeel (`--explain`) is not used by this plugin.

## How the checks are kept honest

- The agent is told which servers changed, with severities and codes, and never their changed text, because that text is what is under suspicion.
- `/mcpkeel:review` shows the changed text wrapped in a tag with a random id, so the text cannot pose as the end of the data.
- If the plugin's record could have been written by another account, the tool-call check refuses MCP calls rather than trust it.

Source, tests and documentation: [github.com/mcpkeel/mcpkeel](https://github.com/mcpkeel/mcpkeel). Questions and reports: [issues](https://github.com/mcpkeel/mcpkeel/issues) or hello@mcpkeel.app. MIT licensed.
