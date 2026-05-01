import { CustomEditor } from "@mariozechner/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { GhostConfig } from "./config";

const RESET = "\x1b[0m";

// Match rendered cursor block across themes/terminal modes
const END_CURSOR = /(?:\x1b\[[0-9;]*m \x1b\[[0-9;]*m|█|▌|▋|▉|▓)/;

export class ShellAutocompleteEditor extends CustomEditor {
  private ghostText = "";
  private ghostColor: string;
  /** Current shell token — used to discard stale AI results */
  currentToken: string | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    ghostConfig: GhostConfig,
  ) {
    super(tui, theme, keybindings);
    this.ghostColor = ghostConfig.color;
  }

  override handleInput(data: string): void {
    // Clear stale ghost on any new input — will be refreshed by AI callback
    const savedGhost = this.ghostText;
    this.ghostText = "";

    // Tab accepts ghost text
    if (savedGhost && matchesKey(data, Key.tab)) {
      this.insertTextAtCursor(savedGhost);
      return;
    }

    // Right arrow at end of line accepts ghost text
    if (savedGhost && matchesKey(data, Key.right)) {
      const cursor = this.getCursor();
      const lines = this.getLines();
      const currentLine = lines[cursor.line] ?? "";
      if (cursor.col >= currentLine.length) {
        this.insertTextAtCursor(savedGhost);
        return;
      }
    }

    super.handleInput(data);

    // Trigger autocomplete for ! prefix (Pi only auto-triggers for /, @, #)
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";
    const before = line.slice(0, cursor.col);
    // Only trigger at line start
    const shellMatch = before.match(/^[ \t]*!(.*)$/);
    const hasToken = shellMatch && shellMatch[1]!.length > 0;

    if (hasToken) {
      this.currentToken = shellMatch[1]!;
      (this as any).tryTriggerAutocomplete?.();
    } else if (this.ghostText) {
      this.currentToken = undefined;
      // Clear ghost when ! prefix is gone or token is empty
      this.ghostText = "";
    } else {
      this.currentToken = undefined;
    }
  }

  override setText(text: string): void {
    super.setText(text);
    this.ghostText = "";
  }

  setGhostText(text: string): void {
    this.ghostText = text;
  }

  clearGhost(): void {
    this.ghostText = "";
  }

  getGhostText(): string {
    return this.ghostText;
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (!this.ghostText || this.ghostText.length === 0) return lines;

    // Find the content line (not border)
    const contentLineIndex = 1;
    const contentLine = lines[contentLineIndex];
    if (!contentLine) return lines;

    const match = END_CURSOR.exec(contentLine);
    if (!match) return lines;

    const ghostVisible = visibleWidth(this.ghostText);
    const cursorCol = visibleWidth(contentLine.slice(0, match.index));
    const available = width - cursorCol - 1;
    if (available <= 0) return lines;

    const ghostToShow =
      ghostVisible > available
        ? this.ghostText.slice(0, Math.max(0, available - 1)) + "\u2026"
        : this.ghostText;

    lines[contentLineIndex] = truncateToWidth(
      contentLine.replace(
        END_CURSOR,
        (cursor) => `${cursor}${this.ghostColor}${ghostToShow}${RESET}`,
      ),
      width,
      "",
    );

    return lines;
  }
}
