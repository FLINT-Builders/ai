---
'@ai-sdk/harness-claude-code': patch
'@ai-sdk/harness-opencode': patch
'@ai-sdk/harness-acp': patch
---

fix(harness): require host approval for outbound network tools in `allow-reads` and `allow-edits`

Claude Code's `WebFetch` and `WebSearch`, OpenCode's `webfetch`, and ACP permission requests of kind `fetch` were auto-approved as reads, letting an agent send workspace content to any URL without an approval request. They now emit a `tool-approval-request` unless `permissionMode` is `allow-all`.
