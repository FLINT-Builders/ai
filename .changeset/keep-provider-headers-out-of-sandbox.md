---
'@ai-sdk/harness': patch
'@ai-sdk/harness-codex': patch
'@ai-sdk/harness-claude-code': patch
'@ai-sdk/harness-deepagents': patch
'@ai-sdk/harness-opencode': patch
---

fix(harness): keep provider request headers out of the sandbox

Bridges no longer write request headers or runtime environment variables to the start config files in the sandbox. When credentials are brokered, the Codex, Claude Code, Deep Agents, and OpenCode harnesses now apply session request headers through the host-side request transformations instead of forwarding them to the sandboxed runtime.
