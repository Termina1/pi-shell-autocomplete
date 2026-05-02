## Context

Today `ai-completer.ts` builds a FIM prompt from three optional sections: compinit hits (`# Choose one option...`), recent shell history (`# Recent commands:`), and directory listing (`# Files in directory:`). Each is a plain `# comment` line. The `suffix` is always empty string. The model receives this as a `generateInfillCompletion(prefix, suffix)` call with `temperature: 0` (node-llama-cpp default).

Problem: instruct models (qwen2.5-coder-instruct, deepseek-coder-instruct) are trained to follow role-based instructions. Given only comment lines and a partial token, they behave as bare completion models — statistically continuing text rather than reasoning about intent. The `temperature: 0` makes output deterministic, so a wrong prediction repeats forever.

The `context-collector.ts` exposes `getFileContext()` and `getHistoryContext()` — two source methods. Adding more sources requires extending the interface and wiring them into `AiCompleter.predictAsync()`.

Constraints:
- Must not break existing configs — all new fields need defaults that preserve current behavior.
- Context collection must not block the UI — each source must have its own timeout.
- Must work with existing models (qwen2.5-coder, starcoder2, deepseek-coder) via node-llama-cpp FIM API.
- Conversation context requires access to Pi `sessionManager`, which is available in `ExtensionContext` during `session_start`.

## Goals / Non-Goals

**Goals:**
- Make AI ghost text predictions more relevant by providing richer context (git state, project type, conversation).
- Give the model a role instruction so it reasons about intent, not just continues text.
- Allow configurable temperature for prediction variety.
- Keep all new context sources independently configurable and default-enabled where safe.
- Maintain backward compatibility — existing configs work without changes.

**Non-Goals:**
- Streaming ghost text (token-by-token as model generates).
- Showing multiple ghost text alternatives simultaneously (top-N cycling).
- Larger models (7B+) — memory/performance is out of scope.
- Fine-tuning a custom model for shell completions.
- Changing the dropdown UI, keybindings, or zsh-worker transport.

## Decisions

### Decision 1: Instruct-style prompt vs. bare comment format

**Choice**: Replace the current bare `# comment` prompt with an instruct-style role prompt that tells the model what it is and what to do.

**Format**:
```
You are a shell command autocomplete predictor. Given context about the project,
recent activity, and the conversation, predict the most likely completion for
the partial command. Output ONLY the completion text — no explanations, no
formatting, no markdown.

[SECTION: Git]
branch=feature/auth, M src/auth.ts, M src/login.ts

[SECTION: Project]
npm package "my-app" — scripts: test, build, dev

[SECTION: Recent Commands]
git status
npm test

[SECTION: Directory]
src/  package.json  README.md

Complete: git c
```

**Rationale**:
- Instruct models (all three in the priority list) are explicitly trained to follow role instructions. Giving them a clear task improves output quality.
- Structured sections with labels make the context parseable by the model.
- "Output ONLY the completion text" prevents the model from generating explanations or markdown.
- The format is neutral enough to work with both FIM (`generateInfillCompletion`) and regular completion if we ever switch.

**Alternatives considered**:
- *Keep current `# comment` format*: No signal improvement. Reject.
- *ChatML / OpenAI-style system/user messages*: node-llama-cpp FIM API doesn't support multi-message format. Reject.
- *Put role in suffix instead of prefix*: FIM models are trained to complete the MIDDLE, not to read instructions in suffix. Reject.

### Decision 2: Temperature parameter

**Choice**: Add `ai.temperature: number` (default `0.3`) and pass it to `generateInfillCompletion({ maxTokens, temperature })`.

**Rationale**:
- `temperature: 0` always picks the most probable token — deterministic and boring.
- `0.3` allows some variety without becoming random. The model can explore different completions for ambiguous tokens.
- User-configurable — set to `0` to restore current behavior, `0.7+` for creative suggestions.

**Alternatives considered**:
- *Fixed 0.3, not configurable*: Less flexible. Reject.
- *Temperature per token complexity*: Over-engineering for this scope. Reject.

### Decision 3: Git context via shell execution

