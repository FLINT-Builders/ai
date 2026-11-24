---
'@ai-sdk/langchain': patch
---

fix(langchain): mask stream and tool error messages sent to the client by `toUIMessageStream`

`toUIMessageStream` now sends `'An error occurred.'` as the `errorText` of `error` and `tool-output-error` chunks, matching the core AI SDK default. `onError` still receives the full error and can return a string to send a custom message to the client.
