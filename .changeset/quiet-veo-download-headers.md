---
'@ai-sdk/provider': patch
'@ai-sdk/provider-utils': patch
'@ai-sdk/google': patch
'ai': patch
---

fix(google): stop embedding the API key in Veo video URLs

Completed Google Generative AI video results (`experimental_getVideoStatus`, `experimental_generateVideo`) appended the configured API key as a `key` query parameter to same-origin download URLs. Those URLs are returned to callers and were included in `DownloadError` messages, so the key could reach application users.

Video results now contain the plain Veo URI. Video models can implement the new optional `getDownloadHeaders` method; `experimental_generateVideo` passes the returned headers to the `download` function, and the built-in download sends them only to the video URL's origin (they are dropped on a cross-origin redirect). The Google video model uses this to authenticate downloads with the `x-goog-api-key` header. Applications that download Google video URLs from `experimental_getVideoStatus` themselves must send the `x-goog-api-key` header.

`DownloadError` now redacts userinfo and credential query parameters (`key`, `api_key`, `apikey`, `access_token`, `token`) from its `url` and message.
