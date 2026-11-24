---
'@ai-sdk/rsc': patch
---

fix(rsc): sign the AI state on the server and reject unsigned or modified AI state sent by the client to `createAI` actions and `onGetUIState`
