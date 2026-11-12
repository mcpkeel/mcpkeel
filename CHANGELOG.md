# Changelog

## Unreleased

### Fixed

- `--explain --provider openai` works with OpenAI reasoning models, such as GPT-5 and later on OpenAI or Azure, which accept only the default temperature. The review asks for temperature 0 and, when the endpoint rejects it, asks again without it.

## 0.6.0

### Added

- When an npm package's release changes, `verify` reads the old and the new release and reports what the new one adds: install scripts, hidden (BCC) recipients, `child_process`, `eval`, decoded strings, new email addresses, hosts, IP addresses, dependencies and `new Function`, each with its file and line, and the added lines themselves when there are 40 or fewer. The first five make the change critical, as `MK108`. It is the check that would have caught `postmark-mcp` 1.0.16, whose one added line copied every email to an outside address.
- `eval/releases.mjs` measures it on 98 real consecutive releases of 14 popular MCP servers and on 154 releases with one malicious change injected. No real release is graded critical; 95 of the injected ones are, including all 42 versions of the `postmark-mcp` BCC and its two evasions. CI runs it with `--check`.
- `--no-release-diff` turns the reading off. `mcpkeel diff <old> <new>` stays offline unless given `--release-diff`; the GitHub Action's `update-pr` mode passes it when its `version` has it, so the pull request shows what each new release adds.

### Security

- The archives are read only from the registry that was asked, checked against their pinned digests before they are read, and unpacked in memory within fixed limits on size and entries. Nothing in a package is run or written to disk.

## 0.5.0

### Added

