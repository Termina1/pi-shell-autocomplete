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

  it("merges partial overrides with full defaults", () => {
    const config = createConfig({
      ai: { modelPath: "/custom/model.gguf" },
    });
    expect(config.ai.modelPath).toBe("/custom/model.gguf");
    expect(config.ai.enabled).toBe(true);
    expect(config.triggerChar).toBe("!");
  });
});
