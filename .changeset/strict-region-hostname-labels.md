---
'@ai-sdk/provider-utils': patch
'@ai-sdk/amazon-bedrock': patch
'@ai-sdk/anthropic-aws': patch
'@ai-sdk/azure': patch
'@ai-sdk/google-vertex': patch
---

fix: reject region, location, and resource name settings that are not a single DNS label before building the provider hostname, so values such as `example.com?` can no longer redirect credentialed requests to another host
