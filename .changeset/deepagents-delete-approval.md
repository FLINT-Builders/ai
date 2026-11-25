---
'@ai-sdk/harness-deepagents': patch
---

fix(harness-deepagents): gate and filter the Deep Agents `delete` built-in

The `delete` tool that Deep Agents registers on every filesystem backend ran without approval under `allow-reads` and ignored built-in tool filtering. It is now an edit-class built-in that requires approval like `write` and `edit`, is deactivated when `write` or `edit` is, and can be named in `activeTools`/`inactiveTools`. Built-in tool filtering now also applies inside the general-purpose subagent, and the bridge refuses to start if Deep Agents registers a filesystem tool it has not classified.
