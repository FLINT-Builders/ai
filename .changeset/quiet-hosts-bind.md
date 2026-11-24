---
'@ai-sdk/harness-acp': patch
---

fix(harness-acp): only auto-approve ACP permission requests for host tools when the request structurally identifies the host MCP call, never from title text or built-in tool kinds
