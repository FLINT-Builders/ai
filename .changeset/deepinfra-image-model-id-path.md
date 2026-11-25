---
'@ai-sdk/deepinfra': patch
---

fix(deepinfra): validate and encode image model IDs before building the inference URL

Image model IDs containing empty, `.` or `..` segments, backslashes, `?`, `#`, `%` or control characters are now rejected with an `InvalidArgumentError` before any request is sent, and each remaining path segment is URL-encoded. Previously the ID was concatenated into the request path unchanged, so it could redirect the authenticated request to a different path on the DeepInfra API host.
