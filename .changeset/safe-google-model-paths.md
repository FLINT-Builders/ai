---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google, google-vertex): reject model ids, operation names, and batch ids that are not safe URL path segments before sending credentialed requests
