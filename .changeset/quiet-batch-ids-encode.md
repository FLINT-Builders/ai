---
'@ai-sdk/openai': patch
'@ai-sdk/anthropic': patch
'@ai-sdk/xai': patch
'@ai-sdk/google': patch
---

fix(batch): reject batch ids that do not address a single batch

Batch status, results, and cancel calls now reject empty, `.`, and `..` batch ids before sending a request. Previously, URL normalization turned these ids into requests for the batch collection or a parent path. Google batch ids must have the form `batches/<id>`, and the id is now percent-encoded.
