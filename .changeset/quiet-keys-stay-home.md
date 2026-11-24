---
'@ai-sdk/alibaba': patch
'@ai-sdk/amazon-bedrock': patch
'@ai-sdk/anthropic': patch
'@ai-sdk/assemblyai': patch
'@ai-sdk/black-forest-labs': patch
'@ai-sdk/cartesia': patch
'@ai-sdk/cerebras': patch
'@ai-sdk/cohere': patch
'@ai-sdk/deepgram': patch
'@ai-sdk/deepinfra': patch
'@ai-sdk/deepseek': patch
'@ai-sdk/elevenlabs': patch
'@ai-sdk/fal': patch
'@ai-sdk/fireworks': patch
'@ai-sdk/fish-audio': patch
'@ai-sdk/gateway': patch
'@ai-sdk/gladia': patch
'@ai-sdk/gmicloud': patch
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
'@ai-sdk/groq': patch
'@ai-sdk/huggingface': patch
'@ai-sdk/hume': patch
'@ai-sdk/luma': patch
'@ai-sdk/mistral': patch
'@ai-sdk/moonshotai': patch
'@ai-sdk/openai': patch
'@ai-sdk/openai-compatible': patch
'@ai-sdk/open-responses': patch
'@ai-sdk/perplexity': patch
'@ai-sdk/prodia': patch
'@ai-sdk/provider-utils': patch
'@ai-sdk/quiverai': patch
'@ai-sdk/replicate': patch
'@ai-sdk/revai': patch
'@ai-sdk/togetherai': patch
'@ai-sdk/typesafe-ai': patch
'@ai-sdk/voyage': patch
'@ai-sdk/xai': patch
'@ai-sdk/zai': patch
---

fix(provider-utils): stop persisting resolved API key headers when models cross workflow step boundaries. `serializeModelOptions` now stores API keys loaded from environment variables as references to those variables, keeps only non-credential protocol headers, and drops all other header values. Provider models restore their headers with the new `deserializeModelConfig` helper, which reads the API key from the environment of the workflow step.
