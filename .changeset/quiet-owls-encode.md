---
'@ai-sdk/replicate': patch
---

fix(replicate): validate and encode unversioned model ids before building the predictions URL

Unversioned image and video model ids were concatenated unencoded into `/models/{id}/predictions`, so ids containing `..`, extra `/` segments, `?`, `#`, or backslashes sent the authenticated request to a different path. Model ids must now be exactly `owner/name` (letters, digits, `.`, `_`, `-`) and are rejected with an `InvalidArgumentError` before any request is sent.
