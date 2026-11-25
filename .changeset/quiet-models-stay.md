---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google, google-vertex): reject model ids that are not a single URL path segment and encode them when building embedding, video, speech, transcription, and Vertex Anthropic request URLs
