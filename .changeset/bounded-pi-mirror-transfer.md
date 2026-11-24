---
'@ai-sdk/harness-pi': patch
---

fix(harness-pi): bound the bytes the sandbox workspace mirror accepts from the sandbox

The mirror of `.pi`, `.agents` and `AGENTS.md` ran `gunzipSync` on sandbox archives with no output limit and fell back to `readBinaryFile` on files of any size, so a large but highly compressible file in that scope (for example one created with `truncate`) was inflated in full inside the host process on every turn. The mirror now plans batches from listed file sizes, skips files over 1 MiB, caps each archive batch at 2 MiB and a sync at 32 MiB, limits the archive bytes the sandbox may send, decompresses with `maxOutputLength`, rejects members larger than their listed size, and replaces the `readBinaryFile` fallback with a `head -c`-bounded read.
