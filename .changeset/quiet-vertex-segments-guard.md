---
'@ai-sdk/google-vertex': patch
---

fix(google-vertex): reject model ids that are not a single path segment before sending video, embedding, and Gemini transcription requests, so a model id containing `/`, `..`, `?`, or `#` can no longer retarget the credentialed request URL
