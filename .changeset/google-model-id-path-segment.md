---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google, google-vertex): reject model ids that are not a single safe path segment before building credentialed request URLs

Model ids containing `/`, `..`, `\`, `%`, `:`, `?`, `#` or other unsafe characters could rewrite the path, query, or fragment of requests that carry the API key or OAuth credentials. Speech, language, image, embedding, video, batch, Gemini transcription, and Vertex Anthropic models now throw an `InvalidArgumentError` for such ids before sending any request. Language model ids may still use the `models/`, `tunedModels/`, or `endpoints/` prefixes.
