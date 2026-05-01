## 1. Project Setup

- [x] 1.1 Create `~/.pi/agent/extensions/shell-autocomplete/` directory structure (index.ts, config.ts, cache.ts, zsh-completer.ts, ai-completer.ts, editor.ts, provider.ts)
- [x] 1.2 Create `package.json` with vitest dev dependency and test scripts
- [x] 1.3 Create `vitest.config.ts` with TypeScript support
- [x] 1.4 Create `__tests__/` directory mirroring source structure
- [x] 1.5 Create Dockerfile with zsh, git, docker CLI, kubectl, and pre-installed completion plugins (zsh-completions, prezto git module)
- [x] 1.6 Create Docker integration test fixtures: `.zsh_history` (sample history), `.zshrc` (compinit + completions), mock PATH binaries

## 2. Configuration Module

- [x] 2.1 Define `ShellAutocompleteConfig` type with all fields (triggerChar, maxDropdownItems, cache TTLs, AI settings, ghost color) and sensible defaults
- [x] 2.2 Implement config loading (defaults + optional override mechanism)
- [x] 2.3 Write unit tests for default values and override merging

## 3. Cache Module

- [x] 3.1 Implement generic `Cache<K,V>` class with TTL expiry, `get(key)`, `set(key, value)`, `has(key)`, `delete(key)`
- [x] 3.2 Implement `getOrLoad(key, loader)` with stampede prevention — returns existing promise for concurrent same-key calls
- [x] 3.3 Implement LRU eviction variant (`LruCache<K,V>`) with configurable max size and eviction count, for AI results
- [x] 3.4 Write unit tests: TTL expiry, concurrent `getOrLoad` dedup, stale-while-revalidate, LRU eviction boundary conditions

## 4. Prefix Extraction Module

- [x] 4.1 Implement `extractShellToken(textBeforeCursor: string, triggerChar: string): string | undefined` — matches `!` followed by token
- [x] 4.2 Handle edge cases: `!` at start of line, `!` after whitespace, `!` with no token, `!` inside other text
- [x] 4.3 Write unit tests for all edge cases

## 5. Zsh Native Completion Module

- [x] 5.1 Spike: determine the correct zsh subshell invocation for programmatic completion queries (command list + positional completions). Validate with real git/docker/kubectl completions.
- [x] 5.2 Implement `ZshCompleter` class: constructor takes config, injected `pi.exec`-like function
- [x] 5.3 Implement `getCommands(): Promise<string[]>` — query zsh for all executables, builtins, functions, aliases; deduplicate; sort
- [x] 5.4 Implement `getCompletions(token: string): Promise<CompletionItem[]>` — query zsh for positional completions of a partial command line; parse into `{value, label}` items
- [x] 5.5 Implement timeout handling (configurable, default 3000ms) — abort on timeout, return empty
- [x] 5.6 Implement error handling — non-zero exit code or unparseable output returns empty silently
- [x] 5.7 Implement caching via `Cache` module — commands cache (30s TTL), positional cache (15s TTL)
- [x] 5.8 Implement availability check — on init, test if zsh + compinit works; if not, notify user once and deactivate
- [x] 5.9 Write unit tests: mock `pi.exec`, verify command parsing, dedup, timeout, error handling
- [ ] 5.10 Write Docker integration tests: real zsh, verify git/docker/kubectl subcommand completions

## 6. AI Ghost Completion Module

- [x] 6.1 Implement `AiCompleter` class: constructor takes config, injected llama factory function, injected cache
- [x] 6.2 Implement lazy model loading: `ensureLoaded()` — async, guarded by loading/error flags, returns model or null
- [x] 6.3 Implement `predict(token: string, contextItems: AutocompleteItem[]): Promise<string | null>` — debounced FIM inference with starcoder2-3b
- [x] 6.4 Implement debounce: clear previous timer, set new one; only latest token triggers inference
- [x] 6.5 Implement result cleaning: take first line, trim, reject if empty or >100 chars
- [x] 6.6 Implement result caching via `LruCache` — keyed by exact token, LRU evict at 200 entries
- [x] 6.7 Implement graceful failure: model load error sets `aiLoadError` flag, inference errors silently skip, dropdown unaffected
- [x] 6.8 Implement retry on new session: reset `aiLoadError` on session_start
- [x] 6.9 Write unit tests: mock llama, verify debounce timing, cache hit/miss, error states, disabled config
- [x] 6.10 Write integration test: real model file (if present), verify prediction output format

