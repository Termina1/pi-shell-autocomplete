# ai-context-enrichment Specification

## Purpose
Context enrichment for AI shell autocomplete: collects file listings, shell history, git repository state (branch, status, last commit), project type detection (npm, docker, cargo, make, pip, python, go), and Pi session conversation history as individually-configurable prompt sections. All sources are collected in parallel, cached independently, and tolerant of individual failures.
## Requirements
### Requirement: File system context collection
The system SHALL collect a list of files and directories from the current working directory and include them in the AI prompt when enabled.

#### Scenario: File context enabled
- **WHEN** `ai.fileContext.enabled` is `true` and the working directory contains files `README.md`, `package.json`, `src/`
- **THEN** the AI prompt SHALL include a directory listing section
- **THEN** hidden files (starting with `.`) SHALL be excluded
- **THEN** directories SHALL be listed before regular files

#### Scenario: File context disabled
- **WHEN** `ai.fileContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a directory listing section
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
- **THEN** the AI prompt SHALL include a recent commands section with the last N commands
- **THEN** commands SHALL appear in chronological order (oldest first within the window)

#### Scenario: History context disabled
- **WHEN** `ai.historyContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a recent commands section
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

### Requirement: Git context collection
The system SHALL collect git repository state (branch, modified files, last commit) from the current working directory and include it in the AI prompt when enabled.

#### Scenario: Git context enabled in a git repository
- **WHEN** `ai.gitContext.enabled` is `true` and the working directory is inside a git repository
- **THEN** the system SHALL execute `git branch --show-current` to get the current branch name
- **THEN** the system SHALL execute `git status --short` to get modified/staged/untracked files
- **THEN** the system SHALL execute `git log -1 --oneline` to get the last commit message
- **THEN** the AI prompt SHALL include a git context section with branch, status, and last commit

#### Scenario: Git context disabled
- **WHEN** `ai.gitContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a git context section
- **THEN** no git commands SHALL be executed

#### Scenario: Working directory is not a git repository
- **WHEN** `ai.gitContext.enabled` is `true` but the working directory is not inside a git repository
- **THEN** the git context SHALL be silently omitted from the prompt
- **THEN** the AI prediction SHALL still proceed with other available context

#### Scenario: Git command execution error
- **WHEN** any git command fails (e.g., git not installed, permission denied)
- **THEN** the git context portion SHALL be silently omitted from the prompt
- **THEN** the AI prediction SHALL still proceed with other available context

#### Scenario: Git context status line limit
- **WHEN** `ai.gitContext.maxStatusLines` is `5` and `git status --short` produces 20 lines
- **THEN** only the first 5 status lines SHALL be included

#### Scenario: Git context timeout
- **WHEN** a git command takes longer than 2000ms
- **THEN** the operation SHALL be aborted
- **THEN** the git context portion SHALL be silently omitted from the prompt

#### Scenario: Git context cached within TTL
- **WHEN** `getGitContext()` is called twice within `ai.gitContext.cacheTtlMs` (default 10000ms)
- **THEN** the second call SHALL return the cached result without executing git commands

#### Scenario: Git context cache expires
- **WHEN** `getGitContext()` is called after `ai.gitContext.cacheTtlMs` has elapsed since the previous call
- **THEN** the system SHALL execute fresh git commands and update the cache

### Requirement: Project context collection
The system SHALL detect the project type from known configuration files in the working directory and include relevant tooling information in the AI prompt when enabled.

#### Scenario: NPM project detected
- **WHEN** `ai.projectContext.enabled` is `true` and `package.json` exists in the working directory
- **THEN** the system SHALL read `package.json` and extract the `name` and `scripts` fields
- **THEN** the AI prompt SHALL include a project context section identifying the npm project with name and scripts

#### Scenario: Docker project detected
- **WHEN** `ai.projectContext.enabled` is `true` and `Dockerfile` exists in the working directory
- **THEN** the AI prompt SHALL include a project context section indicating `docker project`

#### Scenario: Multiple project files detected
- **WHEN** `ai.projectContext.enabled` is `true` and both `package.json` and `Dockerfile` exist
- **THEN** the AI prompt SHALL include a combined project section mentioning all detected types

#### Scenario: No project files detected
- **WHEN** `ai.projectContext.enabled` is `true` but no known project files exist
- **THEN** the project context section SHALL be silently omitted from the prompt

#### Scenario: Project context disabled
- **WHEN** `ai.projectContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a project context section
- **THEN** no project file detection SHALL be performed

#### Scenario: package.json read error
- **WHEN** `package.json` exists but cannot be read or parsed (e.g., invalid JSON, permission denied)
- **THEN** the project SHALL be treated as "npm project" with no extracted scripts (presence-only)
- **THEN** the AI prediction SHALL still proceed

#### Scenario: Project context cached within TTL
- **WHEN** `getProjectContext()` is called twice within `ai.projectContext.cacheTtlMs` (default 60000ms)
- **THEN** the second call SHALL return the cached result without re-reading project files

