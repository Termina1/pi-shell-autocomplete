## ADDED Requirements

### Requirement: File system context collection
The system SHALL collect a list of files and directories from the current working directory and include them in the AI prompt when enabled.

#### Scenario: File context enabled
- **WHEN** `ai.fileContext.enabled` is `true` and the working directory contains files `README.md`, `package.json`, `src/`
- **THEN** the AI prompt SHALL include a `# Files in directory:` section listing those entries
- **THEN** hidden files (starting with `.`) SHALL be excluded
- **THEN** directories SHALL be listed before regular files

#### Scenario: File context disabled
- **WHEN** `ai.fileContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a `# Files in directory:` section
- **THEN** no filesystem reads SHALL be performed for context collection

#### Scenario: File context with max limit
- **WHEN** `ai.fileContext.maxFiles` is `5` and the directory contains 20 files
- **THEN** only the first 5 entries (directories first, then files) SHALL be included in the prompt

#### Scenario: File context read error
- **WHEN** `fs.readdir` fails (e.g., permission denied, directory deleted)
- **THEN** the file context portion SHALL be silently omitted from the prompt
- **THEN** the AI prediction SHALL still proceed with other available context

#### Scenario: File context timeout
- **WHEN** `fs.readdir` takes longer than 500ms
- **THEN** the operation SHALL be aborted
- **THEN** the file context portion SHALL be silently omitted from the prompt

### Requirement: Command history context collection
The system SHALL read the last N commands from the user's zsh history file and include them in the AI prompt when enabled.

#### Scenario: History context enabled
- **WHEN** `ai.historyContext.enabled` is `true` and `.zsh_history` contains recent commands
- **THEN** the AI prompt SHALL include a `# Recent commands:` section with the last N commands
- **THEN** commands SHALL appear in chronological order (oldest first within the window)

#### Scenario: History context disabled
- **WHEN** `ai.historyContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a `# Recent commands:` section
- **THEN** no history file reads SHALL be performed

#### Scenario: History context with max limit
- **WHEN** `ai.historyContext.maxEntries` is `10` and the history file contains 1000 entries
- **THEN** only the last 10 commands SHALL be included

#### Scenario: History file not found
- **WHEN** the configured `historyPath` file does not exist
- **THEN** the history context portion SHALL be silently omitted from the prompt
- **THEN** the AI prediction SHALL still proceed with other available context

#### Scenario: History file with timestamps
- **WHEN** the history file uses EXTENDED_HISTORY format (lines like `: 1714512000:0;git status`)
- **THEN** the system SHALL extract only the command part (`git status`) after the timestamp prefix

#### Scenario: History file without timestamps
- **WHEN** the history file contains plain commands (lines like `git status`)
- **THEN** the system SHALL use the commands as-is

### Requirement: Configurable context sources
Each context source (file system, history) SHALL be independently configurable.

#### Scenario: Only file context enabled
- **WHEN** `fileContext.enabled = true` and `historyContext.enabled = false`
- **THEN** the prompt SHALL include file listing but NOT command history

#### Scenario: Only history context enabled
- **WHEN** `fileContext.enabled = false` and `historyContext.enabled = true`
- **THEN** the prompt SHALL include command history but NOT file listing

#### Scenario: Both contexts disabled
- **WHEN** both `fileContext.enabled` and `historyContext.enabled` are `false`
- **THEN** the prompt format SHALL be identical to the current (compinit-only) format

### Requirement: Context collection performance
Context collection SHALL NOT block the autocomplete dropdown or introduce noticeable latency.

#### Scenario: Context collection runs within debounce window
- **WHEN** the AI debounce timer fires
- **THEN** context collection (file listing + history reading) SHALL complete before the AI inference request is sent
- **THEN** if context collection fails or times out, the inference SHALL proceed without that context source

### Requirement: Context collector as injectable dependency
The context collection logic SHALL be implemented as a separate injectable module to enable isolated testing of AI completer logic.

#### Scenario: AiCompleter receives ContextCollector
- **WHEN** `AiCompleter` is instantiated
- **THEN** it SHALL accept a `ContextCollector` instance via constructor injection
- **THEN** the `ContextCollector` SHALL expose `getFileContext()` and `getHistoryContext()` methods
