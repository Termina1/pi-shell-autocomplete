## 1. Configuration

- [x] 1.1 Add `AiConfig.temperature` field (number, default 0.3) to `config.ts`
- [x] 1.2 Add `AiConfig.gitContext` sub-object (`enabled: true`, `maxStatusLines: 15`, `cacheTtlMs: 10000`) to `config.ts`
- [x] 1.3 Add `AiConfig.projectContext` sub-object (`enabled: true`, `cacheTtlMs: 60000`) to `config.ts`
- [x] 1.4 Add `AiConfig.conversationContext` sub-object (`enabled: true`, `maxChars: 500`, `cacheTtlMs: 5000`) to `config.ts`
- [x] 1.5 Update `createConfig()` deep-merge logic to handle new fields with defaults
- [x] 1.6 Update `defaultConfig` with new fields

## 2. Context Collector — New Sources

- [x] 2.1 Add `getGitContext(): Promise<string | null>` method to `ContextCollector` interface
- [x] 2.2 Implement `getGitContext()` in `createContextCollector`: execute `git branch --show-current`, `git status --short`, `git log -1 --oneline` via `pi.exec()` with 2000ms timeout, format as `branch=X, M file1, M file2, last: "msg"`, cache with TTL from `ai.gitContext.cacheTtlMs`
- [x] 2.3 Add `getProjectContext(): Promise<string | null>` method to `ContextCollector` interface
- [x] 2.4 Implement `getProjectContext()` in `createContextCollector`: check existence of `package.json`, `Dockerfile`, `Cargo.toml`, `Makefile`, `requirements.txt`, `pyproject.toml`, `go.mod`; for `package.json` read and extract `name` + `scripts` keys; format as `npm package "name" — scripts: a, b, c` or `docker project` etc., cache with TTL from `ai.projectContext.cacheTtlMs`
- [x] 2.5 Add `getConversationContext(): Promise<string | null>` method to `ContextCollector` interface
- [x] 2.6 Implement `getConversationContext()` in `createContextCollector`: accept `ReadonlySessionManager` at construction, walk `getBranch()` for last user + assistant messages, truncate to `maxChars` total, format as `User: ...` / `Assistant: ...`, cache with TTL from `ai.conversationContext.cacheTtlMs`
- [x] 2.7 Add `gitExec` parameter to `createContextCollector` signature for git command execution (dependency injection for testability)

## 3. AI Prompt — Instruct Format

- [x] 3.1 Rewrite `buildPrompt()` in `ai-completer.ts` to generate instruct-style prompt with role instruction
- [x] 3.2 Implement section builder that adds `[SECTION: Git]`, `[SECTION: Project]`, `[SECTION: Conversation]`, `[SECTION: Recent Commands]`, `[SECTION: Directory]` only when data is non-empty
- [x] 3.3 Add `Complete: <token>` line at the end of the prompt (replaces the bare `<token>` currently at the end)
- [x] 3.4 Update `predictAsync()` to collect all context sources in parallel via `Promise.allSettled`
- [x] 3.5 Pass `config.temperature` to `completion.generateInfillCompletion()` options
- [x] 3.6 Update `makeCacheKey()` to include new context sources (git status, conversation text) in the hash

## 4. Wiring — Index & Provider

- [x] 4.1 Update `index.ts` `session_start` handler to pass `ctx.sessionManager` to `createContextCollector`
- [x] 4.2 Ensure `createContextCollector` receives an executor function for git commands (use existing `pi.exec` wrapper)
- [x] 4.3 Verify conversation context is collected fresh on each prediction call (not cached at construction time)

## 5. Tests

- [x] 5.1 Unit test `resolveModelPath` and `createModelLoader` still work with new config shape
- [x] 5.2 Unit test `buildPrompt()` produces correct instruct format with all sections present
- [x] 5.3 Unit test `buildPrompt()` omits sections when context is empty or disabled
- [x] 5.4 Unit test `buildPrompt()` includes only role instruction when all sources are disabled
- [x] 5.5 Unit test temperature is passed through to `generateInfillCompletion`
- [x] 5.6 Unit test `makeCacheKey()` produces different keys when git/conversation context changes
- [x] 5.7 Unit test `getGitContext()` parsing of `git branch`, `git status --short`, `git log` output
- [x] 5.8 Unit test `getGitContext()` returns null when git commands fail or timeout
- [x] 5.9 Unit test `getGitContext()` uses cache — second call within TTL returns cached result without re-executing git
- [x] 5.10 Unit test `getGitContext()` cache expires — call after TTL re-executes git
- [x] 5.11 Unit test `getProjectContext()` detects npm, docker, multiple project types
- [x] 5.12 Unit test `getProjectContext()` extracts scripts from `package.json`
- [x] 5.13 Unit test `getProjectContext()` uses cache — second call returns cached
- [x] 5.14 Unit test `getConversationContext()` extracts last user + assistant messages
- [x] 5.15 Unit test `getConversationContext()` truncation to `maxChars` limit
- [x] 5.16 Unit test `getConversationContext()` uses cache — second call returns cached
- [x] 5.17 Unit test `predictAsync()` collects all context sources in parallel, tolerates individual failures
- [x] 5.18 Unit test `AiCompleter` accepts new `ContextCollector` with extended interface
