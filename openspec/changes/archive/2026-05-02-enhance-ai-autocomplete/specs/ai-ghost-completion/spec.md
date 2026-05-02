## ADDED Requirements

### Requirement: Configurable model temperature
The system SHALL support a configurable temperature parameter for AI model inference to control prediction determinism.

#### Scenario: Default temperature
- **WHEN** the configuration does not specify `ai.temperature`
- **THEN** the model SHALL use a temperature of `0.3` for inference

#### Scenario: Custom temperature
- **WHEN** the configuration specifies `ai.temperature = 0.7`
- **THEN** the model SHALL be invoked with temperature `0.7`

#### Scenario: Zero temperature for determinism
- **WHEN** the configuration specifies `ai.temperature = 0`
- **THEN** the model SHALL use deterministic inference (always same output for same input)

## MODIFIED Requirements

### Requirement: AI ghost text prediction
The system SHALL use a local FIM model to predict the most likely completion of a partial shell command and display it as ghost text. The AI prompt SHALL include a role instruction and all enabled context sources (compinit results, shell history, directory listing, git state, project type, conversation).

#### Scenario: Prediction with instruct-style prompt
- **WHEN** the user types `!git co`
- **THEN** the AI model SHALL be queried with fill-in-the-middle completion
- **THEN** the prompt prefix SHALL begin with a role instruction telling the model it is a shell command predictor
- **THEN** the prompt SHALL include all enabled context sources as labeled sections
- **THEN** the prompt SHALL end with `Complete: git co` on a separate line
- **THEN** the suffix SHALL be empty
- **THEN** the result SHALL be a single line, trimmed of whitespace, under 100 characters
- **THEN** if the result extends the user's token (e.g., `git commit`), the suffix SHALL be shown as ghost text

#### Scenario: Role instruction is always present
- **WHEN** the user types any shell prefix
- **THEN** the prompt SHALL always include the role instruction, regardless of which context sources are enabled
- **THEN** the instruction SHALL tell the model to output ONLY the completion text with no explanations or formatting

#### Scenario: Empty or invalid result
- **WHEN** the AI model returns an empty string, only whitespace, or a result longer than 100 characters
- **THEN** no ghost text SHALL be displayed

#### Scenario: Result does not extend token
- **WHEN** the AI model returns text that does not start with the user's current token
- **THEN** no ghost text SHALL be displayed

### Requirement: AI result caching
AI ghost text predictions SHALL be cached by exact input token combined with a hash of all enabled context sources, with LRU eviction. The cache key SHALL include conversation context when enabled.

#### Scenario: Cache hit with same context
- **WHEN** the user types a token that was previously predicted by AI with the same context across all enabled sources (git, project, files, history, conversation)
- **THEN** the cached result SHALL be shown immediately without model inference

#### Scenario: Cache miss with different git context
- **WHEN** the user types a previously-predicted token but git status has changed (files modified, branch switched)
- **THEN** a new inference SHALL be triggered (context-aware cache key reflects git state change)

#### Scenario: Cache miss with different conversation context
- **WHEN** the user types a previously-predicted token but the conversation has advanced (new user/assistant messages)
- **THEN** a new inference SHALL be triggered (context-aware cache key reflects conversation change)

#### Scenario: Cache eviction
- **WHEN** the AI cache exceeds 200 entries
- **THEN** the 50 oldest entries SHALL be evicted

### Requirement: Configurable AI settings
AI behavior SHALL be configurable by the user, including model priority, temperature, all context sources, and all existing settings.

#### Scenario: AI disabled
- **WHEN** the configuration has `ai.enabled = false`
- **THEN** no model SHALL be loaded and no ghost text SHALL be displayed

#### Scenario: Custom model priority
- **WHEN** the configuration specifies `ai.modelPriority = ["models/my-model.gguf"]`
- **THEN** the system SHALL attempt to load models in that priority order

#### Scenario: Custom temperature
- **WHEN** the configuration specifies `ai.temperature = 0.5`
- **THEN** the model SHALL be invoked with temperature `0.5`

#### Scenario: Custom context limits
- **WHEN** the configuration specifies `ai.historyContext.maxEntries = 5` and `ai.fileContext.maxFiles = 10`
- **THEN** the prompt SHALL include at most 5 history entries and 10 files

#### Scenario: Custom history path
- **WHEN** the configuration specifies `ai.historyContext.historyPath = "/custom/path/.zsh_history"`
- **THEN** the system SHALL read history from that path instead of the default `~/.zsh_history`

#### Scenario: Git context disabled
- **WHEN** the configuration has `ai.gitContext.enabled = false`
- **THEN** the prompt SHALL NOT include a `[SECTION: Git]` section
- **THEN** no git commands SHALL be executed

#### Scenario: Project context disabled
- **WHEN** the configuration has `ai.projectContext.enabled = false`
- **THEN** the prompt SHALL NOT include a `[SECTION: Project]` section
- **THEN** no project file detection SHALL be performed

#### Scenario: Conversation context disabled
- **WHEN** the configuration has `ai.conversationContext.enabled = false`
- **THEN** the prompt SHALL NOT include a `[SECTION: Conversation]` section

### Requirement: Instruct-style prompt format
The AI prompt SHALL follow an instruct-style format with a role instruction followed by labeled context sections, ending with the completion task.

#### Scenario: Full prompt with all sources enabled
- **WHEN** all context sources are enabled and produce results
- **THEN** the prompt SHALL have this structure:
```
You are a shell command autocomplete predictor. Given context about the project,
recent activity, and the conversation, predict the most likely completion for
the partial command. Output ONLY the completion text — no explanations, no
formatting, no markdown.

[SECTION: Git]
branch=feature/auth, M src/auth.ts

[SECTION: Project]
npm package "my-app"

[SECTION: Conversation]
User: Пофикси auth service
Assistant: Проблема в token.ts

[SECTION: Recent Commands]
git status
npm test

[SECTION: Directory]
src/  package.json

Complete: git c
```

#### Scenario: Prompt with only some context sources enabled
- **WHEN** only git and project context are enabled and produce results
- **THEN** the prompt SHALL include `[SECTION: Git]` and `[SECTION: Project]` sections
- **THEN** the prompt SHALL NOT include `[SECTION: Conversation]`, `[SECTION: Recent Commands]`, or `[SECTION: Directory]` sections

#### Scenario: Prompt with no context sources enabled
- **WHEN** all optional context sources are disabled
- **THEN** the prompt SHALL still include the role instruction
- **THEN** the prompt SHALL end with `Complete: <token>` and have no `[SECTION:]` blocks

#### Scenario: Empty context section skipped
- **WHEN** a context source is enabled but produces no data (e.g., empty directory, git not available, no project files found)
- **THEN** that section SHALL be omitted entirely from the prompt
