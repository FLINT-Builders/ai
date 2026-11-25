---
'@ai-sdk/harness-cline': patch
---

fix(harness-cline): require approval for MCP server tools outside `allow-all`

MCP server tools configured through `mcpServers` previously ran without an approval request in `allow-reads` and `allow-edits` mode. Every tool the adapter does not know to be read-only or host-executed now requires approval, and an approval request is refused when the model reuses a tool call id from earlier in the turn.
