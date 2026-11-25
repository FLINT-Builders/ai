---
'@ai-sdk/policy-opa': patch
---

fix(policy-opa): deny tool calls when the OPA policy returns no decision

`normalizeOpaDecision` (and therefore `opaPolicy` / `optionalOpaPolicy`) mapped a `null` or `undefined` OPA result to `not-applicable`. The SDK treats that as "no approval required", so a partial Rego rule that matched no branch let the tool's `execute` run. A missing result is now denied. An explicit `{ "decision": "not-applicable" }` is unchanged.
