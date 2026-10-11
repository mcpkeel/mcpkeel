---
name: False alarm or missed attack
about: A check fired on ordinary text, or did not fire on an attack
labels: detection
---

**The text**

The description or schema text, or the smallest part of it that shows the problem.

**What mcpkeel reported**

The code (for example `MK207`) and the severity, from `npx mcpkeel verify --json`.

**What it should have reported, and why**

Changes to the checks are measured against the MCPTox benchmark in CI, so a fix that catches one case must not miss or flag others.
