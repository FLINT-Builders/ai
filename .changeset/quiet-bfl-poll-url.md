---
'@ai-sdk/black-forest-labs': patch
---

fix(black-forest-labs): rebuild the video status poll URL from the configured base URL and request id instead of requesting the operation's `pollingUrl`, refuse operations whose `pollingUrl` names a different request, and send the API key only to the configured origin or a Black Forest Labs API host rather than any `bfl.ai` subdomain
