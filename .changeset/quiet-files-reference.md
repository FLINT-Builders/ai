---
'@ai-sdk/openai': patch
'@ai-sdk/azure': patch
---

fix(openai, azure): stop treating inline file data that starts with `file-` or `assistant-` as a stored file id in the Responses API

Inline file data is now always sent as file content. A chat file part such as `data:application/pdf;base64,file-<id>` previously became a `file_id` reference to that stored file. To reference a file uploaded to the OpenAI Files API, pass it as a provider reference instead: `data: { type: 'reference', reference: { openai: 'file-abc123' } }`.
