---
'@ai-sdk/fireworks': patch
---

fix(fireworks): reject image model ids that are not `accounts/<account>/models/<model>` before building request URLs, so a model id can no longer rewrite the request path
