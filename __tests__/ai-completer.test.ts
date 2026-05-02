import { describe, it, expect, vi, beforeEach } from "vitest";
import { AiCompleter, buildPrompt, makeCacheKey } from "../ai-completer";
import type { PredictionContext } from "../ai-completer";
import { defaultConfig } from "../config";
import type { ContextCollector } from "../context-collector";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function c(o?: Partial<typeof defaultConfig.ai> & {
  fileContext?: Partial<typeof defaultConfig.ai.fileContext>;
  historyContext?: Partial<typeof defaultConfig.ai.historyContext>;
  gitContext?: Partial<typeof defaultConfig.ai.gitContext>;
  projectContext?: Partial<typeof defaultConfig.ai.projectContext>;
  conversationContext?: Partial<typeof defaultConfig.ai.conversationContext>;
}) {
  return {
    ...defaultConfig.ai,
    fileContext: { ...defaultConfig.ai.fileContext, ...o?.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...o?.historyContext },
    gitContext: { ...defaultConfig.ai.gitContext, ...o?.gitContext },
    projectContext: { ...defaultConfig.ai.projectContext, ...o?.projectContext },
    conversationContext: { ...defaultConfig.ai.conversationContext, ...o?.conversationContext },
    ...o,
    fileContext: { ...defaultConfig.ai.fileContext, ...o?.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...o?.historyContext },
    gitContext: { ...defaultConfig.ai.gitContext, ...o?.gitContext },
    projectContext: { ...defaultConfig.ai.projectContext, ...o?.projectContext },
    conversationContext: { ...defaultConfig.ai.conversationContext, ...o?.conversationContext },
  } as typeof defaultConfig.ai;
}

function makeCtx(opts?: Partial<PredictionContext>): PredictionContext {
  return {
    items: [],
    fileCtx: [],
    histCtx: [],
    gitCtx: null,
    projectCtx: null,
    conversationCtx: null,
    ...opts,
  };
}

function createMockCollector(
  overrides?: Partial<ContextCollector>,
): ContextCollector {
  return {
    getFileContext: vi.fn().mockResolvedValue([]),
    getHistoryContext: vi.fn().mockResolvedValue([]),
    getGitContext: vi.fn().mockResolvedValue(null),
    getProjectContext: vi.fn().mockResolvedValue(null),
    getConversationContext: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
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
    const ctx = createMockCollector();
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

  it("cache miss when context changes (after fast cache expiry)", async () => {
    const ctx = createMockCollector({
      getFileContext: vi.fn()
        .mockResolvedValueOnce([]) // first call: no files
        .mockResolvedValueOnce(["README.md"]), // second call: new file
      getGitContext: vi.fn().mockResolvedValue(null),
      getProjectContext: vi.fn().mockResolvedValue(null),
      getConversationContext: vi.fn().mockResolvedValue(null),
    });
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("x") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);

    // First prediction with empty context -> full cache miss -> inference
    await new Promise<void>(r => ai.predict("git", [], () => r()));
    await sleep(150);

    // Wait for fast cache to expire (3s default) so context change triggers new inference
    await sleep(3100);

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
    const ctx = createMockCollector({
      getFileContext: vi.fn().mockRejectedValue(new Error("EACCES")),
      getHistoryContext: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
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
  it("includes all sections compactly when context is present", () => {
    const prompt = buildPrompt("git", makeCtx({
      items: [{ value: "commit", label: "commit" }],
      fileCtx: ["README.md", "src/"],
      histCtx: ["git status", "npm test"],
      gitCtx: "branch=main, M src/auth.ts",
      projectCtx: "npm package \"my-app\"",
      conversationCtx: "User: fix auth\nAssistant: check token.ts",
    }));
    expect(prompt.prefix).toContain("# shell autocomplete");
    expect(prompt.prefix).toContain("[git] branch=main, M src/auth.ts");
    expect(prompt.prefix).toContain('[project] npm package "my-app"');
    expect(prompt.prefix).toContain("[chat] User: fix auth | Assistant: check token.ts");
    expect(prompt.prefix).toContain("[recent] git status, npm test");
    expect(prompt.prefix).toContain("[dir] README.md  src/");
    expect(prompt.prefix).toContain("[cmds] commit");
    // Token after blank line
    expect(prompt.prefix).toMatch(/\n\ngit$/);
  });

  it("omits sections when context is empty", () => {
    const prompt = buildPrompt("ls", makeCtx({
      fileCtx: ["file.txt"],
    }));
    expect(prompt.prefix).toContain("# shell autocomplete");
    expect(prompt.prefix).not.toContain("[git]");
    expect(prompt.prefix).not.toContain("[project]");
    expect(prompt.prefix).not.toContain("[chat]");
    expect(prompt.prefix).not.toContain("[recent]");
    expect(prompt.prefix).toContain("[dir] file.txt");
    expect(prompt.prefix).toMatch(/\n\nls$/);
  });

  it("produces minimal prompt when all sources are empty", () => {
    const prompt = buildPrompt("echo hello", makeCtx());
    expect(prompt.prefix).toBe("# shell autocomplete\n\necho hello");
  });

  it("only includes last 5 recent commands", () => {
    const prompt = buildPrompt("git", makeCtx({
      histCtx: ["cmd1", "cmd2", "cmd3", "cmd4", "cmd5", "cmd6", "cmd7"],
    }));
    expect(prompt.prefix).toContain("cmd3, cmd4, cmd5, cmd6, cmd7");
    expect(prompt.prefix).not.toContain("cmd1");
    expect(prompt.prefix).not.toContain("cmd2");
  });

  it("limits directory listing to 10 entries", () => {
    const manyFiles = Array.from({ length: 15 }, (_, i) => `file${i}.txt`);
    const prompt = buildPrompt("ls", makeCtx({ fileCtx: manyFiles }));
    expect(prompt.prefix).toContain("file0.txt");
    expect(prompt.prefix).toContain("file9.txt");
    expect(prompt.prefix).not.toContain("file10.txt");
  });

  it("suffix is always empty", () => {
    const prompt = buildPrompt("git", makeCtx());
    expect(prompt.suffix).toBe("");
  });
});

// ── makeCacheKey ───────────────────────────────────────────

describe("makeCacheKey", () => {
  it("returns bare token when no context", () => {
    expect(makeCacheKey("git", makeCtx())).toBe("git");
  });

  it("returns token+hash when file context present", () => {
    const key = makeCacheKey("git", makeCtx({ fileCtx: ["file.txt", "src/"] }));
    expect(key).toMatch(/^git\|[a-f0-9]{12}$/);
  });

  it("returns token+hash when history context present", () => {
    const key = makeCacheKey("git", makeCtx({ histCtx: ["git status"] }));
    expect(key).toMatch(/^git\|[a-f0-9]{12}$/);
  });

  it("different context produces different key", () => {
    const key1 = makeCacheKey("git", makeCtx({ fileCtx: ["file.txt"] }));
    const key2 = makeCacheKey("git", makeCtx({ fileCtx: ["other.txt"] }));
    expect(key1).not.toBe(key2);
  });

  it("same context produces same key", () => {
    const key1 = makeCacheKey("git", makeCtx({ fileCtx: ["a", "b"], histCtx: ["c"] }));
    const key2 = makeCacheKey("git", makeCtx({ fileCtx: ["a", "b"], histCtx: ["c"] }));
    expect(key1).toBe(key2);
  });

  it("git context changes produce different keys", () => {
    const key1 = makeCacheKey("git", makeCtx({ gitCtx: "branch=main" }));
    const key2 = makeCacheKey("git", makeCtx({ gitCtx: "branch=feature" }));
    expect(key1).not.toBe(key2);
  });

  it("conversation context changes produce different keys", () => {
    const key1 = makeCacheKey("git", makeCtx({ conversationCtx: "User: hello" }));
    const key2 = makeCacheKey("git", makeCtx({ conversationCtx: "User: goodbye" }));
    expect(key1).not.toBe(key2);
  });
});

// ── Temperature (5.5) ─────────────────────────────────────

describe("temperature", () => {
  it("passes config.temperature to generateInfillCompletion", async () => {
    const genInfill = vi.fn().mockResolvedValue("commit");
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: genInfill } as any));
    const ai = new AiCompleter(
      c({ debounceMs: 50, temperature: 0.7 }),
      loader,
    );
    ai.predict("git", [], () => {});
    await sleep(150);
    expect(genInfill).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ temperature: 0.7 }),
    );
  });

  it("uses default temperature 0.3 when not overridden", async () => {
    const genInfill = vi.fn().mockResolvedValue("commit");
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: genInfill } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    ai.predict("git", [], () => {});
    await sleep(150);
    expect(genInfill).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ temperature: 0.3 }),
    );
  });

  it("passes temperature 0 for deterministic mode", async () => {
    const genInfill = vi.fn().mockResolvedValue("commit");
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: genInfill } as any));
    const ai = new AiCompleter(
      c({ debounceMs: 50, temperature: 0 }),
      loader,
    );
    ai.predict("git", [], () => {});
    await sleep(150);
    expect(genInfill).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ temperature: 0 }),
    );
  });
});

