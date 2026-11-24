---
'@ai-sdk/klingai': patch
'@ai-sdk/fal': patch
---

fix(klingai, fal): keep video status requests and credentials on the configured provider origin

KlingAI `doStatus` now only accepts an `endpointPath` from the fixed set of KlingAI video endpoints, rejects invalid task IDs, URL-encodes the task ID, and restricts credentials to the configured base URL origin. fal `doStatus` now derives the credentialed queue origin from the provider configuration instead of the operation's `submitUrl`.
