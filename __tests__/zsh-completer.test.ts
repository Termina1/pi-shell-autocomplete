import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZshCompleter, type ShellExecutor } from "../zsh-completer";
import { defaultConfig, type ShellAutocompleteConfig } from "../config";

// Mock the persistent worker (used when zshWorker.enabled is true; the default).
// We expose the array of constructed instances via vi.hoisted so tests can
// reach in and seed/inspect each worker mock without fighting hoisting.
const { workerInstances } = vi.hoisted(() => ({ workerInstances: [] as Array<{
  query: ReturnType<typeof vi.fn>;
  prewarm: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> }));
vi.mock("../zsh-worker", () => {
  function MockZshWorker(this: any) {
    this.query = vi.fn();
    this.prewarm = vi.fn().mockResolvedValue(undefined);
    this.dispose = vi.fn();
    this.isReady = true;
    this.isAlive = true;
    this.isDisposed = false;
    this.isPermanentlyDisabled = false;
    this.respawnCount = 0;
    workerInstances.push(this);
  }
  return { ZshWorker: MockZshWorker as unknown as new (...args: unknown[]) => unknown };
});

function makeConfig(overrides?: Partial<ShellAutocompleteConfig>): ShellAutocompleteConfig {
  if (!overrides) return {
    ...defaultConfig,
    zshWorker: { ...defaultConfig.zshWorker },
    ai: { ...defaultConfig.ai },
    ghost: { ...defaultConfig.ghost },
  };
  return {
    ...defaultConfig,
    ...overrides,
    zshWorker: { ...defaultConfig.zshWorker, ...(overrides.zshWorker ?? {}) },
    ai: { ...defaultConfig.ai, ...overrides.ai },
    ghost: { ...defaultConfig.ghost, ...overrides.ghost },
  };
}

function mockExec(responses: Map<string, { stdout: string; code: number }>): ShellExecutor {
  return vi.fn(async (command: string, args: string[], _opts?: { cwd?: string; timeout?: number }) => {
    const key = `${command} ${args.join(" ")}`;
    // Check for substring match to handle varying args
    for (const [pattern, response] of responses) {
      if (key.includes(pattern)) {
        return response;
      }
    }
    return { stdout: "", code: 1 };
  });
}

describe("ZshCompleter", () => {
  describe("isAvailable", () => {
    it("returns true when zsh with compinit works", async () => {
      const exec = mockExec(
        new Map([
          ["compinit", { stdout: "OK\n", code: 0 }],
        ]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      expect(await completer.isAvailable()).toBe(true);
    });

    it("returns false when zsh fails", async () => {
      const exec = mockExec(
        new Map([["compinit", { stdout: "", code: 127 }]]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      expect(await completer.isAvailable()).toBe(false);
    });

    it("returns false when exec throws", async () => {
      const exec = vi.fn().mockRejectedValue(new Error("spawn failed"));
      const completer = new ZshCompleter(makeConfig(), exec);
      expect(await completer.isAvailable()).toBe(false);
    });

    it("caches availability result", async () => {
      const exec = mockExec(
        new Map([["compinit", { stdout: "OK\n", code: 0 }]]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      await completer.isAvailable();
      await completer.isAvailable();
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  describe("checkAvailability", () => {
    it("calls onUnavailable when zsh is not available", async () => {
      const exec = mockExec(new Map([["compinit", { stdout: "", code: 127 }]]));
      const completer = new ZshCompleter(makeConfig(), exec);
      const cb = vi.fn();
      const result = await completer.checkAvailability(cb);
      expect(result).toBe(false);
      expect(cb).toHaveBeenCalledOnce();
    });

    it("does not call onUnavailable twice", async () => {
      const exec = mockExec(new Map([["compinit", { stdout: "", code: 127 }]]));
      const completer = new ZshCompleter(makeConfig(), exec);
      const cb = vi.fn();
      await completer.checkAvailability(cb);
      await completer.checkAvailability(cb);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it("does not call onUnavailable when zsh works", async () => {
      const exec = mockExec(new Map([["compinit", { stdout: "OK\n", code: 0 }]]));
      const completer = new ZshCompleter(makeConfig(), exec);
      const cb = vi.fn();
      const result = await completer.checkAvailability(cb);
      expect(result).toBe(true);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("getCommands", () => {
    it("parses commands from zsh output", async () => {
      const exec = mockExec(
        new Map([
          [
            "print",
            {
              stdout: "git\ndocker\nnpm\nkubectl\n_git_helper\nls\n",
              code: 0,
            },
          ],
        ]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      const cmds = await completer.getCommands();
      expect(cmds).toContain("git");
      expect(cmds).toContain("docker");
      expect(cmds).toContain("npm");
      expect(cmds).toContain("kubectl");
      expect(cmds).toContain("ls");
    });

    it("deduplicates commands", async () => {
      const exec = mockExec(
        new Map([
          [
            "print",
            {
              stdout: "git\ngit\ndocker\ngit\ndocker\nnpm\n",
              code: 0,
            },
          ],
        ]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      const cmds = await completer.getCommands();
      const gitCount = cmds.filter((c) => c === "git").length;
      expect(gitCount).toBe(1);
    });

    it("filters invalid command names", async () => {
      const exec = mockExec(
        new Map([
          [
            "print",
            {
              stdout: "git\n_docker_helper_with_very_long_name_that_is_internal\ngood\n",
              code: 0,
            },
          ],
        ]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      const cmds = await completer.getCommands();
      expect(cmds).toContain("git");
      expect(cmds).toContain("good");
      // _docker_helper_... should be filtered (too long, starts with _)
    });

    it("sorts output alphabetically", async () => {
      const exec = mockExec(
        new Map([
          [
            "print",
            {
              stdout: "docker\ngit\nnpm\n",
              code: 0,
            },
          ],
        ]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      const cmds = await completer.getCommands();
      expect(cmds).toEqual(["docker", "git", "npm"]);
    });

    it("returns empty on exec failure", async () => {
      const exec = mockExec(
        new Map([["print", { stdout: "", code: 1 }]]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      const cmds = await completer.getCommands();
      expect(cmds).toEqual([]);
    });

    it("caches results", async () => {
      const exec = mockExec(
        new Map([["print", { stdout: "git\n", code: 0 }]]),
      );
      const completer = new ZshCompleter(makeConfig(), exec);
      await completer.getCommands();
      await completer.getCommands();
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  describe("getCompletions (worker path)", () => {
    beforeEach(() => {
      workerInstances.length = 0;
    });

    it("returns positional completions from the worker", async () => {
      const exec = mockExec(new Map());
      const completer = new ZshCompleter(makeConfig(), exec);
      const w = workerInstances[0]!;
      w.query.mockResolvedValue([
        { value: "git commit", label: "commit" },
        { value: "git checkout", label: "checkout" },
        { value: "git clean", label: "clean" },
      ]);

      const items = await completer.getCompletions("git c");
      expect(items.length).toBeGreaterThan(0);
      expect(items.some((i) => i.label === "commit")).toBe(true);
      expect(w.query).toHaveBeenCalledWith("git c");
    });

    it("returns empty when the worker rejects", async () => {
      const exec = mockExec(new Map());
      const completer = new ZshCompleter(makeConfig(), exec);
      const w = workerInstances[0]!;
      w.query.mockRejectedValue(new Error("worker failed"));
      const items = await completer.getCompletions("git c");
      expect(items).toEqual([]);
    });

    it("respects maxDropdownItems", async () => {
      const exec = mockExec(new Map());
      const completer = new ZshCompleter(makeConfig({ maxDropdownItems: 5 }), exec);
      const w = workerInstances[0]!;
      // Worker normally caps internally; here we return many to exercise the
      // ZshCompleter-level slice in `getCompletions`.
      const manyItems = Array.from({ length: 30 }, (_, i) => ({
        value: `cmd${i}`,
        label: `cmd${i}`,
      }));
      w.query.mockResolvedValue(manyItems);
      const items = await completer.getCompletions("cmd");
      expect(items.length).toBeLessThanOrEqual(5);
    });

    it("prewarms the worker when zshWorker.prewarm is true", () => {
      const exec = mockExec(new Map());
      new ZshCompleter(
        makeConfig({ zshWorker: { ...defaultConfig.zshWorker, prewarm: true } }),
        exec,
      );
      const w = workerInstances[0]!;
      expect(w.prewarm).toHaveBeenCalled();
    });

    it("does not prewarm when zshWorker.prewarm is false", () => {
      const exec = mockExec(new Map());
      new ZshCompleter(
        makeConfig({ zshWorker: { ...defaultConfig.zshWorker, prewarm: false } }),
        exec,
      );
      const w = workerInstances[0]!;
      expect(w.prewarm).not.toHaveBeenCalled();
    });

    it("dispose() forwards to the worker and is idempotent", () => {
      const exec = mockExec(new Map());
      const completer = new ZshCompleter(makeConfig(), exec);
      const w = workerInstances[0]!;
      completer.dispose();
      completer.dispose();
      expect(w.dispose).toHaveBeenCalledTimes(1);
    });
  });

  describe("worker disabled", () => {
    beforeEach(() => {
      workerInstances.length = 0;
    });

    it("returns empty when worker is disabled", async () => {
      const exec = mockExec(new Map());
      const completer = new ZshCompleter(
        makeConfig({ zshWorker: { ...defaultConfig.zshWorker, enabled: false } }),
        exec,
      );
      const items = await completer.getCompletions("git c");
      expect(items).toEqual([]);
      expect(workerInstances.length).toBe(0);
    });
  });
});
