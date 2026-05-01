import { describe, it, expect, vi } from "vitest";
import { AiCompleter } from "../ai-completer";
import { defaultConfig } from "../config";
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("race", () => {
  it("model called once, git never cached", async () => {
    let rr: any;
    const loader = vi.fn(() => new Promise(r => { rr = r; }));
    const ai = new AiCompleter({ ...defaultConfig.ai, debounceMs: 80 }, loader);
    const items = [{ value: "git", label: "git" }];

    ai.predict("g", items, () => {}); await sleep(30);
    ai.predict("gi", items, () => {}); await sleep(30);
    ai.predict("git", items, () => {}); await sleep(30);
    ai.predict("git ", items, () => {});
    await sleep(200);
    rr!({ generateInfillCompletion: vi.fn().mockResolvedValue("c") });

    expect(ai.getCached("git")).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
