# MCP drift feed

Every night, [mcpkeel](https://github.com/mcpkeel/mcpkeel) starts a set of popular public MCP servers the way most configs do, without a pinned version, and compares what they tell an agent with the night before. This branch keeps what it found.

Last checked: **2026-10-14**, 9 servers.

| Date | Changes | Servers |
| --- | --- | --- |
| [2026-10-14](history/2026-10-14.md) | 3 (2 high, 1 low) | `context7` |

The servers and how they are started are in [`canary/.mcp.json`](https://github.com/mcpkeel/mcpkeel/blob/main/canary/.mcp.json). `mcp.lock` here is the latest baseline.
