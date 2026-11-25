---
'@ai-sdk/azure': patch
---

fix(azure): encode deployment names as a single path segment in deployment-based URLs and reject empty, `.` and `..` names
