---
'@ai-sdk/amazon-bedrock': patch
---

fix(amazon-bedrock): only honor part-level `guardContent` when the `allowPartGuardContent` call option is enabled

Part-level `guardContent` provider options limit Bedrock Guardrails to the marked content. Because `convertToModelMessages` forwards client-supplied UI part `providerMetadata`, a chat client could mark a harmless part and keep the rest of its input out of the guardrail. These options are now ignored (with a warning) unless `providerOptions.bedrock.allowPartGuardContent` is set to `true`.
