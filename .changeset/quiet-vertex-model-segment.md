---
'@ai-sdk/google-vertex': patch
'@ai-sdk/google': patch
---

fix(google-vertex): reject model ids that are not a single path segment before building Vertex request URLs and live model resources (Gemini transcription, embedding, video, Anthropic on Vertex, and Gemini speech)
