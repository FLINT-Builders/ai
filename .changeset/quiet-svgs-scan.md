---
'@ai-sdk/quiverai': patch
---

fix(quiverai): detect SVG sources with a linear scan instead of backtracking regular expressions, so crafted animate sources and reference images can no longer block the event loop
