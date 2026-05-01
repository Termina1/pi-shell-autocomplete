import { describe, it, expect, vi } from "vitest";
import { scoreAndRank, createShellAutocompleteProvider } from "../provider";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import type { ZshCompleter } from "../zsh-completer";
import type { AiCompleter } from "../ai-completer";
import { defaultConfig, type ShellAutocompleteConfig } from "../config";

function makeConfig(): ShellAutocompleteConfig {
  return { ...defaultConfig, ai: { ...defaultConfig.ai }, ghost: { ...defaultConfig.ghost } };
}

function mockZsh(commands: string[], completions: { value: string; label: string }[] = []) {
  return {
    getCommands: vi.fn().mockResolvedValue(commands),
    getCompletions: vi.fn().mockResolvedValue(completions),
    isAvailable: vi.fn().mockResolvedValue(true),
    checkAvailability: vi.fn().mockResolvedValue(true),
    needsNotification: false,
    markNotified: vi.fn(),
  } as unknown as ZshCompleter;
}

function mockAi() {
  return {
    enabled: true,
    predict: vi.fn().mockResolvedValue("completion"),
  } as unknown as AiCompleter;
}

function mockCurrent(returnNull = false): AutocompleteProvider {
  return {
    getSuggestions: vi.fn().mockResolvedValue(
      returnNull ? null : { items: [], prefix: "" },
    ),
    applyCompletion: vi.fn(),
    shouldTriggerFileCompletion: vi.fn().mockReturnValue(true),
  };
}

describe("scoreAndRank", () => {
  it("ranks prefix matches highest", () => {
    const result = scoreAndRank("git", ["git", "git-lfs", "github-cli", "dig"], 3);
    expect(result[0]!.value).toBe("git");
    expect(result[1]!.value).toBe("git-lfs");
    expect(result[2]!.value).toBe("github-cli");
  });

  it("includes substring matches with lower score", () => {
    const result = scoreAndRank("git", ["digit", "agitprop", "git", "fugitive"], 5);
    const values = result.map((r) => r.value);
    expect(values).toContain("digit"); // contains "git" as substring
    expect(values).toContain("fugitive"); // contains "git"
  });

  it("excludes items with no match", () => {
    const result = scoreAndRank("git", ["docker", "npm", "git", "kubectl"], 5);
    const values = result.map((r) => r.value);
    expect(values).toContain("git");
    expect(values).not.toContain("docker");
    expect(values).not.toContain("npm");
  });

  it("respects limit", () => {
    const items = Array.from({ length: 20 }, (_, i) => `git-${i}`);
    const result = scoreAndRank("git", items, 5);
    expect(result.length).toBe(5);
  });

  it("handles case-insensitive matching", () => {
    const result = scoreAndRank("GIT", ["git", "GIT-LFS", "GitHub", "docker"], 5);
    expect(result[0]!.value).toBe("git");
  });
});

describe("createShellAutocompleteProvider", () => {
  describe("getSuggestions", () => {
    it("delegates to current provider when no ! prefix", async () => {
      const current = mockCurrent();
      const provider = createShellAutocompleteProvider(current, mockZsh([]), mockAi(), makeConfig());

      const result = await provider.getSuggestions(
        ["echo hello"],
        0,
        10,
        { signal: new AbortController().signal } as any,
      );

      expect(current.getSuggestions).toHaveBeenCalled();
    });

    it("returns shell completions for ! prefix (command mode)", async () => {
      const current = mockCurrent(true);
      const zsh = mockZsh(["git", "docker", "github-cli", "dig"]);
      const provider = createShellAutocompleteProvider(current, zsh, mockAi(), makeConfig());

      const result = await provider.getSuggestions(
        ["!git"],
        0,
        4,
        { signal: new AbortController().signal } as any,
      );

      expect(result).not.toBeNull();
      expect(result!.items.length).toBeGreaterThan(0);
      expect(result!.prefix).toBe("git");
      expect(zsh.getCommands).toHaveBeenCalled();
    });

    it("returns positional completions for ! prefix with space", async () => {
      const current = mockCurrent(true);
      const zsh = mockZsh([], [
        { value: "git commit", label: "commit" },
        { value: "git checkout", label: "checkout" },
      ]);
      const provider = createShellAutocompleteProvider(current, zsh, mockAi(), makeConfig());

      const result = await provider.getSuggestions(
        ["!git c"],
        0,
        6,
        { signal: new AbortController().signal } as any,
      );

      expect(result).not.toBeNull();
      expect(zsh.getCompletions).toHaveBeenCalledWith("git c");
    });

    it("fires AI completion as side effect", async () => {
      const current = mockCurrent(true);
      const zsh = mockZsh(["git"]);
      const ai = mockAi();
      let aiResult: string | null = null;
      const provider = createShellAutocompleteProvider(
        current,
        zsh,
        ai,
        makeConfig(),
        (_token, completion) => { aiResult = completion; },
      );

      await provider.getSuggestions(
        ["!git"],
        0,
        4,
        { signal: new AbortController().signal } as any,
      );

      // AI prediction should have been triggered
      expect(ai.predict).toHaveBeenCalledWith("git", expect.any(Array));
    });
  });

  describe("shouldTriggerFileCompletion", () => {
    it("returns false when shell prefix is active", () => {
      const current = mockCurrent();
      const provider = createShellAutocompleteProvider(current, mockZsh([]), mockAi(), makeConfig());

      expect(provider.shouldTriggerFileCompletion!(["!git"], 0, 4)).toBe(false);
    });

    it("delegates to current provider when no shell prefix", () => {
      const current = mockCurrent();
      const provider = createShellAutocompleteProvider(current, mockZsh([]), mockAi(), makeConfig());

      expect(provider.shouldTriggerFileCompletion!(["echo hello"], 0, 10)).toBe(true);
    });
  });
});
