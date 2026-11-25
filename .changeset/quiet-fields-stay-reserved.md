---
'@ai-sdk/bytedance': patch
'@ai-sdk/klingai': patch
---

fix(bytedance, klingai): prevent pass-through provider options from overwriting SDK-set request fields

Extra provider option keys are still forwarded to the API, but keys that name a request field the SDK sets itself (for example `model`, `prompt`, `image`, `content`, or `model_name`) are no longer copied onto the request body.
