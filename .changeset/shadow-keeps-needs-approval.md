---
'@ai-sdk/policy-opa': patch
---

fix(policy-opa): keep tool-level `needsApproval` under `shadow` and `wrapMcpTools`

`shadow` replaced the wrapped approval with a single function, so a tool with `needsApproval` that the policy had no opinion on (or that was only observed) ran without user approval. `shadow` now falls back to the tool's own `needsApproval` when the policy has no opinion, keeps `needsApproval` holds in observe mode, and passes the validated `toolContext` to per-tool approval functions. `wrapMcpTools` with `default: 'not-applicable'` no longer writes an explicit entry that bypasses `needsApproval`.
