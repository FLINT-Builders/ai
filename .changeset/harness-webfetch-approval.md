---
'@ai-sdk/harness-opencode': patch
'@ai-sdk/harness-claude-code': patch
'@ai-sdk/harness-acp': patch
---

fix(harness): require host approval for web fetches in allow-reads and allow-edits

The OpenCode bridge treated `webfetch` as a read-only tool and replied `always`, so fetches ran without host approval and later fetches were remembered as allowed. It now requests host approval and replies `once`, matches permission actions by exact name instead of by substring, and rejects URL resources on file permissions. The Claude Code bridge now requests approval for `WebFetch`, and the ACP permission controller no longer auto-approves `fetch` tool calls.
