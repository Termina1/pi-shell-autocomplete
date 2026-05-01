/**
 * ShellAutocompleteEditor unit tests.
 * Mocks CustomEditor base class to test ghost text logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the pi modules
vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: class {
    tui: any;
    constructor(tui: any, _theme: any, _kb: any) { this.tui = tui; }
    insertTextAtCursor = vi.fn();
    getCursor() { return { line: 0, col: 0 }; }
    getLines() { return [""]; }
    handleInput(_data: string) {}
    setText(_text: string) {}
    render(width: number): string[] {
      return [
        "┌──────────────────┐",
        "hello world█       ",
        "└──────────────────┘",
      ];
    }
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Key: {
    tab: "\t",
    right: "\x1b[C",
    enter: "\r",
    up: "\x1b[A",
    down: "\x1b[B",
  },
  matchesKey(data: string, key: string): boolean {
    return data === key;
  },
  truncateToWidth(s: string, _w: number, _suffix: string): string { return s; },
  visibleWidth(s: string): number { return s.length; },
}));

import { ShellAutocompleteEditor } from "../editor";
import { defaultConfig } from "../config";

const ghostConfig = defaultConfig.ghost;

function makeEditor() {
  const tui = { requestRender: vi.fn() };
  return new ShellAutocompleteEditor(tui as any, {} as any, {} as any, ghostConfig, () => undefined);
}

describe("ShellAutocompleteEditor", () => {
  let editor: ShellAutocompleteEditor;

  beforeEach(() => {
    editor = makeEditor();
    vi.clearAllMocks();
  });

  describe("setGhostText / getGhostText / clearGhost", () => {
    it("sets and gets ghost text", () => {
      editor.setGhostText("commit");
      expect(editor.getGhostText()).toBe("commit");
    });

    it("clears ghost text", () => {
      editor.setGhostText("commit");
      editor.clearGhost();
      expect(editor.getGhostText()).toBe("");
    });
  });

  describe("handleInput: Tab", () => {
    it("inserts ghost text on Tab when ghost is set", () => {
      editor.setGhostText("ommit");
      editor.handleInput("\t");

      expect(editor.getGhostText()).toBe("");
      expect(
        (editor as any).insertTextAtCursor,
      ).toHaveBeenCalledWith("ommit");
    });

    it("does nothing on Tab when no ghost text", () => {
      editor.handleInput("\t");

      expect(editor.getGhostText()).toBe("");
      expect(
        (editor as any).insertTextAtCursor,
      ).not.toHaveBeenCalledWith(expect.any(String));
    });
  });

  describe("handleInput: RightArrow", () => {
    it("inserts ghost text at end of line", () => {
      // Mock cursor at end: col >= line.length
      vi.spyOn(editor as any, "getCursor").mockReturnValue({ line: 0, col: 20 });
      vi.spyOn(editor as any, "getLines").mockReturnValue(["hello world"]);

      editor.setGhostText("!!!");
      editor.handleInput("\x1b[C");

      expect(editor.getGhostText()).toBe("");
      expect(
        (editor as any).insertTextAtCursor,
      ).toHaveBeenCalledWith("!!!");
    });

    it("clears ghost on input when not at end of line", () => {
      vi.spyOn(editor as any, "getCursor").mockReturnValue({ line: 0, col: 5 });
      vi.spyOn(editor as any, "getLines").mockReturnValue(["!hello world"]);

      editor.setGhostText("!!!");
      editor.handleInput("\x1b[C");

      // Ghost cleared on any input, AI will set new one after debounce
      expect(editor.getGhostText()).toBe("");
    });
  });

  describe("setText", () => {
    it("clears ghost text", () => {
      editor.setGhostText("test");
      editor.setText("new text");

      expect(editor.getGhostText()).toBe("");
    });
  });

  describe("handleInput clears ghost when ! removed", () => {
    it("clears ghost when line no longer has !", () => {
      vi.spyOn(editor as any, "getLines").mockReturnValue(["git c"]);
      vi.spyOn(editor as any, "getCursor").mockReturnValue({ line: 0, col: 5 });

      editor.setGhostText("ommit");
      editor.handleInput("x"); // any key, but line has no !

      expect(editor.getGhostText()).toBe("");
    });

    it("clears ghost on input even when ! present (AI will refresh)", () => {
      vi.spyOn(editor as any, "getLines").mockReturnValue(["!git c"]);
      vi.spyOn(editor as any, "getCursor").mockReturnValue({ line: 0, col: 6 });

      editor.setGhostText("ommit");
      editor.handleInput("x");

      // Ghost cleared on any input — AI will set new one after debounce
      expect(editor.getGhostText()).toBe("");
    });

    it("clears ghost when ! has empty token", () => {
      vi.spyOn(editor as any, "getLines").mockReturnValue(["!"]);
      vi.spyOn(editor as any, "getCursor").mockReturnValue({ line: 0, col: 1 });

      editor.setGhostText("ommit");
      editor.handleInput("\x7f"); // backspace

      expect(editor.getGhostText()).toBe("");
    });
  });

  describe("render", () => {
    it("renders ghost text after cursor block", () => {
      editor.setGhostText("ommit");

      const lines = editor.render(30);
      // Should have ghost text inserted after the █ cursor
      const contentLine = lines[1]!;
      expect(contentLine).toContain("\x1b[38;5;244m");
      expect(contentLine).toContain("ommit");
    });

    it("returns unmodified lines when no ghost text", () => {
      const lines = editor.render(30);
      const contentLine = lines[1]!;
      // No ghost color codes
      expect(contentLine).not.toContain("\x1b[38;5;244m");
    });

    it("truncates ghost text with … when too wide", () => {
      editor.setGhostText("x".repeat(50));

      const lines = editor.render(30);
      const contentLine = lines[1]!;
      expect(contentLine).toContain("\u2026");
    });
  });

  describe("requestRender", () => {
    it("calls tui.requestRender", () => {
      editor.requestRender();
      expect((editor as any).tui.requestRender).toHaveBeenCalled();
    });
  });

  describe("synchronous cache hit", () => {
    it("shows cached ghost immediately on input", () => {
      const tui = { requestRender: vi.fn() };
      const ed = new ShellAutocompleteEditor(
        tui as any, {} as any, {} as any, ghostConfig,
        () => "ommit",
      );
      vi.spyOn(ed as any, "getLines").mockReturnValue(["!git c"]);
      vi.spyOn(ed as any, "getCursor").mockReturnValue({ line: 0, col: 6 });

      ed.handleInput("x");

      expect(ed.getGhostText()).toBe("ommit");
      expect(tui.requestRender).toHaveBeenCalled();
    });

    it("does not show ghost on cache miss", () => {
      const tui = { requestRender: vi.fn() };
      const ed = new ShellAutocompleteEditor(
        tui as any, {} as any, {} as any, ghostConfig,
        () => undefined,
      );
      vi.spyOn(ed as any, "getLines").mockReturnValue(["!git c"]);
      vi.spyOn(ed as any, "getCursor").mockReturnValue({ line: 0, col: 6 });

      ed.handleInput("x");

      expect(ed.getGhostText()).toBe("");
    });
  });
});
