---
'ai': patch
'@ai-sdk/provider-utils': patch
---

fix(ai): bound the default prompt file downloads

The default download function used during prompt conversion fetched every file URL the model does not support natively in parallel, with no limit on the number of files, no combined byte limit, and no timeout, buffering each body up to 2 GiB. It now downloads at most 8 files per prompt with at most 2 in flight, limits each file to 100 MiB and all files of one prompt to 100 MiB combined, and aborts the downloads after 10 seconds. `readResponseWithSizeLimit` accepts an optional `onChunk` callback to enforce byte budgets shared across downloads.
