---
'@ai-sdk/harness': patch
'@ai-sdk/harness-acp': patch
'@ai-sdk/harness-cursor': patch
'@ai-sdk/harness-grok-build': patch
'@ai-sdk/harness-github-copilot': patch
---

fix(harness): reject permission modes other than `allow-all` for ACP harnesses that cannot enforce them

`createACP` previously always reported built-in tool approval support, so `HarnessAgent` accepted `allow-reads` and `allow-edits` for Cursor, Grok Build, and GitHub Copilot even though those runtimes run built-in tools without asking for approval. `createACP` now accepts `supportsBuiltinToolApprovals`, and these adapters set it to `false`, so restrictive modes throw `HarnessCapabilityUnsupportedError` before a session starts. The ACP bridge also refuses restrictive modes unless the host declares approval support. `@ai-sdk/harness` now builds its root, `agent`, and `utils` entry points together, so error classes have a single identity across them.
