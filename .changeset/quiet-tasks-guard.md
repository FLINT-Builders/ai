---
'@ai-sdk/bytedance': patch
'@ai-sdk/alibaba': patch
'@ai-sdk/klingai': patch
'@ai-sdk/minimax': patch
---

fix(video): treat the operation's task id as one opaque path segment in video status requests, so a tampered task id can no longer steer the credentialed status request to another path on the provider host
