---
'@ai-sdk/azure': patch
'@ai-sdk/google-vertex': patch
'@ai-sdk/amazon-bedrock': patch
---

fix: reject resource names, locations, and regions that are not a single DNS label so they cannot change the host that receives credentials and prompts
