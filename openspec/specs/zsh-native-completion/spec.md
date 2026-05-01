# zsh-native-completion Specification

## Purpose
TBD - created by archiving change shell-autocomplete-rewrite. Update Purpose after archive.
## Requirements
### Requirement: Query zsh for command completions
The system SHALL query zsh's native completion system to discover all available commands (executables, builtins, functions, aliases).

#### Scenario: Discover commands on PATH
- **WHEN** the system requests command completions from zsh
- **THEN** the result SHALL include all executables from `$commands`, all shell builtins from `$builtins`, all shell functions from `$functions`, and all aliases from `$aliases`

#### Scenario: Deduplicate across sources
- **WHEN** a command name appears in multiple sources (e.g., both as executable and alias)
- **THEN** the result SHALL contain each command name only once
- **THEN** the result SHALL be sorted alphabetically

#### Scenario: Zsh not available
- **WHEN** zsh is not installed or `compinit` fails to load
- **THEN** the system SHALL notify the user once with an error message
- **THEN** the shell autocomplete extension SHALL NOT activate

### Requirement: Query zsh for positional completions
The system SHALL query zsh's completion system for subcommand, flag, and argument completions given a partial command line.

#### Scenario: Complete git subcommands
- **WHEN** the partial command line is `git c`
- **THEN** zsh's `_git` completion function SHALL be invoked
- **THEN** the result SHALL include git subcommands starting with "c" (e.g., `commit`, `checkout`, `clone`, `clean`, `cherry-pick`)

#### Scenario: Complete docker subcommands
- **WHEN** the partial command line is `docker `
- **THEN** zsh's `_docker` completion function SHALL be invoked
- **THEN** the result SHALL include docker subcommands (e.g., `run`, `build`, `ps`, `images`)

#### Scenario: Complete kubectl resources
- **WHEN** the partial command line is `kubectl get `
- **THEN** zsh's `_kubectl` completion function SHALL be invoked
- **THEN** the result SHALL include kubectl resource types (e.g., `pods`, `deployments`, `services`)

#### Scenario: Completion timeout
- **WHEN** a zsh completion query takes longer than the configured timeout (default 3000ms)
- **THEN** the query SHALL be aborted
- **THEN** an empty result SHALL be returned
- **THEN** the extension SHALL remain functional for subsequent queries

#### Scenario: Completion failure
- **WHEN** the zsh completion subshell exits with a non-zero code or produces unparseable output
- **THEN** the error SHALL be silently handled (no user-facing error)
- **THEN** an empty result SHALL be returned
- **THEN** the extension SHALL remain functional for subsequent queries

### Requirement: Cache zsh completion results
The system SHALL cache zsh completion results with a configurable TTL to avoid repeated shell-outs.

#### Scenario: Cache hit
- **WHEN** a completion query is made for a token that was previously queried within the TTL period
- **THEN** the cached result SHALL be returned without spawning a zsh subshell

#### Scenario: Cache miss with TTL expiry
- **WHEN** a completion query is made for a token whose cached result has exceeded the TTL
- **THEN** a new zsh subshell SHALL be spawned to refresh the result
- **THEN** the stale cached result SHALL be returned while the refresh is in progress

#### Scenario: Concurrent cache queries
- **WHEN** multiple completion queries for the same token arrive before the first query completes
- **THEN** only ONE zsh subshell SHALL be spawned
- **THEN** all concurrent queries SHALL receive the same result

### Requirement: Command list caching
The system SHALL cache the full command list (executables, builtins, functions, aliases) separately from positional completions, with its own TTL.

#### Scenario: Command list cache independent of positional cache
- **WHEN** a first-word completion is requested (e.g., `!git`)
- **THEN** the command list cache SHALL be checked first
- **WHEN** a positional completion is requested (e.g., `!git c`)
- **THEN** the positional completion cache SHALL be checked independently

