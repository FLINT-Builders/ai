---
'ai': patch
---

fix(ai): verify provider-executed tool approvals before forwarding them

`generateText` and `streamText` forwarded approval responses for provider-executed tools (e.g. OpenAI MCP tools that require approval) from the client-supplied message history without checking the `experimental_toolApprovalSecret` signature or re-evaluating the approval policy. Provider-emitted approval requests are now signed when a secret is configured, and every forwarded provider-executed approval is verified: invalid or missing signatures are rejected, and approvals denied by the policy are sent to the provider as denials.
