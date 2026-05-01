## Why

Pi users frequently type shell commands in the chat input. Currently there is no shell command autocompletion inside the Pi TUI editor — users must remember exact command names, subcommands, and flags as they type. A `!`-triggered autocomplete that queries zsh's native completion system would bring the same completions users already have in their terminal (git, docker, kubectl, and any tool with installed zsh completions) directly into the Pi editor. Combined with AI ghost text from a local FIM model that predicts the remainder of the command inline, this eliminates the friction of switching between Pi and terminal for command recall.

## What Changes

- **`!`-triggered autocomplete** in the Pi editor — typing `!` followed by a command prefix opens a completion dropdown
- **All completions from zsh's native completion system** — no custom command lists, no `--help` parsing, no separate discovery. zsh already knows every command on PATH, every git subcommand, every docker flag, every kubectl resource. The extension programmatically queries zsh's completion for the partial command line after `!` and presents the results.
- **AI ghost text** using a local fill-in-the-middle model (starcoder2-3b via node-llama-cpp) — predicts the rest of the command as dimmed text after the cursor
- **Keyboard controls**: **Tab** accepts ghost text into the input; **↑↓** arrow keys navigate the completion dropdown; **Enter** selects the highlighted dropdown item. When ghost text is not shown, Tab falls through to dropdown navigation.
- **Caching** — TTL-based cache for zsh completion results and AI model responses to avoid repeated shell-outs and inference
- **Configuration** — model path, cache TTL, max dropdown items, debounce delay, ghost text color — all with sensible defaults
- **Full test suite** — unit tests (vitest) for pure logic and DI-injected modules; Docker-based integration tests with zsh and pre-installed completions (git, docker, kubectl) to verify real completion output
- **Graceful degradation** — AI model failure does not affect dropdown completions; stale cache served while background refresh is in progress

## Capabilities

### New Capabilities

- `zsh-native-completion`: Programmatically query zsh's completion system for a partial command line and return completion candidates. Covers commands (first word), subcommands, flags, arguments, paths — everything zsh knows how to complete.
- `ai-ghost-completion`: AI-powered ghost text predictions using a local FIM model. Debounced input, result caching, graceful loading and error states.
- `shell-autocomplete-provider`: AutocompleteProvider that integrates zsh completions into Pi's dropdown. Triggered by `!` prefix. Delegates non-`!` input to Pi's default file/mention provider.
- `ghost-text-editor`: CustomEditor that renders AI ghost text inline at the cursor position and manages keyboard bindings (Tab → accept ghost, ↑↓ → dropdown, Enter → select).

### Modified Capabilities

_None — new extension._

## Impact

- **New code**: `~/.pi/agent/extensions/shell-autocomplete/` — modular TypeScript extension
- **Dependencies**: `node-llama-cpp` (unchanged), `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`; dev: `vitest`
- **Model file**: `~/.pi/agent/models/starcoder2-3b-Q4_K_M.gguf` — path configurable
- **Shell dependency**: Requires zsh with loaded completions (`compinit` in `.zshrc`) — standard on macOS/Linux zsh setups with tools like oh-my-zsh, prezto, or zinit
