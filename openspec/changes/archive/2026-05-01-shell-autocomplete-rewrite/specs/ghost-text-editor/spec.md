## ADDED Requirements

### Requirement: Ghost text rendering
The CustomEditor SHALL render AI ghost text inline at the cursor position as dimmed text.

#### Scenario: Ghost text displayed after cursor
- **WHEN** ghost text is set (e.g., `mmit` for token `!git co`)
- **THEN** the ghost text SHALL appear immediately after the cursor in the rendered line
- **THEN** the ghost text SHALL use the configured color (default gray `\x1b[38;5;244m`)
- **THEN** the ghost text SHALL be followed by a reset escape code

#### Scenario: No ghost text
- **WHEN** ghost text is empty or not set
- **THEN** the rendered line SHALL appear unchanged (no trailing dimmed text)

#### Scenario: Ghost text cleared on input change
- **WHEN** the user types any character, deletes a character, or moves the cursor
- **THEN** the ghost text SHALL be re-evaluated (set or cleared based on current AI cache for the new token)

### Requirement: Ghost text acceptance via Tab
Pressing Tab SHALL insert the current ghost text at the cursor position.

#### Scenario: Tab inserts ghost text
- **WHEN** ghost text is visible and the user presses Tab
- **THEN** the full ghost text SHALL be inserted into the input at the cursor position
- **THEN** the ghost text SHALL be cleared
- **THEN** the cursor SHALL move to the end of the inserted text

#### Scenario: Tab without ghost text
- **WHEN** no ghost text is visible and the user presses Tab
- **THEN** Tab input SHALL be passed through to the default Pi editor handling (dropdown navigation)

### Requirement: Ghost text acceptance via RightArrow
Pressing RightArrow when the cursor is at the end of the input SHALL insert the ghost text.

#### Scenario: RightArrow at end of line with ghost text
- **WHEN** ghost text is visible and the cursor is at the end of the typed input
- **THEN** RightArrow SHALL insert the ghost text and clear it

#### Scenario: RightArrow with cursor not at end
- **WHEN** ghost text is visible but the cursor is NOT at the end of the typed input
- **THEN** RightArrow SHALL move the cursor right normally (do NOT insert ghost text)

### Requirement: Use public CustomEditor API only
The editor SHALL NOT access internal/private properties of CustomEditor.

#### Scenario: Cursor position via public API
- **WHEN** the editor needs the current cursor position
- **THEN** it SHALL use `this.getCursor()` (public method returning `{line, col}`)
- **THEN** it SHALL NOT access `(this as any).state` or any other private property

#### Scenario: Line content via public API
- **WHEN** the editor needs the current line content
- **THEN** it SHALL use `this.getLines()` (public method)

### Requirement: Ghost text truncation
Ghost text that exceeds the available line width SHALL be truncated with an ellipsis.

#### Scenario: Ghost text fits on line
- **WHEN** cursor column + ghost text visible width is less than the editor width
- **THEN** the full ghost text SHALL be displayed

#### Scenario: Ghost text exceeds line width
- **WHEN** cursor column + ghost text visible width exceeds the editor width
- **THEN** the ghost text SHALL be truncated to fit
- **THEN** the last displayed character SHALL be `…` (U+2026)

### Requirement: Input clearing
When the editor text is externally set (e.g., message sent), ghost text SHALL be cleared.

#### Scenario: setText clears ghost
- **WHEN** `setText()` is called on the editor (e.g., after sending a message)
- **THEN** ghost text SHALL be cleared
- **THEN** the internal token tracking SHALL be reset
