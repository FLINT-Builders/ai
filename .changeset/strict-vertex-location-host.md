---
'@ai-sdk/google-vertex': patch
---

fix(google-vertex): reject locations and Speech-to-Text regions that are not a single DNS label before building the request host, so a value such as `example.com?` can no longer redirect credentialed requests away from `googleapis.com`
