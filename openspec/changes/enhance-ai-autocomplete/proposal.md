## Why

The AI ghost text feels useless because the model has almost no signal about the user's intent. Currently it sees only a flat list of 8 matching commands, a few recent shell commands, and directory file names — all in a bare `# comment` format with no role or instruction. An instruct model given no role behaves like a statistical autocompleter: it picks the first option alphabetically or the most common word from its training data. The result is that `!git c` always predicts `checkout` regardless of whether the user is in the middle of a rebase, has modified auth files, or just discussed fixing a token bug with the AI. Combined with `temperature=0`, the prediction is deterministic and never changes.

## What Changes

- **Instruct-style role prompt**: Replace bare `# comment` sections with a system instruction telling the model it is a shell command predictor. Include task framing (`Complete: <token>`) so the model knows this is a completion request, not a continuation.
- **Configurable temperature** (`ai.temperature`, default 0.3): Allow non-zero temperature so the model can produce different predictions for the same input instead of always returning the same result.
- **Git context** (`ai.gitContext`): Include current branch, modified/staged/untracked files, and last commit message. The model sees what the user is working on.
- **Project context** (`ai.projectContext`): Detect project type from `package.json`, `Dockerfile`, `Cargo.toml`, etc. and include relevant tooling hints (e.g., available npm scripts).
- **Conversation context** (`ai.conversationContext`): Include the most recent user message and assistant response from the Pi session, capped by character limit. The model sees what the user and AI just discussed.
- All new context sources are independently configurable (enabled/disabled) with sensible defaults, matching the existing pattern for file and history context.

## Capabilities

### New Capabilities
<!-- None — all changes modify existing capabilities. -->

### Modified Capabilities
- `ai-ghost-completion`: Add temperature parameter to `AiConfig` and pass it to model inference. Change prompt format from bare `# comment` sections to instruct-style with a role instruction and task framing.
- `ai-context-enrichment`: Add three new context sources (git, project, conversation) to the `ContextCollector` interface, each independently configurable and collected in parallel with existing file and history sources.

## Impact

- **Code**: `ai-completer.ts` — rewritten `buildPrompt()` with instruct format. `context-collector.ts` — three new collector methods. `config.ts` — four new config fields (`temperature`, `gitContext`, `projectContext`, `conversationContext`). `index.ts` — pass `sessionManager` to context collector.
- **Config**: Backward-compatible — all new fields have defaults; existing configs continue to work.
- **Tests**: Unit tests for new prompt format, each new context collector, temperature propagation, and integration of all sources.
- **Dependencies**: No new npm deps. Git context uses `git` CLI via existing `pi.exec()`. Conversation context uses `sessionManager` from Pi `ExtensionContext` (no new API surface).
- **User-facing**: More relevant ghost text predictions. Configurable temperature for variety. All new context sources can be disabled individually to revert to current behavior.
