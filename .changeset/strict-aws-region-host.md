---
'@ai-sdk/amazon-bedrock': patch
'@ai-sdk/anthropic-aws': patch
---

fix(amazon-bedrock, anthropic-aws): reject AWS regions that are not a single DNS label before building the endpoint hostname, so a region containing `?`, `#`, `/`, `@`, or similar characters can no longer redirect requests and their credentials to another host
