---
'@ai-sdk/replicate': patch
---

fix(replicate): reject unversioned model ids that are not a single `owner/name` pair instead of inserting them unencoded into the predictions URL
