---
'@ai-sdk/google': patch
---

fix(google): only send batch status, results, and cancel requests for batch ids of the form `batches/{id}`, so a stored batch id can no longer address another Gemini API path with the configured API key
