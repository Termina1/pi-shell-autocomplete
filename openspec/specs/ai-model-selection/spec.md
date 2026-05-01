# ai-model-selection Specification

## Purpose
TBD - created by archiving change enhance-ai-autocomplete-context. Update Purpose after archive.
## Requirements
### Requirement: Automatic model selection from priority list
The system SHALL automatically select the best available GGUF model from a configurable priority list, falling back to less preferred models when higher-priority ones are missing.

#### Scenario: First-priority model exists
- **WHEN** the priority list is `["models/qwen2.5-coder-3b.gguf", "models/starcoder2-3b.gguf"]` and the first file exists on disk
- **THEN** the system SHALL load `models/qwen2.5-coder-3b.gguf`

#### Scenario: First-priority model missing, second exists
- **WHEN** the priority list is `["models/qwen2.5-coder-3b.gguf", "models/starcoder2-3b.gguf"]` and the first file does NOT exist but the second does
- **THEN** the system SHALL load `models/starcoder2-3b.gguf`

#### Scenario: No model file exists
- **WHEN** none of the model files in the priority list exist on disk
- **THEN** the system SHALL set `aiLoadError = true`
- **THEN** no ghost text SHALL be displayed
- **THEN** the dropdown SHALL continue to work normally

#### Scenario: Empty priority list falls back to modelPath
- **WHEN** `modelPriority` is empty or undefined, and `modelPath` is set to `"models/starcoder2-3b.gguf"`
- **THEN** the system SHALL use `modelPath` (backward-compatible behavior)

### Requirement: Configurable model priority
The list of model paths SHALL be configurable by the user, with a sensible default that includes qwen2.5-coder as the first choice.

#### Scenario: Custom model priority
- **WHEN** the configuration specifies `ai.modelPriority = ["models/my-model.gguf"]` and that file exists
- **THEN** the system SHALL load `models/my-model.gguf`

#### Scenario: Default model priority
- **WHEN** no custom `modelPriority` is provided
- **THEN** the system SHALL use the default priority list: qwen2.5-coder-3b, qwen2.5-coder-1.5b, starcoder2-3b, deepseek-coder-1.3b

### Requirement: Model file path resolution
Model paths SHALL be resolved relative to the Pi agent directory (`~/.pi/agent/`).

#### Scenario: Relative model path
- **WHEN** model path is `"models/qwen2.5-coder-3b.gguf"`
- **THEN** the system SHALL resolve it to `~/.pi/agent/models/qwen2.5-coder-3b.gguf`

#### Scenario: Absolute model path
- **WHEN** model path is `"/home/user/models/qwen2.5-coder-3b.gguf"`
- **THEN** the system SHALL use it as-is without prefixing the agent directory

### Requirement: Model loading retry on new session
A failed model load SHALL be retried when a new session starts.

#### Scenario: Retry after failure
- **WHEN** model loading failed in a previous session (no files found)
- **AND** a new session starts
- **THEN** the system SHALL reset `aiLoadError` to `false`
- **THEN** the system SHALL attempt model loading again on the first shell prefix

