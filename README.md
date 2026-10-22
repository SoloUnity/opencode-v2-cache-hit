# opencode-v2-cache-hit

Adds a **Cache** section to the OpenCode V2 sidebar, directly below **Context**:

```text
Cache      main  subs   left
anthropic   96%   91%     4m
openai      92%     —    ~8m
total       95%   91%
```

- `main` is the main session. `subs` is all its sub-agents, including nested
  sub-agents. `—` means that there is no usage.
- The percentage is `cache read / (input + cache read + cache write)`.
- **Provider rows** show when a session in the tree sends a request with that
  provider. A row goes away when its cache expires. Its percentages use only
  the requests in the current TTL window.
- **left** is the time until the cache expires. While a request is in
  progress, it shows the full TTL. Each request that reads the cache starts
  the TTL again.
  The time shows in minutes, rounded up. In the last minute, it shows the
  seconds, for example `0:42`.
- **total** always shows. It includes all usage in the session.

View the parent session: V2 hides the sidebar in sub-agent views.

## Cache TTLs

No provider reports the time left. The plugin calculates it from the start of
the newest request for each provider and the TTL of that request's model:

| Provider and model | TTL | Display |
|---|---|---|
| `anthropic` | 5 minutes | `4m`, `0:42` |
| `openai`, GPT-5.6 and later | At least 30 minutes | `29m`, `0:42` |
| `openai`, older models | About 10 minutes, estimate | `~8m` |
| Other providers | About 5 minutes, estimate | `~4m` |

The countdown is not a guarantee. A cache can fail before its TTL ends, for
example after a model, effort, tool, or compaction change. Each model,
session, and sub-agent also has its own cache.

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

If another plugin also places a section directly after Context, it must place
its section after **Cache**. If it does not, the two sections move each other.

## Test

```sh
node --experimental-vm-modules --test test/*.test.js
```
