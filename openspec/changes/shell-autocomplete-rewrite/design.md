## Context

The shell-autocomplete extension provides `!`-triggered command completion inside the Pi TUI editor. It queries zsh's native completion system to get completions for partial command lines, and overlays AI-generated ghost text (from a local FIM model) at the cursor position. The extension is a Pi CustomEditor + AutocompleteProvider combination.

**Constraints:**
- Runs inside Pi's Node.js process (jiti-loaded TypeScript)
- Must not block the TUI event loop (caching, debouncing, async I/O)
- zsh completions depend on the user's `.zshrc` loading `compinit` and completion plugins
- AI model (~3GB starcoder2-3b Q4_K_M) loaded lazily, may not be present

## Goals / Non-Goals

**Goals:**
- Provide completions for any command zsh knows: executables, git/docker/kubectl subcommands, flags, paths
- Show AI ghost text for the most likely completion
- Tab → accept ghost text; ↑↓ → navigate dropdown; Enter → select dropdown item
- Cache zsh completion results and AI predictions with TTL expiry
- Work correctly in zsh environments (macOS, Linux) with standard completion plugins (prezto, oh-my-zsh, zinit)
- Full test suite: unit + Docker integration with real zsh

**Non-Goals:**
- Bash or fish shell support (designed to add later)
- Remote AI API — local model only (starcoder2-3b)
- Classical prefix-matching ghost text fallback (AI ghost only)
- Multi-line command completion
- File/directory completion for shell context (delegates to default provider)

## Decisions

### 1. Module decomposition with dependency injection

```
shell-autocomplete/
├── index.ts              # Entry: wires modules, registers editor+provider
├── config.ts             # Config schema + defaults
├── zsh-completer.ts      # Queries zsh completion system
├── ai-completer.ts       # Manages llama model, debounced inference, result cache
├── cache.ts              # Generic TTL cache with stampede prevention
├── editor.ts             # CustomEditor subclass (ghost text, keyboard bindings)
├── provider.ts           # AutocompleteProvider (dropdown items, merge logic)
└── __tests__/
```

**Rationale**: Each module is independently testable. Dependencies injected via constructor — mock `zsh-completer` to test provider, mock `ai-completer` to test editor. No global mutable state.

**Alternative considered**: Single-file extension like the prototype. Rejected: untestable, hard to extend.

### 2. Querying zsh native completion

The extension spawns a zsh subshell and programmatically queries completions for a partial command line.

**Command discovery (first word — `!git`):**
```bash
zsh -c '
  autoload -Uz compinit && compinit -D
  print -l ${(k)commands} ${(k)builtins} ${(k)functions} ${(k)aliases}
'
```
Zsh's `$commands` contains all PATH executables; `$builtins`, `$functions`, `$aliases` cover the rest. This gives us the full command namespace.

**Positional completion (after space — `!git c`):**
```bash
zsh -c '
  autoload -Uz compinit && compinit -D
  _normal_completion() {
    local words=(${(s: :)1})
    local CURRENT=$#words
    _normal
    zstyle -t ":completion:*" inserted-annotations || compadd -O matches --
    print -l $matches
  }
  _normal_completion "git c"
'
```

The exact mechanism uses zsh's `_normal` completer which dispatches to the correct completion function (`_git`, `_docker`, etc.). The subshell inherits the completion system but runs in a controlled, non-interactive mode.

**Rationale**: This reuses ALL of the user's installed completions — every tool that has a zsh completion function works automatically. No per-tool parsing needed.

**Alternative considered**: Parsing `<cmd> --help` output. Rejected: fragile, tool-specific, misses flags, doesn't handle tools without `--help`, breaks on format changes.

**Alternative considered**: Running zsh with `zpty` to simulate Tab. Rejected: overly complex, hard to debug, fragile across zsh versions.

### 3. Keyboard binding strategy

| Key | Action | Context |
|-----|--------|---------|
| `Tab` | Accept ghost text | When ghost text is visible |
| `Tab` | Navigate dropdown (next item) | When no ghost text OR ghost already accepted |
| `↑/↓` | Navigate dropdown | Always, when dropdown is open |
| `Enter` | Select highlighted dropdown item | When dropdown is open |
| `Esc` | Close dropdown | When dropdown is open |

The editor intercepts Tab before passing to the autocomplete system. If ghost text exists, Tab inserts it and clears ghost. Otherwise, Tab falls through to default Pi dropdown behavior.

