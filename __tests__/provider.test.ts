import { describe, it, expect, vi } from "vitest";
import { scoreAndRank, createShellAutocompleteProvider } from "../provider";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
import type { ZshCompleter } from "../zsh-completer";
import type { AiCompleter } from "../ai-completer";
import { defaultConfig, type ShellAutocompleteConfig } from "../config";

function mkConfig(): ShellAutocompleteConfig {
  return { ...defaultConfig, ai: { ...defaultConfig.ai }, ghost: { ...defaultConfig.ghost } };
}

function mockZsh(cmds: string[], pos: { value: string; label: string }[] = []) {
  return { getCommands: vi.fn().mockResolvedValue(cmds), getCompletions: vi.fn().mockResolvedValue(pos), isAvailable: vi.fn().mockResolvedValue(true), checkAvailability: vi.fn().mockResolvedValue(true), needsNotification: false, markNotified: vi.fn() } as unknown as ZshCompleter;
}

function mockAi() { return { enabled: true, predict: vi.fn() } as unknown as AiCompleter; }

function mockCur(n = false): AutocompleteProvider {
  return { getSuggestions: vi.fn().mockResolvedValue(n ? null : { items: [], prefix: "" }), applyCompletion: vi.fn(), shouldTriggerFileCompletion: vi.fn().mockReturnValue(true) };
}

describe("scoreAndRank", () => {
  it("prefix match first", () => { expect(scoreAndRank("git", ["git","git-lfs","dig"],3)[0]!.value).toBe("git"); });
  it("substring included", () => { expect(scoreAndRank("git",["digit","git"],5).map(x=>x.value)).toContain("digit"); });
  it("no-match excluded", () => { expect(scoreAndRank("git",["docker","git"],5).map(x=>x.value)).not.toContain("docker"); });
  it("limit", () => { expect(scoreAndRank("g",Array.from({length:20},(_,i)=>`g${i}`),5).length).toBe(5); });
});

describe("createShellAutocompleteProvider", () => {
  it("delegates without !", async () => {
    const c = mockCur(); await createShellAutocompleteProvider(c,mockZsh([]),mockAi(),mkConfig()).getSuggestions!(["echo"],0,4,{signal:new AbortController().signal} as any);
    expect(c.getSuggestions).toHaveBeenCalled();
  });

  it("returns shell completions for !", async () => {
    const r = await createShellAutocompleteProvider(mockCur(true),mockZsh(["git","docker"]),mockAi(),mkConfig()).getSuggestions!(["!git"],0,4,{signal:new AbortController().signal} as any);
    expect(r).not.toBeNull(); expect(r!.prefix).toBe("git");
  });

  it("positional for ! with space", async () => {
    const z = mockZsh([],[{value:"git commit",label:"commit"}]);
    const r = await createShellAutocompleteProvider(mockCur(true),z,mockAi(),mkConfig()).getSuggestions!(["!git c"],0,6,{signal:new AbortController().signal} as any);
    expect(r).not.toBeNull(); expect(z.getCompletions).toHaveBeenCalledWith("git c");
  });

  it("fires AI as side effect", async () => {
    const ai = mockAi();
    await createShellAutocompleteProvider(mockCur(true),mockZsh(["git"]),ai,mkConfig()).getSuggestions!(["!git"],0,4,{signal:new AbortController().signal} as any);
    expect(ai.predict).toHaveBeenCalledWith("git", expect.any(Array), expect.any(Function));
  });

  it("stale call bails out after await", async () => {
    let rr: (v:string[])=>void;
    const s = new Promise<string[]>(r=>{rr=r}); let n=0;
    const z = { getCommands:vi.fn(()=>{n++;return n===1?s:Promise.resolve(["git"])}), getCompletions:vi.fn().mockResolvedValue([{value:"git x",label:"x"}]), isAvailable:vi.fn().mockResolvedValue(true), checkAvailability:vi.fn().mockResolvedValue(true), needsNotification:false, markNotified:vi.fn() } as unknown as ZshCompleter;
    const p = createShellAutocompleteProvider(mockCur(true),z,mockAi(),mkConfig());
    const sc = p.getSuggestions!(["!git"],0,4,{signal:new AbortController().signal} as any);
    const fc = p.getSuggestions!(["!git "],0,5,{signal:new AbortController().signal} as any);
    expect(await fc).not.toBeNull();
    rr!(["a"]); expect(await sc).toBeNull();
  });

  it("shouldTriggerFileCompletion false for !", () => {
    expect(createShellAutocompleteProvider(mockCur(),mockZsh([]),mockAi(),mkConfig()).shouldTriggerFileCompletion!(["!git"],0,4)).toBe(false);
  });

  it("shouldTriggerFileCompletion true for non-!", () => {
    expect(createShellAutocompleteProvider(mockCur(),mockZsh([]),mockAi(),mkConfig()).shouldTriggerFileCompletion!(["echo"],0,4)).toBe(true);
  });
});
