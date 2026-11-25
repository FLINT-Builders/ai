---
'@ai-sdk/moonshotai': patch
---

fix(moonshotai): stop forwarding `ms://` Files API URLs from prompt file URLs. Moonshot resolves `ms://` ids under the request's API key, so a prompt URL could name any file stored under that key. The chat model no longer declares `ms://` URLs as natively supported, and the message converter rejects file part URLs whose scheme is not http, https, or data. Use an explicit Moonshot provider reference (`{ type: 'reference', reference: { moonshotai: 'ms://file-id' } }`) for files the current user is allowed to access.
