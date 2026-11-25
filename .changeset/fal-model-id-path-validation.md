---
'@ai-sdk/fal': patch
---

fix(fal): validate model ids before building request URLs

Transcription, video, image, and speech models placed the model id into the credentialed request URL unencoded, so ids containing dot segments, `\`, `%`, `?`, `#`, or a `requests` segment could redirect the authenticated request to another fal path. Model ids are now validated as path segments of `[A-Za-z0-9._-]` before any request is made, and transcription model ids must be a single segment.
