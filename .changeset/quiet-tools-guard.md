---
'ai': patch
---

fix(ai): ignore `toolChanges`, `clearAt`, and `effort` in UI system message provider metadata in `convertToModelMessages`, so clients cannot alter the tool set or system message controls