**Choice**: Add `getGitContext()` to `ContextCollector`. When `ai.gitContext.enabled` is `true`, execute `git branch --show-current`, `git status --short`, and `git log -1 --oneline` via `pi.exec()` with a 2000ms timeout. Parse output and build a structured section. Cache the result with a configurable TTL (`ai.gitContext.cacheTtlMs`, default 10000ms).

**Rationale**:
- Git is the dominant VCS among Pi users and provides the strongest intent signal: changed files, current branch, recent commit.
- Shelling out to `git` is cheap (~20-50ms locally) but calling it on every keystroke during rapid typing wastes CPU.
- 10-second cache means git status is re-queried roughly once per "command thought" rather than once per character typed.

**Alternatives considered**:
- *Read `.git` directory directly*: Fragile, misses in-progress states (rebase, merge). Reject.
- *JGit / isomorphic-git*: New dependency, slower. Reject.
- *No caching*: Wastes ~20-50ms per keystroke; 10s TTL eliminates 90%+ of git queries. Reject.

### Decision 4: Project context via filesystem detection

**Choice**: Add `getProjectContext()` to `ContextCollector`. When `ai.projectContext.enabled` is `true`, check for known project files in cwd (`package.json`, `Dockerfile`, `Cargo.toml`, `Makefile`, `requirements.txt`, `pyproject.toml`, `go.mod`). For `package.json`, extract `name` and `scripts` keys. For others, record file presence. Build a section like `npm package "my-app" — scripts: test, build, dev`. Cache the result with a configurable TTL (`ai.projectContext.cacheTtlMs`, default 60000ms).

**Rationale**:
- Nearly free (`fs.existsSync` on ~10 known paths).
- Tells the model which ecosystem to predict commands for (npm, docker, cargo, make, pip, go).
- Extracting `scripts` from `package.json` is the highest-value signal — the model can suggest `npm run build` instead of a random command.
- 60-second cache is appropriate: project structure doesn't change during a typical command-typing session.

**Alternatives considered**:
- *Detect from opened files in Pi*: Pi has no "opened files" concept. Reject.
- *Run `npm ls`, `cargo metadata` etc.*: Heavy, slow, not worth the latency. Reject.

### Decision 5: Conversation context from session manager

**Choice**: Add `getConversationContext()` to `ContextCollector`. Accept `ReadonlySessionManager` at construction time. On each call, walk `sessionManager.getBranch()` from the current leaf, filter for the most recent `user` and `assistant` messages, truncate each to fit within `ai.conversationContext.maxChars` total. Build a section like:
```
[SECTION: Conversation]
User: Пофикси ошибку в authService
Assistant: Проблема в token.ts, нужно обновить expiry логику
```
Cache the result with a configurable TTL (`ai.conversationContext.cacheTtlMs`, default 5000ms).

**Rationale**:
- The Pi session contains the exact conversation the user is having — the strongest intent signal available.
- `ReadonlySessionManager` is already available in `session_start` event handler via `ctx.sessionManager`.
- Capped by character limit to avoid bloating the prompt.
- 5-second cache avoids re-walking the session tree on every keystroke during rapid typing.

**Alternatives considered**:
- *Listen to `input`/`message_end` events and cache*: Works but duplicates state that session manager already tracks. Simpler to query on-demand with TTL cache.
- *Include all messages in branch*: Would exceed context window. Reject.
- *Summarize conversation*: Over-engineering. Truncation is sufficient.

### Decision 6: Context source caching

**Choice**: Each context source method (`getGitContext`, `getProjectContext`, `getConversationContext`) wraps its collection logic in a time-based TTL cache using the existing `Cache` class from `cache.ts`. The cache sits INSIDE the collector method, transparent to the caller.

**TTL defaults**:
- `gitContext.cacheTtlMs`: 10000 (10s) — git status changes between commands, not keystrokes.
- `projectContext.cacheTtlMs`: 60000 (60s) — project structure is essentially static.
- `conversationContext.cacheTtlMs`: 5000 (5s) — conversation advances slowly, but should refresh between turns.

