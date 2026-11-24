---
'@ai-sdk/openai-compatible': patch
---

fix(openai-compatible): prevent `openaiCompatible` provider options on prompt messages and parts from overriding the message role, content, tool call id, or tool calls in chat requests
