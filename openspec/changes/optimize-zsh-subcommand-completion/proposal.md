## Why

Positional (subcommand/flag) completion via zsh is the slowest part of the autocomplete UX. Every query in `zsh-pty.ts` spawns a brand-new interactive zsh PTY, runs `compinit` again, and uses two hardcoded delays (≈500ms for compinit + ≈600ms for the Tab response), totaling >1100ms before the first item appears. Cache hits are fast, but cache misses dominate perceived latency on real-world typing where each keystroke produces a different token. The current implementation wastes work by re-doing zsh startup, re-loading completion functions, and using fixed sleeps instead of detecting actual readiness.

## What Changes

- Replace per-query zsh PTY spawn with a **persistent zsh worker** that is started once (lazily on first query or pre-warmed at extension activation) and reused for all subsequent queries.
- Drive completion inside the worker via zsh's **`zpty` + `_main_complete`** protocol (or equivalent capture builtin) instead of literal Tab keypresses, so output is clean and ANSI-free and there is no need to wait for a visual prompt.
- Use a **sentinel-based protocol** (per-query unique markers) to detect exact start/end of completion output instead of hardcoded `setTimeout` delays.
- Persist a fixed `compinit` dump path (`compinit -d <stable-path>`) so the worker's first compinit is fast and idempotent across launches.
- Make the worker process **resilient**: auto-respawn on exit/timeout/error, hard per-query timeout (configured `zshCompletionTimeoutMs`), and a global request queue so concurrent queries are serialized through the single zsh process.
- Keep existing public API of `ZshCompleter.getCompletions()` unchanged; only the internal `zsh-pty.ts` transport changes.
- Tighten the cache: dedupe **in-flight** queries (concurrent calls for the same token share a single worker round-trip — this is already required by the spec but currently bypassed because each call enters `getOrLoad` separately on a miss).
- **BREAKING (internal only)**: `captureCompletions(token, config)` is replaced by a stateful `ZshWorker` class with `query(token)`/`dispose()`. No public extension API breaks.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `zsh-native-completion`: Tighten requirements around positional-completion latency, persistent worker process, sentinel-based output framing, and in-flight request deduplication. The high-level behavior (querying zsh for completions, caching, timeout/failure handling) is preserved; the new requirements add performance guarantees and a persistent-worker model.

## Impact

- **Code**: `zsh-pty.ts` is rewritten as a persistent `ZshWorker`. `zsh-completer.ts` instantiates the worker once and routes `getCompletions()` through it; `queryPositionalCompletions()` becomes a thin wrapper. Disposal hook needed somewhere in the extension lifecycle (process exit / `dispose()`).
- **Config**: New optional fields — `zshWorker.prewarm` (boolean, default `true`), `zshWorker.idleTimeoutMs` (number, default `0` = never), `zshWorker.compinitDumpPath` (string, default `~/.cache/pi-shell-autocomplete/zcompdump`). Existing `zshCompletionTimeoutMs` is reused as per-query timeout.
- **Tests**: `__tests__/zsh-completer.test.ts` continues to mock the transport (now `ZshWorker`). New unit tests for the worker covering: sentinel framing, queueing, timeout, auto-respawn, in-flight dedupe. Integration test under `__tests__/integration/` measuring p50/p95 of warm-cache-miss queries against a real zsh.
- **Dependencies**: No new npm deps; continues to rely on `node-pty`.
- **User-facing**: Faster first-completion latency (target p50 <150ms after warmup, vs. >1100ms today), no behavioral change to dropdown contents.
- **Risk**: Persistent zsh process consumes ~10–30 MB RAM and one PTY for the lifetime of the editor; mitigated by idle-timeout option and proper disposal on extension shutdown.
