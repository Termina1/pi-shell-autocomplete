## 1. Configuration Updates

- [x] 1.1 Add `modelPriority: string[]` field to `AiConfig` with default priority list (qwen2.5-coder-3b, qwen2.5-coder-1.5b, starcoder2-3b, deepseek-coder-1.3b)
- [x] 1.2 Add `fileContext: { enabled: boolean; maxFiles: number }` to `AiConfig` with defaults `{ enabled: true, maxFiles: 20 }`
- [x] 1.3 Add `historyContext: { enabled: boolean; maxEntries: number; historyPath: string }` to `AiConfig` with defaults `{ enabled: true, maxEntries: 10, historyPath: "~/.zsh_history" }`
- [x] 1.4 Update `createConfig()` to deep-merge new nested fields (fileContext, historyContext)
- [x] 1.5 Update config unit tests for new fields and merge logic

## 2. Context Collector Module

- [x] 2.1 Create `context-collector.ts` with `ContextCollector` interface (`getFileContext(): Promise<string[]>`, `getHistoryContext(): Promise<string[]>`)
- [x] 2.2 Implement `createContextCollector(config: AiConfig, cwd: string)` factory
- [x] 2.3 Implement file context collection: `fs.readdir(cwd)`, filter hidden files (`.`), sort (directories first), limit to `maxFiles`
- [x] 2.4 Implement history context collection: read `historyPath` file, take last `maxEntries` lines, strip EXTENDED_HISTORY timestamps (`: 123:0;` prefix)
- [x] 2.5 Handle errors gracefully: `readdir` failure → empty array; history file missing → empty array; 500ms timeout on `readdir`
- [x] 2.6 Write unit tests for ContextCollector: file listing, history parsing (with/without timestamps), error handling, limits

## 3. Model Selection

- [x] 3.1 Update `createModelLoader` to accept `modelPriority: string[]` as parameter (alongside existing `config`)
- [x] 3.2 Implement priority-based model resolution: iterate `modelPriority`, check `fs.existsSync` for each, return first found
- [x] 3.3 Fallback to `modelPath` when `modelPriority` is empty (backward compatibility)
- [x] 3.4 Resolve relative paths against `~/.pi/agent/`; keep absolute paths as-is
- [x] 3.5 Update model loading error handling: set `loadError = true` only if NO model from priority list exists
- [x] 3.6 Write unit tests for model selection: first-priority found, fallback to second, all missing, empty priority, absolute paths

## 4. AI Completer Updates

- [x] 4.1 Update `AiCompleter` constructor to accept `ContextCollector` as injected dependency
- [x] 4.2 Implement new `buildPrompt(token, items, fileCtx, histCtx)` method — structured format with optional sections
- [x] 4.3 Integrate context collection into `predict()`: fetch file + history context before constructing prompt
- [x] 4.4 Skip context collection when config disables a source (`fileContext.enabled = false`, etc.)
- [x] 4.5 Update cache key to include context hash — `predict()` uses `${token}|${contextHash}` instead of bare token
- [x] 4.6 Generate context hash from sorted file list + last history entry (cheap, avoids full equality)
- [x] 4.7 Ensure context collection failure doesn't block AI inference (proceed with available sources)
- [x] 4.8 Write unit tests: prompt format with all sources, prompt with no extras, context-aware cache miss, error resilience

## 5. Extension Entry Point Wiring

- [x] 5.1 Create `ContextCollector` instance in `index.ts` with `process.cwd()` on `session_start`
- [x] 5.2 Pass `ContextCollector` to `AiCompleter` constructor
- [x] 5.3 Pass `modelPriority` to `createModelLoader` when creating `AiCompleter`
- [x] 5.4 Verify backward compatibility: existing configs without new fields work unchanged
- [x] 5.5 Manual smoke test: type `!git c` → dropdown + ghost text appear, verify new prompt format in debug

## 6. Tests

- [x] 6.1 Update existing `AiCompleter` unit tests to pass mock `ContextCollector`
- [x] 6.2 Add unit tests for `buildPrompt` with all combinations of enabled/disabled sources
- [x] 6.3 Add unit tests for cache invalidation when context changes
- [x] 6.4 Add unit tests for `createModelLoader` with priority-based selection
- [x] 6.5 Add unit tests for `ContextCollector` file and history reading
- [x] 6.6 Run full test suite (`npm test`), ensure all existing tests still pass

## 7. Documentation

- [x] 7.1 Update README: document new config fields (`modelPriority`, `fileContext`, `historyContext`)
- [x] 7.2 Add recommended model download instructions for qwen2.5-coder GGUF
- [x] 7.3 Document fallback behavior: qwen → starcoder → deepseek → no ghost text
- [x] 7.4 Add privacy note: file names and shell history are processed locally, never leave the machine