#### Scenario: Project context cache expires
- **WHEN** `getProjectContext()` is called after `ai.projectContext.cacheTtlMs` has elapsed since the previous call
- **THEN** the system SHALL re-detect project files and update the cache

### Requirement: Conversation context collection
The system SHALL extract the most recent user and assistant messages from the Pi session and include them in the AI prompt when enabled.

#### Scenario: Conversation context enabled with recent messages
- **WHEN** `ai.conversationContext.enabled` is `true` and the session contains user and assistant messages
- **THEN** the system SHALL extract the most recent user message and the most recent assistant message
- **THEN** the AI prompt SHALL include a conversation context section with both messages
- **THEN** each message SHALL be truncated to fit within the configured `maxChars` total limit

#### Scenario: Conversation context enabled but session is empty
- **WHEN** `ai.conversationContext.enabled` is `true` but no user or assistant messages exist in the session
- **THEN** the conversation context section SHALL be silently omitted from the prompt

#### Scenario: Conversation context disabled
- **WHEN** `ai.conversationContext.enabled` is `false`
- **THEN** the AI prompt SHALL NOT include a conversation context section
- **THEN** no session queries SHALL be performed for conversation context

#### Scenario: Conversation context character limit
- **WHEN** `ai.conversationContext.maxChars` is `500` and the combined user+assistant messages exceed 500 characters
- **THEN** each message SHALL be truncated proportionally (user and assistant share the limit evenly)
- **THEN** truncated messages SHALL end with `…` to indicate truncation

#### Scenario: Conversation context with only user message
- **WHEN** the session has a user message but no assistant response yet
- **THEN** the conversation context SHALL include only the user message, labeled `User:`

#### Scenario: Conversation context cached within TTL
- **WHEN** `getConversationContext()` is called twice within `ai.conversationContext.cacheTtlMs` (default 5000ms)
- **THEN** the second call SHALL return the cached result without re-reading the session tree

#### Scenario: Conversation context cache expires
- **WHEN** `getConversationContext()` is called after `ai.conversationContext.cacheTtlMs` has elapsed since the previous call
- **THEN** the system SHALL re-read the session tree and update the cache

### Requirement: Configurable context sources
Each context source (file system, history, git, project, conversation) SHALL be independently configurable.

#### Scenario: Only file context enabled
- **WHEN** `fileContext.enabled = true` and all other context sources are disabled
- **THEN** the prompt SHALL include file listing but NOT other context sections

#### Scenario: Only history context enabled
- **WHEN** `fileContext.enabled = false` and `historyContext.enabled = true`
- **THEN** the prompt SHALL include command history but NOT file listing or other sections

#### Scenario: All contexts disabled
- **WHEN** all context sources are disabled
- **THEN** the prompt SHALL include only the header line and the completion token

#### Scenario: All new contexts enabled with defaults
- **WHEN** no configuration is provided for git, project, or conversation context
- **THEN** all three SHALL be enabled by default

#### Scenario: Selective context disabling
- **WHEN** a user disables only `conversationContext.enabled = false`
- **THEN** git, project, file, and history context SHALL still be collected
- **THEN** conversation context SHALL be skipped

### Requirement: Context collection performance
Context collection SHALL NOT block the autocomplete dropdown or introduce noticeable latency. Each context source SHALL have its own timeout and failure SHALL be isolated.

#### Scenario: All sources collected in parallel
- **WHEN** the AI debounce timer fires
- **THEN** all enabled context sources (file, history, git, project, conversation) SHALL be collected in parallel via `Promise.allSettled`
- **THEN** a single slow or failing source SHALL NOT delay other sources

#### Scenario: Git context completes within timeout
- **WHEN** git commands execute successfully within 2000ms
- **THEN** the git context SHALL be included in the prompt
- **THEN** other context sources SHALL proceed independently

#### Scenario: Git context times out
- **WHEN** a git command exceeds its 2000ms timeout
- **THEN** the git context SHALL be silently omitted
- **THEN** other context sources (file, history, project, conversation) SHALL still be included

### Requirement: Context collector as injectable dependency
The context collection logic SHALL be implemented as a separate injectable module to enable isolated testing of AI completer logic. The `ContextCollector` SHALL accept a `ReadonlySessionManager` for conversation context access.

#### Scenario: AiCompleter receives ContextCollector
- **WHEN** `AiCompleter` is instantiated
- **THEN** it SHALL accept a `ContextCollector` instance via constructor injection
- **THEN** the `ContextCollector` SHALL expose `getFileContext()`, `getHistoryContext()`, `getGitContext()`, `getProjectContext()`, and `getConversationContext()` methods

#### Scenario: ContextCollector constructed with session manager
- **WHEN** `ContextCollector` is created for production use
- **THEN** it SHALL receive a `ReadonlySessionManager` instance for conversation context access
- **THEN** it SHALL NOT access the session manager if `conversationContext.enabled` is `false`
