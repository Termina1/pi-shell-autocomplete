# Implementation Issues

Issues discovered and fixed during implementation of shell-autocomplete-rewrite.

## 1. Autocomplete not triggering on `!`

**Root cause**: Pi auto-triggers autocomplete only for `/`, `@`, `#`. The `!` prefix requires manual trigger.

**Fix**: Added `(this as any).tryTriggerAutocomplete()` in `ShellAutocompleteEditor.handleInput()` after detecting `!` in the line. This is the only remaining `(this as any)` hack — Pi has no public API for autocomplete triggering.

**Prevented by**: Manual smoke test. Hard to unit-test because `tryTriggerAutocomplete` is private.

## 2. Ghost text not rendering after setGhostText

**Root cause**: `setGhostText()` updated internal state but TUI didn't know to re-render.

**Fix**: Added `editor.requestRender()` → `this.tui.requestRender()` after `setGhostText()`.

**Prevented by**: `editor.test.ts` → "calls tui.requestRender".

## 3. Wrong ghost text suffix

**Root cause**: AI model returns full predicted word (e.g. `"commit"`), but ghost should show only the untyped portion (`"ommit"` for token `"git c"`).

**Fix**: `fullCommand = completion.startsWith(token) ? completion : token + completion; suffix = fullCommand.slice(token.length)`.

**Prevented by**: `provider.test.ts` → AI callback integration; `ai-completer.int.test.ts` → real model prediction.

## 4. Broken ghost text rendering

**Root cause**: Used `getCursor().col` as rendered column position. In Pi's terminal output, the cursor is rendered with ANSI codes and borders, so the logical column ≠ rendered column.

**Fix**: Reverted to `END_CURSOR` regex (`/(?:\x1b\[[0-9;]*m \x1b\[[0-9;]*m|█|▌|▋|▉|▓)/`) to find cursor position in rendered output. This regex is theme-dependent but works for all standard Pi themes.

**Prevented by**: `editor.test.ts` → render tests verify ghost text appears in output.

## 5. Debug code crashed Pi

**Root cause**: Added `[GHOST_DEBUG]` prefix to every rendered line, exceeding terminal width (102 > 89 chars). Pi crashes on line width overflow with a descriptive error.

**Fix**: Removed debug code. Lesson: always `truncateToWidth()` any injected text.

**Prevented by**: Would need an integration test that verifies render output width ≤ terminal width.

## 6. Model file not found

**Root cause**: `modelPath: "../models/..."` resolved relative to `import.meta.url` which gives the REAL path (`Work/pi-shell-autocomplete/`), not the symlink path (`~/.pi/agent/extensions/shell-autocomplete/`). So `../models/` went to `Work/models/` instead of `~/.pi/agent/models/`.

**Fix**: Changed to `os.homedir()/.pi/agent/` as base path for model resolution. Updated default config from `"../models/..."` to `"models/..."`.

**Prevented by**: `ai-completer.int.test.ts` — real model integration test fails if path doesn't resolve.

## 7. node-llama-cpp not installed

**Root cause**: Forgot to add `node-llama-cpp` to `package.json`. Unit tests mock it, so green suite hid the missing dependency.

**Fix**: `npm install node-llama-cpp`. Added integration test with real model loading.

**Prevented by**: `ai-completer.int.test.ts` — `createModelLoader()` → `import("node-llama-cpp")` fails if not installed.

## 8. node-pty native build failure

**Root cause**: `node-pty` prebuilt binary didn't work on macOS arm64. `posix_spawnp failed`.

**Fix**: `npm rebuild node-pty` → compiled from source via node-gyp.

**Prevented by**: CI would catch this; local dev needs `npm rebuild` on fresh install.

## 9. Wrong test approach for AI integration

**Root cause**: Initially tested raw `node-llama-cpp` API instead of `AiCompleter.predict()`. `runIf()` with async `beforeAll` doesn't work (evaluated at collection time, before `beforeAll` runs).

**Fix**: Test `AiCompleter.predict()` with `createModelLoader()`. Use sync `fs.existsSync()` before `it()` to decide skip/run.

**Prevented by**: Integration test now covers full AiCompleter → createModelLoader → node-llama-cpp chain.

## 10. Files in wrong directory

**Root cause**: Implemented directly in `~/.pi/agent/extensions/shell-autocomplete/` instead of project directory.

**Fix**: Moved to `Work/pi-shell-autocomplete/`, symlinked `~/.pi/agent/extensions/shell-autocomplete → Work/pi-shell-autocomplete`.

**Prevented by**: Project convention — all code lives in workspace, symlinked to Pi.
