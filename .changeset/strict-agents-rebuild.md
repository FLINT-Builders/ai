---
'@ai-sdk/harness-deepagents': patch
---

fix(harness-deepagents): rebuild the cached bridge agent when the permission mode, built-in tool filtering, or MCP servers change, so a resumed session enforces the approval gates and tool filtering from its current start message
