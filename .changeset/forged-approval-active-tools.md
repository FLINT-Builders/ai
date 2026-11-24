---
'ai': patch
'@ai-sdk/workflow': patch
---

fix: do not execute replayed tool approvals for tools that do not require approval or are not active

`generateText`, `streamText`, and `WorkflowAgent.stream` executed approved tool calls found in the incoming message history whenever the re-validated approval policy did not deny them. Because a tool without an approval requirement resolves to `not-applicable`, a client could forge an approved tool call for any server tool, including tools excluded by `activeTools`. Replayed approvals now resolve against the tools that are active for the first step of the request (`activeTools` and the `prepareStep` result), and are only executed when the policy still requires user approval or explicitly approves the call. Other replayed approvals are reported to the model as tool errors without executing the tool. When there are replayed approvals to execute, `prepareStep` is called once for step 0 before they run, to determine the active tools.
