---
'@ai-sdk/google-vertex': patch
---

fix(google-vertex): reject Vertex Anthropic model ids that are not a single safe path segment

Previously the Vertex Claude provider inserted the model id into the `rawPredict` / `streamRawPredict` URL without validation, so ids containing `../`, `%2e%2e/`, `/`, `?`, or `#` could send the authenticated request to a different Vertex resource. Such ids are now rejected with an `InvalidArgumentError` before any request is sent.
