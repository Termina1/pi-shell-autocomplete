## MODIFIED Requirements

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

## ADDED Requirements

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
