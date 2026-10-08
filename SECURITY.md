# Security

## Reporting a vulnerability

Email **hello@mcpkeel.app** with what you found and how to reproduce it. Please do not open a public issue for a vulnerability.

I aim to reply within a few days. If the report is confirmed, a fix follows as soon as it is ready, with credit to you in the release notes unless you prefer otherwise.

## What counts

- A way to make `mcpkeel verify` pass when a pinned definition has changed
- A way for a server, config file or lockfile to make mcpkeel run code or write files it should not
- A way for secrets (environment values, headers, URL credentials) to end up in `mcp.lock` or in a request made by `--explain`

## Known limits

These are documented in the README and are not vulnerabilities: mcpkeel trusts what you pin at `init`, it checks definitions rather than behavior, and a server can answer mcpkeel differently from how it answers an agent.
