---
'@ai-sdk/alibaba': patch
'@ai-sdk/bytedance': patch
'@ai-sdk/fal': patch
'@ai-sdk/google': patch
'@ai-sdk/klingai': patch
'@ai-sdk/minimax': patch
'@ai-sdk/replicate': patch
---

fix(video): confine credentialed video status requests built from caller-supplied operations

Video status checks used fields of the `operation` object (task ids, operation names, status URLs) to build credentialed request URLs without encoding or validation, so a tampered stored operation could direct the provider API key at other paths on the provider host, or (for fal) at another host. Task ids are now validated and encoded as a single path segment, KlingAI endpoint paths and Google operation names must match the expected shapes, Replicate status URLs on the configured origin must address a single prediction, and fal binds credentials to the configured queue origin instead of the operation's `submitUrl`.
