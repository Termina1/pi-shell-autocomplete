import { describe, it, expect } from "vitest";
import { extractShellToken, hasShellPrefix } from "../prefix";

describe("extractShellToken", () => {
  const trigger = "!";

  it("extracts token after trigger at start of line", () => {
    expect(extractShellToken("!git", trigger)).toBe("git");
  });

  it("extracts multi-word token", () => {
    expect(extractShellToken("!git commit -m", trigger)).toBe("git commit -m");
  });

  it("extracts token after whitespace at start of line", () => {
    expect(extractShellToken("  !git", trigger)).toBe("git");
  });

  it("does NOT trigger when ! is in the middle of text", () => {
    expect(extractShellToken("echo !git", trigger)).toBeUndefined();
  });

  it("triggers only at line start", () => {
    expect(extractShellToken("!git", trigger)).toBe("git");
    expect(extractShellToken("some !git", trigger)).toBeUndefined();
  });

  it("returns empty string for trigger with no token", () => {
    expect(extractShellToken("!", trigger)).toBe("");
  });

  it("returns undefined when no trigger present", () => {
    expect(extractShellToken("git", trigger)).toBeUndefined();
    expect(extractShellToken("echo hello", trigger)).toBeUndefined();
  });

  it("returns undefined for exclamation inside a word", () => {
    // "hello!world" — ! is not at start of word, shouldn't trigger
    expect(extractShellToken("hello!world", trigger)).toBeUndefined();
  });

  it("works with custom trigger character", () => {
    expect(extractShellToken("$HOME", "$")).toBe("HOME");
    expect(extractShellToken("#123", "#")).toBe("123");
  });

  it("handles trigger char that is a regex special character", () => {
    // $ is a regex special character — must be escaped
    const result = extractShellToken("$PATH", "$");
    expect(result).toBe("PATH");
  });
});

describe("hasShellPrefix", () => {
  it("returns true when shell prefix active", () => {
    expect(hasShellPrefix("!git", "!")).toBe(true);
    expect(hasShellPrefix("!", "!")).toBe(true);
  });

  it("returns false when no shell prefix", () => {
    expect(hasShellPrefix("git", "!")).toBe(false);
    expect(hasShellPrefix("hello!world", "!")).toBe(false);
  });
});
