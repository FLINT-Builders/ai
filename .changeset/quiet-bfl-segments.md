---
'@ai-sdk/black-forest-labs': patch
---

fix(black-forest-labs): send the model id as a single encoded path segment

Image and video submit requests appended the raw model id to the base URL, so an id containing `/`, `\`, `..`, `?` or `#` could move the request (and its `x-key` header) to another path or query on the API host. Such ids are now rejected with an `InvalidArgumentError`, and all other ids are percent-encoded.
