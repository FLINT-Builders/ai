---
'@ai-sdk/replicate': patch
'@ai-sdk/fal': patch
'@ai-sdk/black-forest-labs': patch
'@ai-sdk/klingai': patch
'@ai-sdk/alibaba': patch
'@ai-sdk/bytedance': patch
'@ai-sdk/minimax': patch
'@ai-sdk/google': patch
---

fix(video): build status URLs from the provider id instead of URLs stored on the operation

Video status checks no longer fetch a URL, origin, or endpoint path taken from the caller-supplied operation, so a modified operation cannot send the API key to another path or host. Replicate operations are now `{ predictionId }` and fal operations are now `{ requestId }`; operations stored by earlier versions must be restarted. Black Forest Labs keeps only the regional API host of `pollingUrl` and always polls `get_result`, KlingAI only uses an `endpointPath` the model can start tasks on, and task, request, and operation ids are encoded as a single path segment with `.` and `..` rejected.
