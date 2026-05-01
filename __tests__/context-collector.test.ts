import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContextCollector } from "../context-collector";
import type { AiConfig } from "../config";
import { defaultConfig } from "../config";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

// Mock node:fs statSync
vi.mock("node:fs", () => ({
  statSync: vi.fn(),
}));

// Mock node:os homedir
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return { ...actual, homedir: () => "/home/testuser" };
});

function testConfig(overrides: Partial<AiConfig> & {
  fileContext?: Partial<AiConfig["fileContext"]>;
  historyContext?: Partial<AiConfig["historyContext"]>;
} = {}): AiConfig {
  return {
    ...defaultConfig.ai,
    fileContext: { ...defaultConfig.ai.fileContext, ...overrides.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...overrides.historyContext },
    ...overrides,
    fileContext: { ...defaultConfig.ai.fileContext, ...overrides.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...overrides.historyContext },
  } as AiConfig;
}

async function getMockFns() {
  const fsPromises = await import("node:fs/promises");
  const fs = await import("node:fs");
  return {
    readdir: fsPromises.readdir as ReturnType<typeof vi.fn>,
    readFile: fsPromises.readFile as ReturnType<typeof vi.fn>,
    statSync: fs.statSync as ReturnType<typeof vi.fn>,
  };
}

describe("ContextCollector - file context", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it("returns empty array when fileContext is disabled", async () => {
    const { readdir } = await getMockFns();
    readdir.mockResolvedValue(["a"]);
    const cc = createContextCollector(
      testConfig({ fileContext: { enabled: false, maxFiles: 20 } }),
      "/test",
    );
    const result = await cc.getFileContext();
    expect(result).toEqual([]);
  });

  it("returns sorted entries with dirs first", async () => {
    const { readdir, statSync } = await getMockFns();
    readdir.mockResolvedValue([
      "file-b.txt", "dir-a", "file-a.txt", ".hidden", "dir-b",
    ]);
    statSync.mockImplementation((p: string) => ({
      isDirectory: () => p.endsWith("dir-a") || p.endsWith("dir-b"),
    }));

    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getFileContext();
    expect(result).toEqual(["dir-a/", "dir-b/", "file-a.txt", "file-b.txt"]);
  });

  it("respects maxFiles limit", async () => {
    const { readdir, statSync } = await getMockFns();
    const entries = Array.from({ length: 30 }, (_, i) => `file-${i}.txt`);
    readdir.mockResolvedValue(entries);
    statSync.mockReturnValue({ isDirectory: () => false });

    const cc = createContextCollector(
      testConfig({ fileContext: { enabled: true, maxFiles: 5 } }),
      "/test",
    );
    const result = await cc.getFileContext();
    expect(result).toHaveLength(5);
  });

  it("returns empty array on readdir failure", async () => {
    const { readdir } = await getMockFns();
    readdir.mockRejectedValue(new Error("EACCES"));
    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getFileContext();
    expect(result).toEqual([]);
  });

  it("skips entries where stat throws, treating as file", async () => {
    const { readdir, statSync } = await getMockFns();
    readdir.mockResolvedValue(["good-file", "broken-link"]);
    statSync.mockImplementation((p: string) => {
      if (p.includes("broken-link")) throw new Error("ENOENT");
      return { isDirectory: () => false };
    });

    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getFileContext();
    expect(result).toEqual(["broken-link", "good-file"]);
  });
});

describe("ContextCollector - history context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when historyContext is disabled", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("git status\n");

    const cc = createContextCollector(
      testConfig({ historyContext: { enabled: false, maxEntries: 10, historyPath: "~/.zsh_history" } }),
      "/test",
    );
    const result = await cc.getHistoryContext();
    expect(result).toEqual([]);
  });

  it("parses EXTENDED_HISTORY format", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue(
      ": 1714512000:0;git status\n" +
      ": 1714512010:0;npm test\n" +
      ": 1714512020:0;docker compose up\n",
    );
    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test", "docker compose up"]);
  });

  it("parses plain command format (no timestamps)", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("git status\nnpm test\ndocker compose up\n");
    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test", "docker compose up"]);
  });

  it("respects maxEntries limit", async () => {
    const { readFile } = await getMockFns();
    const lines = Array.from({ length: 20 }, (_, i) => `cmd-${i}`).join("\n");
    readFile.mockResolvedValue(lines);
    const cc = createContextCollector(
      testConfig({ historyContext: { enabled: true, maxEntries: 5, historyPath: "~/.zsh_history" } }),
      "/test",
    );
    const result = await cc.getHistoryContext();
    expect(result).toHaveLength(5);
    expect(result).toEqual(["cmd-15", "cmd-16", "cmd-17", "cmd-18", "cmd-19"]);
  });

  it("deduplicates commands", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("git status\ngit status\nnpm test\n");
    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test"]);
  });

  it("skips empty lines", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("\n\ngit status\n\n\nnpm test\n\n");
    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test"]);
  });

  it("returns empty array when history file missing", async () => {
    const { readFile } = await getMockFns();
    readFile.mockRejectedValue(new Error("ENOENT"));
    const cc = createContextCollector(testConfig(), "/test");
    const result = await cc.getHistoryContext();
    expect(result).toEqual([]);
  });

  it("resolves ~ in historyPath to home directory", async () => {
    const { readFile } = await getMockFns();
    readFile.mockRejectedValue(new Error("ENOENT"));
    const cc = createContextCollector(
      testConfig({ historyContext: { enabled: true, maxEntries: 10, historyPath: "~/.zsh_history" } }),
      "/test",
    );
    await cc.getHistoryContext();
    const callPath = readFile.mock.calls[0]?.[0] as string;
    expect(callPath).toBe("/home/testuser/.zsh_history");
  });
});
