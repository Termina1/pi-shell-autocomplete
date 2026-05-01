# Shell Autocomplete for Pi

`!`-triggered shell command autocompletion inside the Pi TUI editor. Uses zsh's native completion system for commands, subcommands, flags, and arguments. AI ghost text from a local FIM model predicts the rest of your command inline.

## Features

- **`!` prefix autocomplete** — type `!git` and get matching commands; `!git c` and get git subcommands
- **Native zsh completions** — reuses your installed zsh completions (git, docker, kubectl, npm, etc.)
- **AI ghost text** — local FIM model predicts the most likely command completion as dimmed text
- **Smart model selection** — automatically picks the best available model from qwen2.5-coder, starcoder2, or deepseek-coder
- **Context-aware predictions** — AI sees files in your current directory and recent command history for better suggestions
- **Keyboard controls** — Tab accepts ghost text; ↑↓ navigate dropdown; Enter selects

## Requirements

- **zsh** with completions enabled (`compinit` in `.zshrc`)
- **node-llama-cpp** for AI ghost text (optional — autocomplete works without it)
- **Model file**: At least one GGUF model in `~/.pi/agent/models/` (see Model Download)

## Installation

Place the extension in `~/.pi/agent/extensions/shell-autocomplete/`. It auto-discovers on Pi restart or `/reload`.

## Configuration

All settings have sensible defaults. Override via environment or extension config:

```typescript
{
  triggerChar: "!",              // trigger character
  maxDropdownItems: 15,          // max items in dropdown
  zshCompletionTimeoutMs: 3000,  // timeout for zsh queries
  commandsCacheTtlMs: 30000,     // command list cache TTL
  positionalCacheTtlMs: 15000,   // positional completion cache TTL
  ai: {
    enabled: true,
    // Priority-ordered list of GGUF model paths. First existing file is used.
    // Falls back to modelPath if this list is empty.
    modelPriority: [
      "models/qwen2.5-coder-3b-instruct-Q4_K_M.gguf",
      "models/qwen2.5-coder-1.5b-instruct-Q4_K_M.gguf",
      "models/starcoder2-3b-Q4_K_M.gguf",
      "models/deepseek-coder-1.3b-instruct-Q4_K_M.gguf",
    ],
    // Fallback model path (used when modelPriority is empty)
    modelPath: "models/starcoder2-3b-Q4_K_M.gguf",
    debounceMs: 400,
    maxTokens: 40,
    contextSize: 2048,
    // File system context — shows files in current directory to the AI
    fileContext: {
      enabled: true,    // include directory listing in AI prompt
      maxFiles: 20,     // max entries to show
    },
    // Command history context — shows recent commands to the AI
    historyContext: {
      enabled: true,         // include recent commands in AI prompt
      maxEntries: 10,        // max history entries to show
      historyPath: "~/.zsh_history", // path to zsh history file
    },
  },
  ghost: {
    color: "\x1b[38;5;244m", // gray
  },
}
```

### Disabling context sources

To revert to compinit-only predictions (original behavior), disable both sources:

```typescript
ai: {
  fileContext: { enabled: false },
  historyContext: { enabled: false },
}
```

This makes the AI prompt identical to the pre-enhancement format.

## Model Download

**Recommended**: Qwen2.5-Coder (best quality for shell commands)

```bash
cd ~/.pi/agent/models

# Qwen2.5-Coder 3B (recommended, ~2GB)
curl -LO https://huggingface.co/bartowski/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf
```

**Fallback**: StarCoder2-3B (if you already have it)

```bash
# Starcoder2-3b (~2GB)
curl -LO https://huggingface.co/bartowski/starcoder2-3b-GGUF/resolve/main/starcoder2-3b-Q4_K_M.gguf
```

**Model fallback order**: The extension automatically picks the first available model from the priority list:
1. `qwen2.5-coder-3b` → best quality for code/shell completion
2. `qwen2.5-coder-1.5b` → smaller, faster alternative
3. `starcoder2-3b` → original fallback
4. `deepseek-coder-1.3b` → lightweight option

If no model is found, ghost text is silently disabled and autocomplete continues to work normally.

## Privacy

All AI processing happens **locally** on your machine. No data leaves your computer:
- File names and directory structure are only used as context for the local model
- Command history is read from your local `.zsh_history` file and stays on disk
- The llama model runs entirely in-process via node-llama-cpp

## Known Issues

- **Zsh positional completions via zpty can be slow** — first completion may take ~500ms. Results are cached.
- **Model loading blocks first use** — the AI model loads lazily on first `!` input, which may cause a brief delay.
- **No bash/fish support yet** — zsh only. Multi-shell support is designed for future addition.
- **File context on network filesystems** — `fs.readdir` may be slow on NFS/remote mounts. Disable with `fileContext.enabled: false`.
