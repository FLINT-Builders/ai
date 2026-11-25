---
'@ai-sdk/minimax': patch
'@ai-sdk/bytedance': patch
'@ai-sdk/alibaba': patch
'@ai-sdk/klingai': patch
---

fix(video): keep status requests on the task path by encoding the operation's task ID as a single path segment and rejecting empty, `.` and `..` task IDs (and unknown KlingAI endpoint paths) before sending the request
