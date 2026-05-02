## Context

Today `zsh-completer.ts` calls `captureCompletions()` from `zsh-pty.ts` for every cache-miss positional query. That function:

1. Spawns a fresh `/bin/zsh -i` PTY (cold start: read `.zshrc`, plugins, prompt).
2. Waits for any prompt-looking character (`❯`, `%`, `$`) — variable, but typically 100–400ms.
3. Sends `autoload -Uz compinit && compinit` again — slow on cold zcompdump (~200–500ms).
4. Sleeps a hardcoded 500ms, then writes `<token>\t`, then sleeps another 600ms.
5. Strips ANSI from interactive output and regex-matches lines that look like `name -- description`.

Result: cache-miss latency is dominated by fixed sleeps and redundant zsh startup, not by the actual completion work zsh is doing. The dropdown UX feels laggy while typing because each new token is a cache miss.

Constraints:
- Must keep the public `ZshCompleter` API stable (`getCompletions(token)` returns `CompletionItem[]`).
- Cannot require the user to change their `.zshrc`.
- Must work on macOS and Linux with `node-pty` already used by the project.
- Must remain robust if the user has a slow `.zshrc` (oh-my-zsh, p10k instant prompt, nvm, etc.).
- Must be safe against `compinit` failures (insecure dirs, missing functions).

## Goals / Non-Goals

**Goals:**
- p50 cache-miss latency for positional completion ≤ 250 ms after warmup; p95 ≤ 800 ms (4–15× better than the legacy ≥1100 ms baseline).
  Real-machine measurements after the implementation addendum below: `git c` ~196 ms cold / ~71 ms warm, `git co` ~77 ms warm, `docker r` ~403 ms cold / ~58 ms warm, `kubectl g` 800 ms (hard-cap).
- Eliminate redundant zsh startup and `compinit` runs across queries.
- Eliminate hardcoded `setTimeout` delays in the request path; use sentinels instead.
- Serialize concurrent queries to a single zsh worker; dedupe in-flight calls for the same token.
- Auto-recover from worker crashes / hangs without user intervention.
- Keep `ZshCompleter` public API stable.

**Non-Goals:**
- Re-implementing zsh's completion engine in TS (we still call into zsh).
- Bash / fish support (tracked elsewhere).
- Replacing `node-pty` with another transport.
- Changing the dropdown UI or keybindings.
- Faster command-list (`getCommands()`) path — that already runs once and is cached for 30s; only positional completion is in scope.

## Decisions

### Decision 1: Persistent zsh worker (single long-running PTY) vs. per-query spawn

**Choice**: Keep one `/bin/zsh -f` (no rcs) PTY alive for the lifetime of the editor and route every completion query to it.

