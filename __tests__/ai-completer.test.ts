import { describe, it, expect, vi, beforeEach } from "vitest";
import { AiCompleter, buildPrompt, makeCacheKey } from "../ai-completer";
import { defaultConfig } from "../config";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function c(o?: Partial<typeof defaultConfig.ai> & {
  fileContext?: Partial<typeof defaultConfig.ai.fileContext>;
  historyContext?: Partial<typeof defaultConfig.ai.historyContext>;
}) {
  return {
    ...defaultConfig.ai,
    fileContext: { ...defaultConfig.ai.fileContext, ...o?.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...o?.historyContext },
    ...o,
    fileContext: { ...defaultConfig.ai.fileContext, ...o?.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...o?.historyContext },
  } as typeof defaultConfig.ai;
}

describe("AiCompleter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enabled returns config", () => {
    expect(new AiCompleter(c({ enabled: true })).enabled).toBe(true);
    expect(new AiCompleter(c({ enabled: false })).enabled).toBe(false);
  });

  it("disabled does not call loader", async () => {
    const loader = vi.fn();
    const cb = vi.fn();
    const ai = new AiCompleter(c({ enabled: false }), loader);
    ai.predict("git", [], cb);
    await sleep(50);
    expect(cb).not.toHaveBeenCalled();
  });

  it("calls onResult via debounce", async () => {
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("commit") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).toHaveBeenCalledWith("git", "commit");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("cache hit calls onResult without loader", async () => {
    // Create a mock context collector that returns empty (no context)
    const ctx = {
      getFileContext: vi.fn().mockResolvedValue([]),
      getHistoryContext: vi.fn().mockResolvedValue([]),
    };
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("commit") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);

    // First call — triggers prediction
    const p1 = new Promise<void>(r => {
      ai.predict("git", [], (_t, result) => {
        expect(result).toBe("commit");
        r();
      });
    });
    await sleep(150);
    await p1;

    // Second call with same token — cache hit (no loader call)
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(50);
    expect(cb).toHaveBeenCalledWith("git", "commit");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(ctx.getFileContext).toHaveBeenCalled();
  });

  it("cache miss when context changes", async () => {
    const ctx = {
      getFileContext: vi.fn()
        .mockResolvedValueOnce([]) // first call: no files
        .mockResolvedValueOnce(["README.md"]), // second call: new file
      getHistoryContext: vi.fn().mockResolvedValue([]),
    };
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("x") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);

    // First prediction with empty context
    await new Promise<void>(r => ai.predict("git", [], () => r()));
    await sleep(150);

    // Second prediction — context changed (new file), should re-run inference
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).toHaveBeenCalledWith("git", "x");
    expect(loader).toHaveBeenCalledTimes(2); // second inference triggered
  });

  it("does not call onResult when loader returns null", async () => {
    const loader = vi.fn(() => Promise.resolve(null));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call onResult on error", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("fail")));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call onResult when result > 100 chars", async () => {
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("x".repeat(101)) } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).not.toHaveBeenCalled();
  });

  it("debounce: rapid calls, only last fires", async () => {
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("x") } as any));
    const ai = new AiCompleter(c({ debounceMs: 200 }), loader);
    ai.predict("g", [], () => {});
    await sleep(20);
    ai.predict("gi", [], () => {});
    await sleep(20);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(350);
    expect(cb).toHaveBeenCalledTimes(1); // only last fires
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("context collector failure doesn't block inference", async () => {
    const ctx = {
      getFileContext: vi.fn().mockRejectedValue(new Error("EACCES")),
      getHistoryContext: vi.fn().mockRejectedValue(new Error("ENOENT")),
    };
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("commit") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).toHaveBeenCalledWith("git", "commit");
  });
});

// ── buildPrompt ────────────────────────────────────────────

describe("buildPrompt", () => {
  it("includes all sections when context is present", () => {
    const prompt = buildPrompt("git", [{ value: "commit", label: "commit" }], ["README.md", "src/"], ["git status", "npm test"]);
    expect(prompt.prefix).toContain("# Choose one option and complete it naturally with arguments: commit");
    expect(prompt.prefix).toContain("# Recent commands:");
    expect(prompt.prefix).toContain("#   git status");
    expect(prompt.prefix).toContain("#   npm test");
    expect(prompt.prefix).toContain("# Files in directory:");
    expect(prompt.prefix).toContain("#   README.md");
    expect(prompt.prefix).toContain("#   src/");
    expect(prompt.prefix).toContain("git"); // the token
  });

  it("omits commands section when items empty", () => {
    const prompt = buildPrompt("ls", [], ["file.txt"], []);
    expect(prompt.prefix).not.toContain("# Choose one option");
    expect(prompt.prefix).toContain("# Files in directory:");
    expect(prompt.prefix).toContain("ls");
  });

  it("omits history section when empty", () => {
    const prompt = buildPrompt("git", [{ value: "commit", label: "commit" }], ["file.txt"], []);
    expect(prompt.prefix).toContain("commit");
    expect(prompt.prefix).not.toContain("# Recent commands");
    expect(prompt.prefix).toContain("# Files in directory:");
  });

  it("omits files section when empty", () => {
    const prompt = buildPrompt("git", [{ value: "commit", label: "commit" }], [], ["git status"]);
    expect(prompt.prefix).toContain("commit");
    expect(prompt.prefix).toContain("# Recent commands:");
    expect(prompt.prefix).not.toContain("# Files in directory:");
  });

  it("produces compinit-only prompt when both extras empty", () => {
    const prompt = buildPrompt("git", [{ value: "commit", label: "commit" }], [], []);
    expect(prompt.prefix).toBe(
      "# Choose one option and complete it naturally with arguments: commit\ngit",
    );
  });
});

// ── makeCacheKey ───────────────────────────────────────────

describe("makeCacheKey", () => {
  it("returns bare token when no context", () => {
    expect(makeCacheKey("git", [], [])).toBe("git");
  });

  it("returns token+hash when file context present", () => {
    const key = makeCacheKey("git", ["file.txt", "src/"], []);
    expect(key).toMatch(/^git\|[a-f0-9]{12}$/);
  });

  it("returns token+hash when history context present", () => {
    const key = makeCacheKey("git", [], ["git status"]);
    expect(key).toMatch(/^git\|[a-f0-9]{12}$/);
  });

  it("different context produces different key", () => {
    const key1 = makeCacheKey("git", ["file.txt"], []);
    const key2 = makeCacheKey("git", ["other.txt"], []);
    expect(key1).not.toBe(key2);
  });

  it("same context produces same key", () => {
    const key1 = makeCacheKey("git", ["a", "b"], ["c"]);
    const key2 = makeCacheKey("git", ["a", "b"], ["c"]);
    expect(key1).toBe(key2);
  });
});
