# ai-ghost-completion Specification

## Purpose
TBD - created by archiving change shell-autocomplete-rewrite. Update Purpose after archive.
## Requirements
### Requirement: Lazy model loading
The AI model SHALL be loaded lazily on the first autocomplete request, not at extension startup.

#### Scenario: First shell prefix triggers model load
- **WHEN** the user types `!` followed by a command prefix for the first time in a session
- **THEN** the model SHALL begin loading asynchronously
- **THEN** the dropdown SHALL show classical completions without ghost text during loading
- **THEN** Pi startup SHALL NOT be blocked by model loading

#### Scenario: Model already loaded
- **WHEN** the user types a shell prefix and the model was previously loaded successfully
- **THEN** the existing loaded model SHALL be used without reloading

### Requirement: AI ghost text prediction
The system SHALL use a local FIM model to predict the most likely completion of a partial shell command and display it as ghost text. The AI prompt SHALL include file system and command history context when enabled.

#### Scenario: Single-token prediction with full context
- **WHEN** the user types `!git co`
- **THEN** the AI model SHALL be queried with fill-in-the-middle completion
- **THEN** the prompt SHALL include available commands from compinit, recent shell history (if enabled), and directory file listing (if enabled)
- **THEN** the result SHALL be a single line, trimmed of whitespace, under 100 characters
- **THEN** if the result extends the user's token (e.g., `git commit`), the suffix SHALL be shown as ghost text

#### Scenario: Prediction with only compinit context (both extras disabled)
- **WHEN** the user types `!git co` and both `fileContext.enabled` and `historyContext.enabled` are `false`
- **THEN** the prompt SHALL include only available commands from compinit (existing behavior)
- **THEN** the result SHALL be processed identically

#### Scenario: Empty or invalid result
- **WHEN** the AI model returns an empty string, only whitespace, or a result longer than 100 characters
- **THEN** no ghost text SHALL be displayed

#### Scenario: Result does not extend token
- **WHEN** the AI model returns text that does not start with the user's current token
- **THEN** no ghost text SHALL be displayed

### Requirement: Debounced input handling
AI model inference SHALL be debounced to avoid excessive computation during rapid typing.

#### Scenario: Debounce during fast typing
- **WHEN** the user types `!g`, then `!gi`, then `!git` in rapid succession (less than the debounce interval apart)
- **THEN** only the LAST token (`!git`) SHALL trigger an AI inference request
- **THEN** intermediate tokens SHALL NOT produce ghost text that appears after later input

#### Scenario: Debounce timer fires after pause
- **WHEN** the user stops typing for the debounce interval (default 400ms)
- **THEN** the AI inference SHALL be triggered for the current token

### Requirement: AI result caching
AI ghost text predictions SHALL be cached by exact input token combined with context hash, with LRU eviction.

#### Scenario: Cache hit with same context
- **WHEN** the user types a token that was previously predicted by AI with the same file and history context
- **THEN** the cached result SHALL be shown immediately without model inference

#### Scenario: Cache miss with different context
- **WHEN** the user types a token that was previously predicted, but the directory contents or history have changed
- **THEN** a new inference SHALL be triggered (context-aware cache key)

#### Scenario: Cache eviction
- **WHEN** the AI cache exceeds 200 entries
- **THEN** the 50 oldest entries SHALL be evicted

### Requirement: Graceful model failure
AI model loading or inference failures SHALL NOT affect the dropdown autocomplete functionality.

#### Scenario: Model file not found
- **WHEN** the model file does not exist at the configured path
- **THEN** no ghost text SHALL be displayed
- **THEN** the dropdown SHALL continue to work normally
- **THEN** the error SHALL NOT be visible to the user

#### Scenario: Inference error
- **WHEN** a single AI inference request fails
- **THEN** that specific completion SHALL be skipped (no ghost text shown)
- **THEN** subsequent inference requests SHALL still be attempted
- **THEN** the dropdown SHALL continue to work normally

### Requirement: Configurable AI settings
AI behavior SHALL be configurable by the user, including model priority, context sources, and all existing settings.

#### Scenario: AI disabled
- **WHEN** the configuration has `ai.enabled = false`
- **THEN** no model SHALL be loaded and no ghost text SHALL be displayed

#### Scenario: Custom model priority
- **WHEN** the configuration specifies `ai.modelPriority = ["models/my-model.gguf"]`
- **THEN** the system SHALL attempt to load models in that priority order

#### Scenario: Custom context limits
- **WHEN** the configuration specifies `ai.historyContext.maxEntries = 5` and `ai.fileContext.maxFiles = 10`
- **THEN** the prompt SHALL include at most 5 history entries and 10 files

#### Scenario: Custom history path
- **WHEN** the configuration specifies `ai.historyContext.historyPath = "/custom/path/.zsh_history"`
- **THEN** the system SHALL read history from that path instead of the default `~/.zsh_history`

### Requirement: Structured multi-source prompt format
The AI prompt SHALL follow a structured format with optional sections for compinit results, command history, and file listing.

#### Scenario: Full prompt with all sources enabled
- **WHEN** all context sources are enabled and produce results
- **THEN** the prompt SHALL have this structure (each section only if non-empty):
```
# Choose one option and complete it naturally with arguments: <cmd1>, <cmd2>, ...
# Recent commands:
#   <hist1>
#   <hist2>
# Files in directory:
#   <file1>
#   <file2>
<token>
```

#### Scenario: Prompt with only history (files disabled, dir empty)
- **WHEN** `fileContext.enabled = false` and history has entries
- **THEN** the prompt SHALL skip the `# Files in directory:` section entirely

#### Scenario: Prompt with only files (history disabled)
- **WHEN** `historyContext.enabled = false` and directory has files
- **THEN** the prompt SHALL skip the `# Recent commands:` section entirely

