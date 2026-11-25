---
'@ai-sdk/workflow': patch
---

fix(workflow): mask model and tool error text in UI message chunks by default

`createModelCallToUIChunkTransform()` and `toUIMessageChunk()` previously copied raw model error messages and tool failure text into the `errorText` sent to the client. They now send `'An error occurred.'`, matching `toUIMessageStream` in `ai`, and accept an `onError` option to log errors or return a custom message. Approved tools that throw are now written to the stream as tool errors instead of successful tool results.
