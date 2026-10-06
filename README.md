# opencode-v2-cache-hit

Adds one line to the existing Context section in the OpenCode V2 sidebar:

```text
Context
49,204 tokens
5% used
99% cache hit
```

Includes all input usage from the session and its sub-agents, including nested
sub-agents. The percentage is `cache read / (input + cache read + cache write)`.
The token count and `% used` stay unchanged. `— cache hit` means no usage is
available yet. View the parent session: V2 hides the sidebar in sub-agent views.

## Install

Clone into your OpenCode config directory:

```sh
git clone https://github.com/SoloUnity/opencode-v2-cache-hit.git \
  "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/opencode-v2-cache-hit"
```

Add this entry to `plugins` in that directory's `cli.json`:

```json
{
  "plugins": ["./plugins/opencode-v2-cache-hit"]
}
```

Keep your other plugin entries. Reopen the terminal interface if needed.
No service restart, extra settings, or external credentials are required.

## Test

```sh
node --experimental-vm-modules --test test/*.test.js
```