## 7. Ghost Text Editor Module

- [x] 7.1 Implement `ShellAutocompleteEditor` extending `CustomEditor`
- [x] 7.2 Implement ghost text storage: `setGhostText(text)`, `clearGhost()`, `getGhostText()`
- [x] 7.3 Implement `render(width)` override: insert ghost text after cursor using `getCursor()` (public API only), apply ghost color, truncate with `…` if exceeds width
- [x] 7.4 Implement `handleInput(data)` override: Tab with ghost → insert ghost; RightArrow at end with ghost → insert ghost; otherwise delegate to `super.handleInput(data)`
- [x] 7.5 Implement `setText(text)` override: clear ghost text on external text change
- [x] 7.6 Implement auto-trigger: after input, if line contains `!` prefix, trigger autocomplete
- [x] 7.7 Write unit tests: ghost insertion via Tab/RightArrow, cursor position edge cases, truncation, clear on setText

## 8. Autocomplete Provider Module

- [x] 8.1 Implement `createShellAutocompleteProvider(current, zshCompleter, aiCompleter, config)` factory
- [x] 8.2 Implement `getSuggestions(lines, cursorLine, cursorCol, options)`: extract token, if shell prefix → query zsh + AI; if not → delegate to current provider
- [x] 8.3 Merge zsh positional completions with default provider results when both apply (e.g., file paths after command)
- [x] 8.4 Implement scoring: prefix match (100pts) > substring match (50pts) > length penalty; sort by score; limit to maxDropdownItems
- [x] 8.5 Implement `shouldTriggerFileCompletion` — return false when shell prefix is active
- [x] 8.6 Fire AI ghost completion as side effect (not awaited by dropdown)
- [x] 8.7 Write unit tests: mock zshCompleter + aiCompleter, verify dropdown items, scoring, delegation, token extraction

## 9. Extension Entry Point

- [x] 9.1 Implement `index.ts` default export: `session_start` handler wires editor + provider
- [x] 9.2 Wire editor: `ctx.ui.setEditorComponent(...)` creates `ShellAutocompleteEditor`, stores ref
- [x] 9.3 Wire AI result callback: when `aiCompleter` produces result, call `editor.setGhostText()` and request render
- [x] 9.4 Wire provider: `ctx.ui.addAutocompleteProvider(...)` wraps zsh + AI completers
- [x] 9.5 Initiate AI model preload on first shell prefix (fire-and-forget)
- [x] 9.6 Write integration test: full extension wiring with mock Pi API, verify editor + provider connected

## 10. Docker Integration Tests (adapted: run on host with zsh via node-pty)

- [x] 10.1 Build Docker image with zsh, git, docker, kubectl, zsh-completions, prezto
- [x] 10.2 Test `ZshCompleter.getCommands()` — returns real commands from zsh environment
- [x] 10.3 Test `ZshCompleter.getCompletions("git c")` — returns `commit`, `checkout`, `clean`, `clone`, `cherry-pick`
- [x] 10.4 Test `ZshCompleter.getCompletions("docker ")` — returns `run`, `build`, `ps`, `images`, etc.
- [x] 10.5 Test `ZshCompleter.getCompletions("kubectl get ")` — returns `pods`, `deployments`, `services`, etc.
- [x] 10.6 Test timeout: slow completion script, verify timeout aborts and returns empty
- [x] 10.7 Test unavailable zsh: run without zsh installed, verify graceful deactivation

## 11. Polish and Documentation

- [x] 11.1 Add JSDoc comments to all public classes and methods
- [x] 11.2 Create README.md in extension directory: installation, configuration, model download, known issues
- [x] 11.3 Verify extension loads correctly with `pi -e` flag
- [x] 11.4 Manual smoke test: type `!git c` → verify dropdown shows git subcommands, ghost text appears, Tab accepts ghost, arrows navigate dropdown, Enter selects
