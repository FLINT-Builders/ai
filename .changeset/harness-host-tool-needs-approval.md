---
'@ai-sdk/harness': patch
---

fix(harness): honor a host tool's `needsApproval` when `toolApproval` has no entry for it

`HarnessAgent` executed host tools marked `needsApproval` without requesting approval. Host tools without a `toolApproval` entry now fall back to their `needsApproval` setting, the same way `generateText` and `streamText` do, and the approval decision and execution use the same tool and schema-validated input.
