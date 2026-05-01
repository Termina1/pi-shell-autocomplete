## ADDED Requirements

### Requirement: Trigger on `!` prefix
The autocomplete provider SHALL activate when the text before the cursor matches the `!` trigger prefix.

#### Scenario: Shell prefix detected
- **WHEN** the user types `!git` at the beginning of a line
- **THEN** the provider SHALL extract the token `git` (everything after `!`)
- **THEN** the provider SHALL return shell completions for `git`

#### Scenario: Shell prefix after whitespace
- **WHEN** the user types `echo !git` (with space before `!`)
- **THEN** the provider SHALL extract the token `git`
- **THEN** the provider SHALL return shell completions for `git`

#### Scenario: No shell prefix
- **WHEN** the text before the cursor does NOT contain `!` with a valid token
- **THEN** the provider SHALL delegate to the default Pi autocomplete provider
- **THEN** normal file/mention completion SHALL work unchanged

#### Scenario: `!` with no token yet
- **WHEN** the user types `!` with no characters after it
- **THEN** the provider SHALL NOT activate (delegates to default)

### Requirement: Dropdown items from zsh completions
The autocomplete dropdown SHALL display completions obtained from zsh's native completion system.

#### Scenario: Command completions in dropdown
- **WHEN** the user types `!git`
- **THEN** the dropdown SHALL show command names that match `git` (e.g., `git`, `git-lfs`, `git-flow`)
- **THEN** items SHALL be ordered by match quality (prefix match > substring match > length penalty)

#### Scenario: Subcommand completions in dropdown
- **WHEN** the user types `!git c`
- **THEN** the dropdown SHALL show git subcommands starting with `c` (e.g., `commit`, `checkout`, `clean`)
- **THEN** each item's value SHALL be the full command (`git commit`), the label SHALL be the subcommand (`commit`)

#### Scenario: Maximum dropdown items
- **WHEN** completions exceed the configured max (default 15)
- **THEN** only the top-scoring items SHALL be shown

#### Scenario: No completions found
- **WHEN** zsh returns no completions for the current token
- **THEN** the provider SHALL delegate to the default Pi provider

### Requirement: Keyboard bindings in dropdown
Dropdown navigation SHALL use arrow keys when ghost text acceptance occupies Tab.

#### Scenario: Arrow down navigates dropdown
- **WHEN** the dropdown is open and the user presses ↓
- **THEN** the highlight SHALL move to the next item
- **WHEN** the last item is highlighted
- **THEN** ↓ SHALL wrap to the first item

#### Scenario: Arrow up navigates dropdown
- **WHEN** the dropdown is open and the user presses ↑
- **THEN** the highlight SHALL move to the previous item
- **WHEN** the first item is highlighted
- **THEN** ↑ SHALL wrap to the last item

#### Scenario: Enter selects dropdown item
- **WHEN** the dropdown is open with a highlighted item and the user presses Enter
- **THEN** the highlighted item's value SHALL be inserted into the input at the cursor position
- **THEN** the dropdown SHALL close

### Requirement: Tab behavior
Tab SHALL accept ghost text when present; otherwise, it SHALL navigate the dropdown.

#### Scenario: Tab accepts ghost text
- **WHEN** ghost text is visible and the user presses Tab
- **THEN** the ghost text SHALL be inserted at the cursor
- **THEN** the ghost text SHALL be cleared

#### Scenario: Tab without ghost text
- **WHEN** no ghost text is visible (model not loaded, no prediction, or ghost already accepted) and the user presses Tab
- **THEN** Tab SHALL behave as default Pi Tab (navigate dropdown)

### Requirement: Delegation to default provider
Non-shell input SHALL be handled by Pi's default autocomplete provider to maintain existing file path and mention completions.

#### Scenario: File path completion
- **WHEN** the user has not typed `!`, and types a file path
- **THEN** the default provider SHALL provide file completions
- **THEN** the shell autocomplete SHALL NOT interfere

#### Scenario: Mention completion
- **WHEN** the user types `@` to mention a file
- **THEN** the default provider SHALL provide mention completions
- **THEN** the shell autocomplete SHALL NOT interfere
