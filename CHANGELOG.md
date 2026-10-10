# Changelog

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
