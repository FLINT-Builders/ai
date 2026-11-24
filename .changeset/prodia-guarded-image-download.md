---
'@ai-sdk/prodia': patch
---

fix(prodia): download language model image URL inputs through the guarded `downloadBlob` helper so private/internal addresses and unsafe redirect targets are rejected and the response size is capped
