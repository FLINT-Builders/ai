---
'@ai-sdk/amazon-bedrock': patch
---

fix(amazon-bedrock): reject `s3://` file URLs unless their bucket is listed in the new `allowedS3Buckets` provider setting

Previously, Bedrock chat models passed any `s3://` image or video URL to the Converse API, where Bedrock read the object with the application's AWS credentials. Because the SDK skipped downloading these URLs, client-supplied chat messages could reference arbitrary S3 objects. `s3://` URLs are now rejected by default; set `allowedS3Buckets` to opt in for trusted buckets.