**Rationale**:
- `predictAsync()` is called on every debounced keystroke. Without caching, `git status --short` would run for every character typed (`!g` → `!gi` → `!git` → `!git ` → `!git c`...).
- Caching reduces git shell-outs by 90%+ (from ~5-10 calls per command-typing session to 1).
- Uses the same `Cache` class already used by `ZshCompleter` for command/positional caching — zero new infrastructure.
- Configurable TTL per source allows users to tune for their workflow.

**Alternatives considered**:
- *Global cache keyed by context type*: Works but the existing per-collector pattern is simpler and more testable. Reject.
- *Cache at `predictAsync` level (one cache for all sources)*: Coarser granularity — git wouldn't refresh until all sources expire. Reject.

### Decision 7: Parallel context collection with per-source timeout

**Choice**: All context sources (file, history, git, project, conversation) are collected via `Promise.allSettled` with individual timeouts, so a slow or failing source doesn't block others.

**Rationale**:
- Already the pattern in `predictAsync()` (file + history are collected in parallel).
- Git and project context are fast (~10-50ms) but network FS or broken git repos could hang.
- Each source has its own try/catch; failure is silent (empty section).

### Decision 8: Configuration structure

**Choice**: Add fields to `AiConfig` following the existing `fileContext`/`historyContext` pattern:

```typescript
interface AiConfig {
  // ...existing fields...

  /** Temperature for model inference (default: 0.3) */
  temperature: number;

  /** Git context settings */
  gitContext: {
    enabled: boolean;       // default: true
    maxStatusLines: number; // default: 15
    cacheTtlMs: number;     // default: 10000
  };

  /** Project context settings */
  projectContext: {
    enabled: boolean;       // default: true
    cacheTtlMs: number;     // default: 60000
  };

  /** Conversation context settings */
  conversationContext: {
    enabled: boolean;       // default: true
    maxChars: number;       // default: 500
    cacheTtlMs: number;     // default: 5000
  };
}
```

**Rationale**:
- Consistent with existing `fileContext`/`historyContext` pattern.
- Each source independently togglable.
- Conservative defaults (enabled, reasonable limits).

## Risks / Trade-offs

- [Risk] Git commands may fail or hang on network filesystems (NFS, SSHFS) → Mitigation: 2000ms per-command timeout, `Promise.allSettled`, silent fallback.
- [Risk] `package.json` may be enormous (monorepo root) → Mitigation: `fs.readFile` with 64KB cap, JSON parse in try/catch, fallback to presence-only.
- [Risk] Conversation context may leak sensitive information into the local model prompt → Mitigation: all processing is local. Model runs in-process via node-llama-cpp. No data leaves the machine. Same privacy model as existing file/history context. User can disable via `conversationContext.enabled: false`.
- [Risk] Temperature > 0 may occasionally produce nonsensical completions → Mitigation: existing validation (trim, length < 100, must extend token) catches most garbage. Temperature is configurable.
- [Trade-off] Instruct prompt is longer (~200-400 chars of role + section headers) vs. bare format → Acceptable: models have 2048-token context windows; the additional tokens are negligible compared to the quality improvement.

## Migration Plan

1. Land all changes behind existing config structure — no breaking changes.
2. New defaults (`temperature: 0.3`, all new contexts enabled) take effect immediately.
3. Users who want the old behavior can:
   - Set `ai.temperature: 0` for deterministic predictions.
   - Set `ai.gitContext.enabled: false`, `ai.projectContext.enabled: false`, `ai.conversationContext.enabled: false` for old prompt format.
   - The old `# comment` format is replaced; no flag to restore it (the role prompt is strictly better).
4. Rollback: set all new context `enabled` flags to `false` and `temperature` to `0`. This restores behavior equivalent to today (minus the exact prompt string format, which is not user-visible).

## Open Questions

- Should conversation context include tool call results (e.g., `read` output) or only user/assistant text messages? Lean toward text only — tool results can be enormous.
- Should `maxStatusLines` limit apply per-section or globally? Per-section (each git status entry is ~1 line).
- Should we add a `pi.exec` call to check `git` availability before attempting git context? Yes — avoid spawning a process that will fail.
