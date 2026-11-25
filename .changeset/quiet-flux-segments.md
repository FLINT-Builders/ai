---
'@ai-sdk/black-forest-labs': patch
---

fix(black-forest-labs): reject model ids that are not a single URL path segment

Image and video requests built the endpoint URL by appending the raw model id to the base URL, so an id containing `/`, `..`, `?`, `#` or `\` sent the configured API key to a different path or query on the API host. Model ids must now be a single path segment; other ids throw an `InvalidArgumentError` before any request is made.
