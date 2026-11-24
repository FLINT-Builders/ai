---
'@ai-sdk/harness-codex': patch
---

fix(harness-codex): only hide shell commands from the event stream when they are a literal tool-relay call that the shell will not expand

The CLI tool-relay filter previously treated double-quoted arguments as literal, accepted unquoted newlines as whitespace, and trusted any executable named `bash`/`sh`/`zsh` as a shell wrapper. Commands containing command substitution, parameter or arithmetic expansion, extra commands after a newline, or a non-system shell wrapper could be classified as relay calls and dropped from the host's `tool-call`/`tool-result` events while still running. The parser now refuses anything the shell would expand or execute, so such commands are reported like any other shell command.
