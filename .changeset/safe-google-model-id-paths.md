---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google, google-vertex): reject model ids that are not a single safe path segment before building request URLs and model resource names, so a model id can no longer change the request path, query or method