**Rationale**: Tab-as-accept is natural for ghost text (same muscle memory as accepting IDE suggestions). Arrow keys for dropdown navigation prevent conflict with ghost text acceptance, and match the mental model of terminal completion menus (like fzf).

### 4. Caching strategy

Three caches, all using the same generic `Cache<K,V>` class with TTL:

| Cache | Key | TTL | Stampede Prevention |
|-------|-----|-----|---------------------|
| Zsh commands | `"commands"` | 30s | Promise dedup |
| Zsh positional completions | `"git c"` (full token) | 15s | Promise dedup |
| AI ghost predictions | token string | ∞ (LRU evict 200) | Debounce timer |

**Stampede prevention**: `Cache.getOrLoad(key, loader)` returns the same promise for concurrent calls with the same key. Only one `loader()` executes; all callers share the result.

**AI cache**: Separate from TTL cache — uses LRU eviction of oldest entries past 200. AI results are deterministic for a given token, so no time-based expiry needed.

### 5. AI model lifecycle

```
startup → lazy load on first `!` input → retry on failure
                                        ↓
                              aiLoadError = true
                              (retry on next session_start or model path change)
```

Model loading happens on the first autocomplete request (not at extension load). Loading is async using `getLlama()` → `loadModel()` → `createContext()`. On failure, the extension continues without AI ghost text — dropdown completions still work.

**Rationale**: Avoids blocking Pi startup. Users without the model file still get full dropdown completion.

### 6. Error handling and graceful degradation

| Failure | Behavior |
|---------|----------|
| zsh not installed / compinit fails | Extension does not activate; user notified once |
| zsh completion timeout (3s) | Return empty results; next keystroke retries |
| AI model load fails | Ghost text disabled; `aiLoadError` flag set; retried on next session_start |
| AI inference fails | Single completion skipped; cache not updated |
| Cache loader throws | Cache serves stale data; error logged |

No single failure breaks the extension. The dropdown (zsh) path is independent of the ghost text (AI) path.

### 7. Configuration

```typescript
interface ShellAutocompleteConfig {
  triggerChar: string;          // default: "!"
  maxDropdownItems: number;     // default: 15
  zshCompletionTimeoutMs: number; // default: 3000
  cacheTtlMs: number;           // default: 30000
  ai: {
    enabled: boolean;           // default: true
    modelPath: string;          // default: "../models/starcoder2-3b-Q4_K_M.gguf"
    debounceMs: number;         // default: 400
    maxTokens: number;          // default: 20
    contextSize: number;        // default: 2048
  };
  ghost: {
    color: string;              // default: "\x1b[38;5;244m" (gray)
  };
}
```

Config can be overridden via Pi extension settings or environment variables. Sensible defaults for everything.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| **zsh completion query is slow** (300ms+ for complex completions like `git log --`) | Cache results per token with TTL. Show stale results while refreshing. 3s timeout prevents blocking. |
| **zsh subshell inherits wrong state** (different PATH, missing plugins) | Run with `-c` (no rc files) but source compinit explicitly. Use `-D` for fast compinit. If user needs rc files, make it configurable. |
| **AI model blocks Node.js event loop during loading** | `getLlama()` and `loadModel()` are async in node-llama-cpp. Inference uses worker threads. No blocking expected, but test on slow hardware. |
| **Ghost text cursor-rendering regex breaks across Pi themes** | Use CustomEditor's public `getCursor()` API (returns `{line, col}`) instead of regex-matching rendered output. Calculate ghost position from cursor coordinates, not cursor glyph. |
| **Memory: 3GB model + 200-entry AI cache** | LRU eviction at 200 entries. Model unloaded on session end if memory pressure detected (future enhancement). |
| **Zsh completion may differ between systems** (homebrew vs linuxbrew PATH) | Docker integration tests with fixed zsh + completions suite. Acceptance: test passes on any zsh with git/docker/kubectl completions. |

## Open Questions

- **How exactly to programmatically capture zsh completion output?** The final mechanism needs a spike — `_normal` with `compadd -O` is the leading approach, but zsh completion internals vary. This is the primary implementation risk.
- **Zsh subshell startup cost**: Does `compinit -D` in a subshell add unacceptable latency? Need to measure — if >100ms, consider a persistent zsh process with IPC.
- **Ghost text positioning without regex**: Can we get the absolute cursor pixel/column position from CustomEditor's render output reliably across themes? The public `getCursor()` returns `{line, col}` but the render position may include borders, padding, etc. Need to verify.
