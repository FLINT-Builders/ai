---
'@ai-sdk/workflow': patch
---

fix(workflow): validate tool input against the original input schema before execution

`WorkflowAgent` only validated tool call input against the JSON Schema form of each tool's input schema, which drops refinements, `superRefine` checks, transforms, and defaults. Tool `execute` functions could receive input that the tool's own schema rejects. Tool input is now validated against the original `inputSchema` before `execute` and `onInputAvailable` run, invalid input is returned to the model as a tool error, and tools receive the parsed value.
