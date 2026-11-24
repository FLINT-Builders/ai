---
'@ai-sdk/harness': patch
---

fix(harness): validate host tool inputs against the tool's schema before executing them, in both the direct and the approval-continuation path, and pass the schema output (with transforms and defaults applied) to `execute`
