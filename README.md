# Shell Autocomplete for Pi

`!`-triggered shell command autocompletion inside the Pi TUI editor. Uses zsh's native completion system for commands, subcommands, flags, and arguments. AI ghost text from a local FIM model predicts the rest of your command inline.

## Features

- **`!` prefix autocomplete** — type `!git` and get matching commands; `!git c` and get git subcommands
- **Native zsh completions** — reuses your installed zsh completions (git, docker, kubectl, npm, etc.)
- **AI ghost text** — local starcoder2-3b model predicts the most likely command completion as dimmed text
- **Keyboard controls** — Tab accepts ghost text; ↑↓ navigate dropdown; Enter selects

## Requirements

- **zsh** with completions enabled (`compinit` in `.zshrc`)
- **node-llama-cpp** for AI ghost text (optional — autocomplete works without it)
- **Model file**: Download `starcoder2-3b-Q4_K_M.gguf` and place it at `~/.pi/agent/models/`

## Installation

Place the extension in `~/.pi/agent/extensions/shell-autocomplete/`. It auto-discovers on Pi restart or `/reload`.

## Configuration

All settings have sensible defaults. Override via environment or extension config:

```typescript
{
  triggerChar: "!",           // trigger character
  maxDropdownItems: 15,        // max items in dropdown
  zshCompletionTimeoutMs: 3000, // timeout for zsh queries
  commandsCacheTtlMs: 30000,   // command list cache TTL
  positionalCacheTtlMs: 15000, // positional completion cache TTL
  ai: {
    enabled: true,
    modelPath: "../models/starcoder2-3b-Q4_K_M.gguf",
    debounceMs: 400,
    maxTokens: 20,
    contextSize: 2048,
  },
  ghost: {
    color: "\x1b[38;5;244m", // gray
  },
}
```

## Model Download

```bash
# Download starcoder2-3b (Q4_K_M quantized, ~2GB)
cd ~/.pi/agent/models
curl -LO https://huggingface.co/bartowski/starcoder2-3b-GGUF/resolve/main/starcoder2-3b-Q4_K_M.gguf
```

## Known Issues

- **Zsh positional completions via zpty can be slow** — first completion may take ~500ms. Results are cached.
- **Model loading blocks first use** — the AI model loads lazily on first `!` input, which may cause a brief delay.
- **No bash/fish support yet** — zsh only. Multi-shell support is designed for future addition.
