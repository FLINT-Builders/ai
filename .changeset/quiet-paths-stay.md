---
'@ai-sdk/google': patch
'@ai-sdk/alibaba': patch
'@ai-sdk/bytedance': patch
'@ai-sdk/klingai': patch
---

fix: validate caller-supplied operation, batch, and task ids before building credentialed status, results, and cancel request URLs
