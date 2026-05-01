## ADDED Requirements

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
The system SHALL use a local FIM model to predict the most likely completion of a partial shell command and display it as ghost text.

#### Scenario: Single-token prediction
- **WHEN** the user types `!git co`
- **THEN** the AI model SHALL be queried with fill-in-the-middle completion
- **THEN** the result SHALL be a single line, trimmed of whitespace, under 100 characters
- **THEN** if the result extends the user's token (e.g., `git commit`), the suffix SHALL be shown as ghost text

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
AI ghost text predictions SHALL be cached by exact input token, with LRU eviction.

#### Scenario: Cache hit
- **WHEN** the user types a token that was previously predicted by AI
- **THEN** the cached result SHALL be shown immediately without model inference

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
AI behavior SHALL be configurable by the user.

#### Scenario: AI disabled
- **WHEN** the configuration has `ai.enabled = false`
- **THEN** no model SHALL be loaded and no ghost text SHALL be displayed

#### Scenario: Custom model path
- **WHEN** the configuration specifies a custom `ai.modelPath`
- **THEN** that path SHALL be used instead of the default
