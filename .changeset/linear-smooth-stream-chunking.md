---
'ai': patch
---

fix(ai): scan buffered text in linear time for the built-in `word` and `line` chunking of `smoothStream`, so long output without whitespace or line breaks no longer blocks the event loop
