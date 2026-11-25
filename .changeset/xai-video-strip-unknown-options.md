---
'@ai-sdk/xai': patch
---

fix(xai): stop copying unknown video provider options onto the request body, so they can no longer overwrite the model, prompt, image, video, or other fields set from the generate-video arguments
