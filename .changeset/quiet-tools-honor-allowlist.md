---
'ai': patch
'@ai-sdk/workflow': patch
---

fix: enforce `activeTools` when replaying approved tool calls from message history

`generateText`, `streamText`, `ToolLoopAgent`, and `WorkflowAgent` executed approved tool calls from client-supplied history against the full tool set, before `activeTools` was applied. Approved calls are now resolved against the effective `activeTools` (including values returned by `prepareCall`), and calls naming a tool outside that set return a `Tool "<name>" is not an active tool` error result instead of executing.
