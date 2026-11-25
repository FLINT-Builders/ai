---
'@ai-sdk/anthropic': patch
'@ai-sdk/google': patch
'@ai-sdk/openai': patch
'@ai-sdk/xai': patch
---

fix(batch): keep batch ids on a single URL path segment

Batch status, cancel, and results calls inserted the caller-supplied batch id into the request path with `encodeURIComponent` (or, for Google, without encoding). Ids such as `.`, `..`, or an empty string were collapsed by URL parsing, so the credentialed request reached the batch collection or a parent path instead of the batch. Empty batch ids are now rejected, dot-segment ids are double-encoded, and Google batch ids must have the form `batches/{batch}`.
