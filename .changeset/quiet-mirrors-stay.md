---
'@ai-sdk/harness-pi': patch
---

fix(harness-pi): keep symlinked Pi config inside the workspace

The workspace mirror no longer follows `.pi`, `.agents`, or `AGENTS.md` symlinks whose targets resolve outside the session workspace, and it copies each file only from the location the listing approved. Skills, project context files, and the project `SYSTEM.md` are only loaded when their real path stays inside the workspace.