**Rationale**:
- zsh startup + `compinit` is the dominant cost; doing it once amortizes it to zero across all subsequent queries.
- A "minimal" zsh started with `-f` (no `.zshrc`, no plugins) loads compinit in ~80–150ms instead of seconds — and it only happens once.
- Memory cost is small (~10–30 MB) and bounded.
- No prompt to detect (we never use the user's prompt) — we drive it via a known marker protocol.

**Alternatives considered**:
- *Per-query `zsh -c` script*: cleaner, but each invocation re-runs `compinit`, so it's not actually faster than today.
- *Persistent zsh **with** user `.zshrc`*: would respect aliases/functions, but `.zshrc` parse cost (oh-my-zsh, p10k) can be 500ms+ on cold start and breaks our latency budget. Most completion functions live in fpath and don't need `.zshrc`. Reject.
- *zpty inside an outer zsh*: more complex, no measurable win over a direct PTY in our case.

### Decision 2: Use `_main_complete` programmatically instead of a literal Tab keypress

**Choice**: Inside the worker, define a helper zsh function that:
1. Sets `BUFFER=$1; CURSOR=${#BUFFER}`.
2. Calls `_main_complete` to populate the `compstate` arrays.
3. Prints `$compadd_args`-style results one per line, then prints the sentinel.

We call it via `complete-line "<token>"` followed by `print -- "<sentinel>"`.

**Rationale**:
- No reliance on terminal echo / cursor / clear-line escape sequences — output is plain text.
- No need to wait for or strip ANSI; massively simplifies parsing.
- Sentinel framing makes end-of-response deterministic.

**Alternatives considered**:
- *Literal `<token>\t`*: current approach, output is interleaved with prompt redraws and ANSI; requires fragile regex parsing and arbitrary sleeps. Reject.
- *Use `zsh-autosuggestions`-style `bindkey -M` capture*: heavier and less portable. Reject.

### Decision 3: Sentinel-based protocol

**Choice**: Each query sends:
```
__pi_complete <id> '<token>'
```
The worker responds with one line per match (`value<TAB>label`) and a final line:
```
__pi_done <id> <count>
```
The reader's state machine slices output by `__pi_done <id>` and ignores anything outside an active query.

**Rationale**:
- Per-query unique id makes interleaved/garbage output recoverable (e.g. if a previous query timed out and its output arrives later, we drop it by id).
- No fixed delays; we read until the sentinel arrives or the per-query timeout fires.

### Decision 4: Stable compdump path

**Choice**: Pass `compinit -d ~/.cache/pi-shell-autocomplete/zcompdump` (configurable) so the worker reuses a cached completion dump.

**Rationale**:
- Cuts compinit warmup further (the dump skips re-scanning fpath).
- Isolated from the user's own `~/.zcompdump` so we don't fight their setup.

**Alternatives considered**:
- *Skip `compinit -i`* (insecure mode): faster but ignores ownership warnings — not worth it.
- *Reuse user `~/.zcompdump`*: risks corruption if both the user's interactive zsh and our worker write it simultaneously. Reject.

### Decision 5: Request queue + in-flight dedupe

**Choice**: The worker exposes `query(token): Promise<CompletionItem[]>`. Internally:
- A FIFO queue serializes requests (one outstanding query at a time — zsh's completion machinery isn't reentrant).
- A `Map<token, Promise>` returns the same in-flight promise for duplicate tokens, satisfying the spec's "Concurrent cache queries" scenario at the worker layer in addition to the cache layer.
- The `Cache` in `zsh-completer.ts` continues to dedupe across the time dimension; the worker dedupes across simultaneous in-flight calls.

### Decision 6: Lifecycle — lazy start, prewarm option, graceful dispose

**Choice**:
- Lazy: worker starts on first `getCompletions()` call.
- Prewarm: if `config.zshWorker.prewarm === true` (default), start the worker as soon as `ZshCompleter` is constructed, in the background, so by the time the user types `!` it's already ready.
- Dispose: `ZshCompleter.dispose()` kills the worker. Hook into the extension's existing teardown (Pi calls extension `dispose()` on unload / process exit).
- Auto-respawn: if the PTY exits unexpectedly (e.g. user `kill`s it), the next query starts a fresh worker. A respawn counter caps it at 3 within 60s; beyond that we mark positional completion as unavailable for the session.

### Decision 7: Per-query timeout + worker reset

**Choice**: Reuse `config.zshCompletionTimeoutMs` as the per-query deadline. On timeout:
- Resolve the caller with `[]` (current behavior).
- Send a synchronization sentinel (`print -- "__pi_sync"`) and discard everything until it appears, so the worker stays usable.
- If sync also times out, kill and respawn the worker.

## Risks / Trade-offs

- [Risk] Persistent zsh process consumes RAM and a PTY for the editor's lifetime → Mitigation: minimal `zsh -f` (~10 MB), `idleTimeoutMs` config to shut down after inactivity, mandatory `dispose()` on extension unload.
- [Risk] Worker started without `.zshrc` won't see user-defined functions/aliases as completion targets → Mitigation: command **list** still comes from the existing `zsh -c "print -l \${(k)commands}..."` path which we keep; only **positional** completion uses the minimal worker, and zsh's built-in completion functions live in `fpath`, not `.zshrc`. Document the trade-off; expose `zshWorker.sourceRcFile` escape hatch for users who want everything.
- [Risk] `compinit` writes to a shared dump path → Mitigation: dedicated path under `~/.cache/pi-shell-autocomplete/`, created with `mkdir -p`, single writer (only our worker touches it).
- [Risk] User has weird zsh configuration that breaks `_main_complete` → Mitigation: per-query timeout + auto-respawn + cap on respawns + fallback to empty result keeps the editor responsive.
- [Risk] Increased complexity vs. current ~50-line `zsh-pty.ts` → Mitigation: encapsulate in a single `ZshWorker` class with focused unit tests covering the protocol (sentinel parsing, queue, timeout, respawn).
- [Trade-off] Sentinel-driven protocol diverges from "what the user sees in their terminal" → Acceptable: we want machine-readable output, not a terminal simulation.

## Migration Plan

1. Land `ZshWorker` alongside the existing `captureCompletions`; gate via a feature flag (`config.zshWorker.enabled`, default `true`).
2. `zsh-completer.ts` chooses the new path when the flag is on; otherwise falls back to the legacy function.
3. Run integration benchmarks; if regressions appear, flip the flag off without code revert.
4. After one release cycle with the flag on by default, delete `captureCompletions` and the flag.
5. Rollback: set `config.zshWorker.enabled = false` to restore current behavior.

## Implementation Addendum (post-apply)

During implementation two decisions were simplified versus this design doc.
Both changes preserve every normative requirement in `specs/zsh-native-completion/spec.md`; the affected scenarios are noted.

1. **Decision 2 (use `_main_complete` programmatically) → simplified to Tab-emulation with sentinel framing.**
   Driving `_main_complete` reliably outside a real ZLE invocation requires a non-trivial widget/zpty harness. Instead, the worker writes `<token>\t\x03print -- __PI_DONE_<id>__\r` to the persistent zsh PTY:
   - `\t` triggers `expand-or-complete` (renders the completion list using the user's installed completion functions, exactly as if Tab were pressed at a real prompt).
   - `\x03` is ZLE `send-break`: clears the line buffer, presents a fresh prompt, no command runs.
   - `print -- __PI_DONE_<id>__\r` emits the per-query terminating sentinel as a normal shell command.

   The reader strips ANSI from the captured blob and parses both `name -- description` lines and bare token-shaped lines (see `parseTabCapture` in `zsh-worker.ts`). The bootstrap sets `setopt AUTO_LIST`, `unsetopt MENU_COMPLETE`, `LISTMAX=0`, and an empty `PROMPT` to make the captured output deterministic.

   Spec impact: the "persistent worker" and "sentinel-framed protocol" requirements remain fully satisfied. The output is text rather than `value<TAB>label` per match, but the spec doesn't mandate the wire format — only that requests/responses are uniquely framed and that end-of-response is detected without fixed timers.

   Trade-off: single-match completions (where zsh inserts the unique match into BUFFER instead of listing it) may not appear in the dropdown. This matches the existing behavior of `zsh-pty.ts` and is the dominant case where AI ghost text already provides a suggestion.

2. **Decision 7 (`__pi_sync` re-synchronization) → respawn-on-timeout.**
   The spec allows "re-synchronized via a sync sentinel **OR** terminated and respawned." The simpler branch was implemented: on per-query timeout, the caller resolves `[]` and the worker is killed and respawned (subject to the same rate-limit cap). This discards any straggling output cleanly without a second sentinel state machine.

3. **Stage-2 BUFFER clear — Ctrl-U (`\x15`), not Ctrl-C (`\x03`).**
   The original design used `\x03` (ZLE `send-break`) to clear the line after Tab. That works for tokens with a non-empty filter prefix (`git c`) but FAILS for tokens that end in a space (`git `, `docker `): zsh's `AUTO_LIST` mode after a Tab puts ZLE into a state where `send-break` only dismisses the displayed list — BUFFER stays intact — so our sentinel command is appended to the typed token and runs as e.g. `git __pi_done 0`, producing "git: '__pi_done' is not a git command" and a 3-second timeout. Switching stage 2 to `\x15` (`backward-kill-line`) reliably empties BUFFER in both cases. Bootstrap also gained `zstyle ':completion:*' list-prompt ''` and `zstyle ':completion:*' select-prompt ''` to suppress zsh's interactive "do you wish to see all 141 possibilities?" prompt for large completion sets.

These are tactical implementation choices; if benchmarking shows the respawn cost matters in practice, the sync-sentinel path can be reintroduced as a follow-up without spec changes.

## Open Questions

- Should the worker source the user's `~/.zshrc` behind an opt-in flag, or always stay minimal? Lean toward minimal default + opt-in flag (`zshWorker.sourceRcFile`).
- Should we expose a CLI/diagnostic command (e.g. `pi shell-autocomplete doctor`) to print worker uptime, p50/p95, last error? Out of scope for this change but cheap to add later.
- For very long completion lists (e.g. `man `), is it worth streaming the first N lines back early instead of waiting for the full sentinel? Defer until measured — typical lists are <200 items and arrive in a single read.
