## ADDED Requirements

### Requirement: Persistent zsh worker for positional completion
The system SHALL maintain a single, long-running zsh worker process that handles all positional completion queries for the lifetime of the extension, instead of spawning a new zsh subshell per query.

#### Scenario: Worker is reused across queries
- **WHEN** the system performs N positional completion queries (cache misses) within one session
- **THEN** at most ONE zsh worker process SHALL be spawned for those queries
- **THEN** `compinit` SHALL be run at most once per worker lifetime

#### Scenario: Lazy startup
- **WHEN** the extension is loaded but no positional completion has been requested yet, AND `zshWorker.prewarm` is `false`
- **THEN** no zsh worker process SHALL be running

#### Scenario: Prewarm on activation
- **WHEN** the extension is loaded and `zshWorker.prewarm` is `true` (default)
- **THEN** the zsh worker SHALL begin starting in the background without blocking extension activation
- **THEN** the first positional completion query SHALL not have to wait for `compinit`

#### Scenario: Graceful disposal
- **WHEN** the extension is unloaded or `ZshCompleter.dispose()` is called
- **THEN** the zsh worker process SHALL be terminated
- **THEN** no orphaned zsh processes SHALL remain

### Requirement: Sentinel-framed completion protocol
The system SHALL frame each positional completion request and response with unique sentinel markers so that responses are matched to requests deterministically and without timing-based heuristics.

#### Scenario: Each request carries a unique id
- **WHEN** the system sends a completion request to the worker
- **THEN** the request SHALL include a unique id
- **THEN** the worker's response SHALL include a terminating line containing that same id

#### Scenario: End-of-response detection without fixed delay
- **WHEN** the worker is producing completion output
- **THEN** the reader SHALL determine end-of-response by detecting the terminating sentinel line, NOT by a fixed `setTimeout`

#### Scenario: Stale output is discarded
- **WHEN** output for a previously-timed-out request id arrives after a new request has started
- **THEN** the stale output SHALL be discarded based on its id mismatch
- **THEN** the new request SHALL not be corrupted by the stale output

### Requirement: In-flight request deduplication at the worker
The system SHALL deduplicate concurrent positional-completion requests for the same token at the worker layer, in addition to the time-based cache.

#### Scenario: Same token requested concurrently
- **WHEN** two or more callers request positional completions for the same token before the first request to the worker completes
- **THEN** the worker SHALL be sent the request only ONCE
- **THEN** all callers SHALL resolve with the same result

### Requirement: Worker auto-recovery
The system SHALL automatically recover from worker crashes, hangs, or unexpected exits without permanently disabling positional completion in the session.

#### Scenario: Worker exits unexpectedly
- **WHEN** the zsh worker process exits between queries
- **THEN** the next positional completion query SHALL transparently start a fresh worker

#### Scenario: Worker hangs on a query
- **WHEN** a positional completion query exceeds `zshCompletionTimeoutMs`
- **THEN** the caller SHALL receive an empty result
- **THEN** the worker SHALL be re-synchronized (via a sync sentinel) or terminated and respawned
- **THEN** subsequent queries SHALL continue to function

#### Scenario: Repeated worker failures
- **WHEN** the worker has crashed and been respawned more than 3 times within 60 seconds
- **THEN** the system SHALL stop attempting to spawn new workers for the remainder of the session
- **THEN** subsequent positional completion queries SHALL return empty results without spawning

### Requirement: Persistent compinit dump
The system SHALL pass a stable, dedicated `compinit -d <path>` dump file path to the worker so that compinit reuses a cached dump across editor restarts.

#### Scenario: First worker start writes the dump
- **WHEN** the worker is started for the first time on a machine
- **THEN** `compinit -d <configured-path>` SHALL be invoked
- **THEN** the dump file SHALL be created at the configured path

#### Scenario: Subsequent worker starts reuse the dump
- **WHEN** the worker is started and the configured dump file already exists and is valid
- **THEN** `compinit` SHALL reuse the existing dump
- **THEN** worker startup time SHALL be lower than the cold-start case

#### Scenario: Isolated from user's own zcompdump
- **WHEN** the user's interactive zsh and the extension's worker run simultaneously
- **THEN** they SHALL NOT write to the same compdump file
- **THEN** the user's `~/.zcompdump` SHALL not be modified by the extension

### Requirement: Positional completion latency budget
The system SHALL deliver positional completion results within a defined latency budget after worker warmup.

#### Scenario: Warm cache-miss latency
- **WHEN** the worker has been warmed (compinit has completed at least once and the relevant `_<command>` autoload has been triggered at least once) and a new, uncached token is queried
- **THEN** the median (p50) end-to-end latency from `getCompletions(token)` to resolution SHALL be ≤ 250 ms on a typical developer machine
- **THEN** the p95 latency SHALL be ≤ 800 ms (worst-case bounded by the worker's hard cap on stage-1 wait)
- **THEN** the latency SHALL be at least 4× lower than the legacy per-query `captureCompletions` path (which exhibits a fixed ≥1100 ms cost)

#### Scenario: Cold-start latency does not block UI
- **WHEN** `zshWorker.prewarm` is `true` and the user types the trigger character before the worker finishes warming
- **THEN** the dropdown SHALL still render command-list results from the (already-cached) `getCommands()` path
- **THEN** positional completion results SHALL appear as soon as the worker is ready, without freezing the editor

## MODIFIED Requirements

### Requirement: Query zsh for positional completions
The system SHALL query zsh's completion system for subcommand, flag, and argument completions given a partial command line. Queries SHALL be served by a persistent zsh worker process (see "Persistent zsh worker for positional completion") and framed with sentinel markers (see "Sentinel-framed completion protocol"), not by spawning a new zsh subshell per query and not by relying on hardcoded timing delays.

#### Scenario: Complete git subcommands
- **WHEN** the partial command line is `git c`
- **THEN** zsh's `_git` completion function SHALL be invoked inside the persistent worker
- **THEN** the result SHALL include git subcommands starting with "c" (e.g., `commit`, `checkout`, `clone`, `clean`, `cherry-pick`)

#### Scenario: Complete docker subcommands
- **WHEN** the partial command line is `docker `
- **THEN** zsh's `_docker` completion function SHALL be invoked inside the persistent worker
- **THEN** the result SHALL include docker subcommands (e.g., `run`, `build`, `ps`, `images`)

#### Scenario: Complete kubectl resources
- **WHEN** the partial command line is `kubectl get `
- **THEN** zsh's `_kubectl` completion function SHALL be invoked inside the persistent worker
- **THEN** the result SHALL include kubectl resource types (e.g., `pods`, `deployments`, `services`)

#### Scenario: Completion timeout
- **WHEN** a zsh completion query takes longer than the configured timeout (default 3000ms)
- **THEN** the query SHALL be aborted
- **THEN** an empty result SHALL be returned
- **THEN** the worker SHALL be re-synchronized or respawned so subsequent queries remain functional
- **THEN** the extension SHALL remain functional for subsequent queries

#### Scenario: Completion failure
- **WHEN** the zsh worker exits unexpectedly or produces unparseable output for a request
- **THEN** the error SHALL be silently handled (no user-facing error)
- **THEN** an empty result SHALL be returned for that request
- **THEN** the worker SHALL auto-respawn for subsequent queries (subject to the respawn cap defined in "Worker auto-recovery")
