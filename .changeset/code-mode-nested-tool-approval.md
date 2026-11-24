---
'ai': patch
'@ai-sdk/provider-utils': patch
'@ai-sdk/code-mode': patch
---

fix(code-mode): enforce call-level `toolApproval` for nested tool calls

Tools routed through code mode with `experimental_toolCallers` ran without the
`toolApproval` policy of `generateText`, `streamText`, and `ToolLoopAgent`, so
tools that the policy denied or gated behind user approval executed when
generated code called them. Local tool callers now receive a
`resolveToolApproval` function when they are bound, and code mode evaluates it
with the validated input of every nested call: `denied` rejects the call and
`user-approval` is handled like a tool-level `needsApproval` of `true`. Routing a
tool that has a `toolApproval` policy through a local caller that does not
declare `supportsToolApproval` now throws an `InvalidArgumentError`.
