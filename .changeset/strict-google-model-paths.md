---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google, google-vertex): reject model ids that are not a single path segment before building request URLs

Model ids were interpolated into credentialed request URLs without validation, so ids containing `/`, `..`, `%`, `?`, `#`, or `\` could change the target resource. Model ids must now consist of letters, digits, `.`, `_`, `@`, and `-`, optionally prefixed by `models/`, `tunedModels/`, or (Vertex) `endpoints/` where a path is accepted. Invalid ids throw an `InvalidArgumentError` before any request is sent.
