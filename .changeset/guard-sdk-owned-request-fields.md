---
'@ai-sdk/bytedance': patch
'@ai-sdk/klingai': patch
---

fix(bytedance, klingai): stop raw provider option pass-through from overwriting SDK-owned request fields

Extra keys in `providerOptions.bytedance` and `providerOptions.klingai` were copied onto the request body after the SDK built it, so keys such as `model`, `content`, `prompt`, `image`, `duration`, or `callback_url` replaced the model, prompt, media, and call settings the caller passed. These fields are now set only from call options, typed provider options, and `webhookUrl`; a raw key with one of these names is dropped with an `unsupported` warning. Unrecognized fields are still passed through. Use `webhookUrl` with `experimental_startVideo` to register a callback URL.
