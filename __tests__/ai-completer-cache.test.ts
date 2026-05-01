import { describe, it, expect, vi } from "vitest";
import { AiCompleter } from "../ai-completer";
import { defaultConfig } from "../config";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("AiCompleter cache", () => {
  it("cached token calls onResult immediately without debounce", async () => {
    const loader = vi.fn(() => Promise.resolve({ generateInfillCompletion: vi.fn().mockResolvedValue("commit") } as any));
    const ai = new AiCompleter({ ...defaultConfig.ai, debounceMs: 100 }, loader);

    const p = new Promise<string>((resolve) => ai.predict("git ", [], (_, r) => resolve(r)));
    expect(await p).toBe("commit");

    const t0 = performance.now();
    const p2 = new Promise<string>((resolve) => ai.predict("git ", [], (_, r) => resolve(r)));
    expect(await p2).toBe("commit");
    expect(performance.now() - t0).toBeLessThan(10);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
