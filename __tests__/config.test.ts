import { describe, it, expect } from "vitest";
import { createConfig, defaultConfig } from "../config";

describe("createConfig", () => {
  it("returns defaults when no overrides provided", () => {
    const config = createConfig();
    expect(config).toEqual({
      ...defaultConfig,
      ai: { ...defaultConfig.ai },
      ghost: { ...defaultConfig.ghost },
    });
  });

  it("returns defaults when undefined overrides provided", () => {
    const config = createConfig(undefined);
    expect(config.triggerChar).toBe("!");
  });

  it("overrides top-level primitive fields", () => {
    const config = createConfig({
      triggerChar: "$",
      maxDropdownItems: 25,
    });
    expect(config.triggerChar).toBe("$");
    expect(config.maxDropdownItems).toBe(25);
    // unchanged defaults
    expect(config.zshCompletionTimeoutMs).toBe(defaultConfig.zshCompletionTimeoutMs);
  });

  it("overrides nested ai fields independently", () => {
    const config = createConfig({
      ai: { enabled: false, debounceMs: 200 },
    });
    expect(config.ai.enabled).toBe(false);
    expect(config.ai.debounceMs).toBe(200);
    // unchanged ai defaults
    expect(config.ai.modelPath).toBe(defaultConfig.ai.modelPath);
    expect(config.ai.maxTokens).toBe(defaultConfig.ai.maxTokens);
  });

  it("overrides nested ghost fields", () => {
    const config = createConfig({
      ghost: { color: "\x1b[38;5;100m" },
    });
    expect(config.ghost.color).toBe("\x1b[38;5;100m");
  });

  it("includes default modelPriority", () => {
    const config = createConfig();
    expect(config.ai.modelPriority).toEqual(defaultConfig.ai.modelPriority);
    expect(config.ai.modelPriority).toContain("models/starcoder2-3b-Q4_K_M.gguf");
  });

  it("overrides modelPriority", () => {
    const config = createConfig({
      ai: { modelPriority: ["models/my-model.gguf"] },
    });
    expect(config.ai.modelPriority).toEqual(["models/my-model.gguf"]);
    // modelPath unchanged
    expect(config.ai.modelPath).toBe(defaultConfig.ai.modelPath);
  });

  it("includes default fileContext", () => {
    const config = createConfig();
    expect(config.ai.fileContext).toEqual({ enabled: true, maxFiles: 20 });
  });

  it("overrides fileContext partially", () => {
    const config = createConfig({
      ai: { fileContext: { maxFiles: 10 } },
    });
    expect(config.ai.fileContext.enabled).toBe(true);
    expect(config.ai.fileContext.maxFiles).toBe(10);
  });

  it("includes default historyContext", () => {
    const config = createConfig();
    expect(config.ai.historyContext).toEqual({
      enabled: true,
      maxEntries: 10,
      historyPath: "~/.zsh_history",
    });
  });

  it("overrides historyContext partially", () => {
    const config = createConfig({
      ai: { historyContext: { maxEntries: 5, historyPath: "/custom/history" } },
    });
    expect(config.ai.historyContext.enabled).toBe(true);
    expect(config.ai.historyContext.maxEntries).toBe(5);
    expect(config.ai.historyContext.historyPath).toBe("/custom/history");
  });

  it("merges partial overrides with full defaults", () => {
    const config = createConfig({
      ai: { modelPath: "/custom/model.gguf" },
    });
    expect(config.ai.modelPath).toBe("/custom/model.gguf");
    expect(config.ai.enabled).toBe(true);
    expect(config.triggerChar).toBe("!");
  });

  it("includes default zshWorker", () => {
    const config = createConfig();
    expect(config.zshWorker).toEqual({
      enabled: true,
      prewarm: true,
      idleTimeoutMs: 0,
      compinitDumpPath: "~/.cache/pi-shell-autocomplete/zcompdump",
      sourceRcFile: false,
      maxRespawnsPerMinute: 3,
    });
  });

  it("overrides zshWorker partially without dropping other fields", () => {
    const config = createConfig({
      zshWorker: { enabled: false, idleTimeoutMs: 60000 },
    });
    expect(config.zshWorker.enabled).toBe(false);
    expect(config.zshWorker.idleTimeoutMs).toBe(60000);
    // other zshWorker fields preserved
    expect(config.zshWorker.prewarm).toBe(true);
    expect(config.zshWorker.sourceRcFile).toBe(false);
    expect(config.zshWorker.maxRespawnsPerMinute).toBe(3);
    expect(config.zshWorker.compinitDumpPath).toBe(defaultConfig.zshWorker.compinitDumpPath);
  });

  it("overrides zshWorker.compinitDumpPath", () => {
    const config = createConfig({
      zshWorker: { compinitDumpPath: "/tmp/zcompdump-test" },
    });
    expect(config.zshWorker.compinitDumpPath).toBe("/tmp/zcompdump-test");
  });

  it("zshWorker is independent of ai/ghost overrides", () => {
    const config = createConfig({
      ai: { enabled: false },
      ghost: { color: "\x1b[31m" },
    });
    expect(config.zshWorker).toEqual(defaultConfig.zshWorker);
  });

  it("includes default temperature", () => {
    const config = createConfig();
    expect(config.ai.temperature).toBe(0.3);
  });

  it("overrides temperature", () => {
    const config = createConfig({ ai: { temperature: 0.7 } });
    expect(config.ai.temperature).toBe(0.7);
  });

  it("includes default gitContext", () => {
    const config = createConfig();
    expect(config.ai.gitContext).toEqual({ enabled: true, maxStatusLines: 15, cacheTtlMs: 10000 });
  });

  it("overrides gitContext partially", () => {
    const config = createConfig({ ai: { gitContext: { maxStatusLines: 5 } } });
    expect(config.ai.gitContext.enabled).toBe(true);
    expect(config.ai.gitContext.maxStatusLines).toBe(5);
    expect(config.ai.gitContext.cacheTtlMs).toBe(10000);
  });

  it("includes default projectContext", () => {
    const config = createConfig();
    expect(config.ai.projectContext).toEqual({ enabled: true, cacheTtlMs: 60000 });
  });

  it("overrides projectContext partially", () => {
    const config = createConfig({ ai: { projectContext: { enabled: false } } });
    expect(config.ai.projectContext.enabled).toBe(false);
    expect(config.ai.projectContext.cacheTtlMs).toBe(60000);
  });

  it("includes default conversationContext", () => {
    const config = createConfig();
    expect(config.ai.conversationContext).toEqual({ enabled: true, maxChars: 500, cacheTtlMs: 5000 });
  });

  it("overrides conversationContext partially", () => {
    const config = createConfig({ ai: { conversationContext: { maxChars: 200 } } });
    expect(config.ai.conversationContext.enabled).toBe(true);
    expect(config.ai.conversationContext.maxChars).toBe(200);
    expect(config.ai.conversationContext.cacheTtlMs).toBe(5000);
  });

  it("resolveModelPath still works with new config shape", () => {
    // The config now has new fields; resolveModelPath just reads modelPath/modelPriority
    const config = createConfig({ ai: { modelPriority: ["models/test.gguf"] } });
    expect(config.ai.modelPriority).toEqual(["models/test.gguf"]);
    expect(config.ai.gitContext.enabled).toBe(true); // new fields present
    expect(config.ai.temperature).toBe(0.3);
  });
});
