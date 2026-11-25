---
'@ai-sdk/harness': patch
'@ai-sdk/harness-codex': patch
'@ai-sdk/harness-claude-code': patch
'@ai-sdk/harness-opencode': patch
'@ai-sdk/harness-deepagents': patch
'@ai-sdk/harness-acp': patch
---

fix(harness): bind bridge host control to the host connection and keep the bridge token out of the sandbox

The sandbox bridge previously treated any WebSocket client that presented the bridge token as the host, and the token was passed to the sandbox in `BRIDGE_CHANNEL_TOKEN`, where the agent runtime could read it. A process in the sandbox could take the event stream, answer pending host tool calls and approvals, abort or replace the turn, and stop or destroy the bridge.

The bridge now binds host authority to individual connections with a host lease that is sent only over the host's socket. Connections without it are refused, even when they present the token. `SandboxChannel` presents the lease on reconnect, and adapters persist it with their bridge coordinates for attach. Adapters now pass only a SHA-256 digest of the token (`BRIDGE_CHANNEL_TOKEN_SHA256`), and the Codex bridge no longer forwards `BRIDGE_*` variables to the Codex process.
