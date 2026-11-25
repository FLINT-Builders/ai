---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google, google-vertex): stop copying unknown provider option keys onto Veo video parameters, so they can no longer override `sampleCount`, `durationSeconds`, `resolution`, `aspectRatio`, or `seed`
