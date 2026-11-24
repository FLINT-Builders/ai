---
'@ai-sdk/google': patch
'@ai-sdk/google-vertex': patch
---

fix(google-vertex): stop forwarding `gs://` file URLs for buckets that are not explicitly allowed

Google Vertex chat models advertised native support for every `gs://` URL, so file parts with any Cloud Storage URL (including client-supplied UI message files) were sent to Vertex as `fileData.fileUri` and read with the project's service identity. `gs://` URLs, and provider references that resolve to them, are now only forwarded for buckets listed in the new `allowedGcsBuckets` provider setting and are rejected otherwise. This applies to Vertex and Google chat, interactions, image and video models.