- `--explain` reports what the review cost: requests, input and output tokens as the endpoint reported them, and time. In the terminal and the Markdown report as one line, and in `--json` under `review`.
- `eval/explain.mjs` measures `--explain` on the 485 MCPTox poisoned tools, 30 rug pulls written to read like routine releases, and 83 real changes from the drift canary. With Claude Haiku 5.5 as the reviewer, 99.8% of the poisoned tools are graded critical (10.3% with the built-in checks alone), no attack is lowered, and no real change is raised to critical, at $0.08 per 1,000 changes at list price. The models were reached through a proxy, which reported the token counts; `docs/EVIDENCE.md` says how each run was made. The README has the table and its limits.
- CI runs the same eval with a judge that is always wrong, and fails if mcpkeel's limits on lowering let more attacks through. 28 of the 30 rug pulls pass every limit, so that judge lowers them: on subtle edits the model is the only defense, and the README says so.
- The drift canary writes `feed.json`, which [mcpkeel.app/drift](https://mcpkeel.app/drift) shows.

## 0.4.1

### Fixed

- The GitHub Action failed on every run that left `provider` unset, with `--provider must be anthropic or openai.` The action passes each input as an environment variable, and an unset input arrives as an empty string, which the CLI read as a value. Empty `MCPKEEL_PROVIDER`, `MCPKEEL_MODEL`, `MCPKEEL_REVIEW_URL`, `MCPKEEL_NPM_REGISTRY`, `MCPKEEL_PYPI_URL`, `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` are now treated as unset. The action's tests now run with its inputs as GitHub passes them. Found by running the action in [mcpkeel-example](https://github.com/mcpkeel/mcpkeel-example).

## 0.4.0

### Added

- A plugin for Claude Code, installed with `/plugin install mcpkeel --marketplace mcpkeel/mcpkeel`. When a session starts, it checks the project's MCP servers against `mcp.lock`; when the agent calls a tool of a server that changed, it asks first, or blocks the call, as configured. The agent is told which servers changed, never their changed text. `/mcpkeel:verify` checks again and `/mcpkeel:review` shows the changes for a person to accept. The plugin pins the mcpkeel it runs in its own lockfile.
- The same plugin for Codex, from this repository's Codex marketplace. Codex cannot ask before a tool call, so there the plugin blocks.
- A nightly drift canary: nine popular public MCP servers from npm and PyPI, started without a pinned version and compared with the night before. Results are kept in the `canary-data` branch.
- A privacy page at mcpkeel.app/privacy.

### Changed

- The model review is described as model-agnostic everywhere: Claude by default, or any OpenAI-compatible endpoint, including a local one.
- The release workflow also creates the GitHub release, with the version's CHANGELOG section as its notes.

## 0.3.0

### Added

- `mcpkeel demo` pins a local demo server, lets it change the way a compromised release would, and runs `verify`. No network, nothing left behind.
- The release a server's launcher runs is pinned. For `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec`, `uvx`, `uv tool run`, `pipx run`, `docker run` and `podman run`, mcpkeel looks up the version that will run and the registry's digest of it before starting the server, and records both in `mcp.lock`. A different release is high; the same version with different contents is critical. A version range cannot be pinned, and `init` says so. A registry that cannot be reached makes the run incomplete; `--no-resolve` turns the lookup off. A lockfile without pins is not drift, and `update` adds them.
- Configs of opencode (`opencode.json`, `opencode.jsonc`), Codex (`.codex/config.toml`) and Gemini CLI (`.gemini/settings.json`), with each client's way of referring to the environment. One server pins the same way whichever client's file it is in. A stdio server's `cwd` is honoured and pinned.
- Stable codes for every kind of change (`MK1xx`) and every built-in check (`MK2xx`), each with its OWASP MCP Top 10 category, in JSON (`rule`, `owasp`), Markdown and the README.
- `--sarif <file>` writes SARIF 2.1.0 for GitHub code scanning: one result per change, at its line in `mcp.lock`, with a fingerprint that stays the same while the change does. The action has a `sarif` input.
- `mcpkeel.json`, or `--policy <file>`: decisions about findings, each with a required reason. Accepting a check takes its hit off a change, which returns to the severity it had without it. Setting a severity for a kind of change makes it quieter, never hidden. Every applied decision is shown with its reason.
- `--provider openai` reviews through any OpenAI-compatible endpoint, including a model server on the same machine, with `--review-url` and `--model`. The prompt, the delimiter and the limits on lowering are the same as with Claude, reports name the model that judged, and the key is not passed to the servers being checked. The action has `provider`, `review-url` and `review-api-key` inputs.
- `eval/mcptox.mjs` measures mcpkeel on the MCPTox benchmark. A poisoned tool appearing on a pinned server is reported at high or above in 485 of 485 cases. The built-in checks alone flag 50 of the 485 poisoned tools, which makes them critical, and 0 of 362 real tools. CI runs it on every change and fails if any of these numbers gets worse.
- `docs/EVIDENCE.md` records the run behind each claim in the README.

### Changed

- Remote servers whose host is, or resolves to, a link-local or cloud metadata address are refused before any request, and redirects from remote servers and from the reviewer's API are no longer followed.
- Node.js 22 or later is required. Node 20 reached end of life in April 2026.
- The release workflow uses `actions/checkout` v7 and `actions/setup-node` v7.

## 0.2.1

### Fixed

- The text sent to the reviewer under `--explain` sits between tags that carry a random id, new for every request and named only in that request's instructions. `<`, `>` and `&` inside it are written as JSON escapes, so a description can no longer close the tag around it and pose as the end of the data.
- A check that did not run is reported as incomplete, never as clean. When `--probe` cannot finish, `verify` and `diff` exit `2`, as they already did for a server that cannot be reached, and no output says "No drift". JSON output gains `complete` and `incomplete`, and the Markdown report a "Not checked" section. A review that cannot run is listed there too, but leaves the exit code alone: the rule-based severities it falls back to are the stricter ones.
- A changed tool is also read as a whole: its description together with its schema, and its description followed by each schema string. A payload split across fields, such as an instruction in the description and an address in a parameter's default, is reported as `tool.text.flagged`, a critical change a reviewer cannot lower.
- Text hidden in Unicode tag characters is decoded. The flag quotes the hidden message, and the built-in checks run over it.
- Fewer false alarms on forceful but ordinary API wording. `.env.example`, `.env.sample` and `.env.template` are no longer treated as secret files, and "do not show more than 50 results to the user" is no longer read as hiding something.

### Changed

- CI and the README examples use `actions/checkout` v7 and `actions/setup-node` v7.
- The README says that `init` and `verify` start the commands in the config they read.

## 0.2.0

### Added

- `verify --explain` and `diff --explain` now classify each changed text as cosmetic, functional or adversarial, and adjust its severity. Adversarial changes become critical. A cosmetic rewording drops to low, but only when no built-in check fired, the text was replaced rather than added, it is not much longer, it adds no new address, and the reviewer saw all of it.
- `--probe` reads each server two more times: later in the same session, and under another client name. It catches servers that rewrite their definitions after a few requests, and servers that answer a checker differently from an agent.
- A GitHub Action, `mcpkeel/mcpkeel`, with two modes. `verify` fails the job on drift and writes the report to the job summary. `update-pr` accepts the new definitions on a branch and opens a pull request with the report.
- `--report <file>` appends a Markdown report. Nothing from a server is emitted as Markdown.
- New built-in checks: requests for the conversation, the system prompt or the user's secrets; encoded text; HTML comments; words that mix alphabets; tools that have to "run first"; parameter names that read like sentences.
- Every check also runs on the text with a disguise undone: read backwards, letter spacing removed, digits read as letters, ROT13, look-alike letters replaced, encoded runs decoded.
- The checks now read every key and string in a schema, parameter names included, not only descriptions.
- Cross-server checks: a description that starts referring to another server's tool is critical, and a new tool that takes the name of another server's tool says so. `init` lists both.
- A release workflow that publishes to npm from a tag, with trusted publishing.

### Changed

- A changed launch command is now high when it starts a different program or host, and medium when only the arguments changed. It was low. A server that keeps its name but starts a different program is a different server.
- JSON output: a reviewed change carries `review` (`by`, `model`, `verdict`, `reason`, `effect`) and, when the severity moved, `ruleSeverity`. This replaces `claudeReview`.
- In `verify`, a review that cannot run leaves the rule-based severities in place and says so, instead of failing.
- Text from a server is escaped before it reaches the terminal, so it cannot carry escape sequences.
- mcpkeel no longer passes `ANTHROPIC_API_KEY` on to the servers it starts, unless the config names it in that server's `env`.

### Fixed

- `src/scan.ts` contained literal zero-width and bidirectional characters inside two character classes. They are now written as code point numbers, and a test fails if any source file contains one.

## 0.1.0

First release: `init`, `verify`, `diff`, `update`, and `diff --explain`.
