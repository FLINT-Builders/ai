---
'@ai-sdk/harness-pi': patch
---

fix(harness-pi): skip config entries whose paths contain newlines, tabs, or carriage returns when mirroring the sandbox workspace, so a crafted filename can no longer forge listing records that copy arbitrary sandbox files into the host mirror
