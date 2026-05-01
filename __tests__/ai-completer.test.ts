import { describe, it, expect, vi } from "vitest";
import { AiCompleter } from "../ai-completer";
import { defaultConfig } from "../config";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function c(o?: Partial<typeof defaultConfig.ai>) { return { ...defaultConfig.ai, ...o }; }

describe("AiCompleter", () => {
  it("enabled returns config", () => {
    expect(new AiCompleter(c({ enabled: true })).enabled).toBe(true);
    expect(new AiCompleter(c({ enabled: false })).enabled).toBe(false);
  });

  it("disabled does not call loader", () => {
    const loader = vi.fn();
    const cb = vi.fn();
    new AiCompleter(c({ enabled: false }), loader).predict("git", [], cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("calls onResult via debounce", async () => {
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("commit") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(100);
    expect(cb).toHaveBeenCalledWith("git", "commit");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("cache hit calls onResult immediately", async () => {
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("commit") } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const p1 = new Promise<void>(r => ai.predict("git", [], () => r()));
    await sleep(100); await p1;

    const cb = vi.fn();
    ai.predict("git", [], cb);
    expect(cb).toHaveBeenCalledWith("git", "commit");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("does not call onResult when loader returns null", async () => {
    const loader = vi.fn(() => Promise.resolve(null));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call onResult on error", async () => {
    const loader = vi.fn(() => Promise.reject(new Error("fail")));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(100);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call onResult when result > 100 chars", async () => {
    const loader = vi.fn(() => Promise.resolve(
      { generateInfillCompletion: vi.fn().mockResolvedValue("x".repeat(101)) } as any));
    const ai = new AiCompleter(c({ debounceMs: 50 }), loader);
    const cb = vi.fn();
    ai.predict("git", [], cb);
    await sleep(100);
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
    await sleep(300);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
