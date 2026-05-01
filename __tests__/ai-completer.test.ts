import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AiCompleter, type ModelLoader } from "../ai-completer";
import { defaultConfig } from "../config";

function makeConfig(overrides?: Partial<typeof defaultConfig.ai>) {
  return { ...defaultConfig.ai, ...overrides };
}

function mockLoader(
  result: string | null,
  error?: Error,
): ModelLoader {
  return vi.fn(async () => {
    if (error) throw error;
    if (result === null) return null;
    return {
      generateInfillCompletion: vi.fn().mockResolvedValue(result),
    } as any;
  });
}

describe("AiCompleter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("enabled", () => {
    it("returns config.enabled", () => {
      expect(
        new AiCompleter(makeConfig({ enabled: true }), mockLoader("x")).enabled,
      ).toBe(true);
      expect(
        new AiCompleter(makeConfig({ enabled: false }), mockLoader("x")).enabled,
      ).toBe(false);
    });
  });

  describe("predict", () => {
    it("returns null when disabled", async () => {
      const c = new AiCompleter(
        makeConfig({ enabled: false }),
        mockLoader("commit"),
      );
      expect(await c.predict("git", [])).toBeNull();
    });

    it("resolves prediction after debounce", async () => {
      const loader = mockLoader("commit");
      const c = new AiCompleter(makeConfig({ debounceMs: 100 }), loader);

      const p = c.predict("git", [{ value: "git", label: "git" }]);
      await vi.advanceTimersByTimeAsync(200);

      expect(await p).toBe("commit");
      expect(loader).toHaveBeenCalledOnce();
    });

    it("returns null when model loader returns null", async () => {
      const c = new AiCompleter(makeConfig({ debounceMs: 100 }), mockLoader(null));
      const p = c.predict("git", []);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toBeNull();
    });

    it("returns null when model loader throws", async () => {
      const c = new AiCompleter(
        makeConfig({ debounceMs: 100 }),
        mockLoader("x", new Error("fail")),
      );
      const p = c.predict("git", []);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toBeNull();
    });

    it("rejects results > 100 chars", async () => {
      const c = new AiCompleter(
        makeConfig({ debounceMs: 100 }),
        mockLoader("x".repeat(101)),
      );
      const p = c.predict("git", []);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toBeNull();
    });

    it("rejects empty results", async () => {
      const c = new AiCompleter(
        makeConfig({ debounceMs: 100 }),
        mockLoader("\n\n"),
      );
      const p = c.predict("git", []);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toBeNull();
    });

    it("debounces rapid calls", async () => {
      const loader = mockLoader("commit");
      const c = new AiCompleter(makeConfig({ debounceMs: 400 }), loader);

      c.predict("g", []);
      c.predict("gi", []);
      const p = c.predict("git", []);

      await vi.advanceTimersByTimeAsync(500);
      await p;

      // Loader should be called only once for the last token
      expect(loader).toHaveBeenCalledTimes(1);
    });
  });
});
