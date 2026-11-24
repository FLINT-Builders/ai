---
'@ai-sdk/policy-opa': patch
---

fix(policy-opa): enforce the `opaCapabilityMiddleware` allowlist on model output

The middleware removed disallowed tools only from the model request, so a tool call that named a removed tool was still executed by `generateText`, `streamText`, and agents. Tool calls (and their streamed input, results, and approval requests) whose name is not in the allowlist computed for that call are now dropped, and every tool call is dropped when the allowlist could not be computed.