// ── Parallel context collection (5.17) ────────────────────

describe("predictAsync parallel collection", () => {
  it("collects all context sources in parallel via Promise.allSettled", async () => {
    const genInfill = vi.fn().mockResolvedValue("commit");
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: genInfill } as any));

    const ctx = createMockCollector({
      getFileContext: vi.fn().mockResolvedValue(["README.md"]),
      getHistoryContext: vi.fn().mockResolvedValue(["git status"]),
      getGitContext: vi.fn().mockResolvedValue("branch=main, M src/auth.ts"),
      getProjectContext: vi.fn().mockResolvedValue('npm package "my-app"'),
      getConversationContext: vi.fn().mockResolvedValue("User: fix auth\nAssistant: check token"),
    });

    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);

    expect(cb).toHaveBeenCalledWith("git", "commit");
    // All sources should have been called
    expect(ctx.getFileContext).toHaveBeenCalled();
    expect(ctx.getHistoryContext).toHaveBeenCalled();
    expect(ctx.getGitContext).toHaveBeenCalled();
    expect(ctx.getProjectContext).toHaveBeenCalled();
    expect(ctx.getConversationContext).toHaveBeenCalled();
  });

  it("tolerates individual source failures", async () => {
    const genInfill = vi.fn().mockResolvedValue("commit");
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: genInfill } as any));

    const ctx = createMockCollector({
      getFileContext: vi.fn().mockResolvedValue(["README.md"]),
      getHistoryContext: vi.fn().mockResolvedValue(["git status"]),
      getGitContext: vi.fn().mockRejectedValue(new Error("git not found")),
      getProjectContext: vi.fn().mockRejectedValue(new Error("EACCES")),
      getConversationContext: vi.fn().mockResolvedValue(null),
    });

    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);

    // Should still complete successfully
    expect(cb).toHaveBeenCalledWith("git", "commit");
  });

  it("AiCompleter accepts ContextCollector with extended interface", async () => {
    const ctx = createMockCollector();
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("x") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader, ctx);

    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(150);
    expect(cb).toHaveBeenCalled();
  });
});
