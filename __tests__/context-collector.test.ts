import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createContextCollector } from "../context-collector";
import type { AiConfig, GitContextConfig, ProjectContextConfig, ConversationContextConfig } from "../config";
import { defaultConfig } from "../config";
import type { GitExecFn } from "../context-collector";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

// Mock node:fs statSync + existsSync
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return { ...actual, statSync: vi.fn(), existsSync: vi.fn() };
});

// Mock node:os homedir
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return { ...actual, homedir: () => "/home/testuser" };
});

function testConfig(overrides: Partial<AiConfig> & {
  fileContext?: Partial<AiConfig["fileContext"]>;
  historyContext?: Partial<AiConfig["historyContext"]>;
  gitContext?: Partial<GitContextConfig>;
  projectContext?: Partial<ProjectContextConfig>;
  conversationContext?: Partial<ConversationContextConfig>;
} = {}): AiConfig {
  return {
    ...defaultConfig.ai,
    fileContext: { ...defaultConfig.ai.fileContext, ...overrides.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...overrides.historyContext },
    gitContext: { ...defaultConfig.ai.gitContext, ...overrides.gitContext },
    projectContext: { ...defaultConfig.ai.projectContext, ...overrides.projectContext },
    conversationContext: { ...defaultConfig.ai.conversationContext, ...overrides.conversationContext },
    ...overrides,
    fileContext: { ...defaultConfig.ai.fileContext, ...overrides.fileContext },
    historyContext: { ...defaultConfig.ai.historyContext, ...overrides.historyContext },
    gitContext: { ...defaultConfig.ai.gitContext, ...overrides.gitContext },
    projectContext: { ...defaultConfig.ai.projectContext, ...overrides.projectContext },
    conversationContext: { ...defaultConfig.ai.conversationContext, ...overrides.conversationContext },
  } as AiConfig;
}

async function getMockFns() {
  const fsPromises = await import("node:fs/promises");
  const fs = await import("node:fs");
  return {
    readdir: fsPromises.readdir as ReturnType<typeof vi.fn>,
    readFile: fsPromises.readFile as ReturnType<typeof vi.fn>,
    statSync: fs.statSync as ReturnType<typeof vi.fn>,
    existsSync: fs.existsSync as ReturnType<typeof vi.fn>,
  };
}

function createMockGitExec(
  results: Partial<{
    branch: string;
    status: string;
    log: string;
    throwError: boolean;
  }> = {},
): GitExecFn {
  return vi.fn(async (_command: string, _args: string[], _opts?: { timeout?: number }) => {
    if (results.throwError) throw new Error("git not found");
    const branch = results.branch ?? "main";
    const status = results.status ?? " M src/auth.ts\n M src/login.ts";
    const log = results.log ?? "abc1234 Fix auth bug";
    return {
      stdout: `${branch}\n---STATUS---\n${status}\n---LOG---\n${log}\n`,
      stderr: "",
    };
  });
}

/** No-op git exec for tests that don't test git context. */
const noopGitExec: GitExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

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
      noopGitExec,
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

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
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
      noopGitExec,
    );
    const result = await cc.getFileContext();
    expect(result).toHaveLength(5);
  });

  it("returns empty array on readdir failure", async () => {
    const { readdir } = await getMockFns();
    readdir.mockRejectedValue(new Error("EACCES"));
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
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

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
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
      noopGitExec,
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
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test", "docker compose up"]);
  });

  it("parses plain command format (no timestamps)", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("git status\nnpm test\ndocker compose up\n");
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
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
      noopGitExec,
    );
    const result = await cc.getHistoryContext();
    expect(result).toHaveLength(5);
    expect(result).toEqual(["cmd-15", "cmd-16", "cmd-17", "cmd-18", "cmd-19"]);
  });

  it("deduplicates commands", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("git status\ngit status\nnpm test\n");
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test"]);
  });

  it("skips empty lines", async () => {
    const { readFile } = await getMockFns();
    readFile.mockResolvedValue("\n\ngit status\n\n\nnpm test\n\n");
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getHistoryContext();
    expect(result).toEqual(["git status", "npm test"]);
  });

  it("returns empty array when history file missing", async () => {
    const { readFile } = await getMockFns();
    readFile.mockRejectedValue(new Error("ENOENT"));
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getHistoryContext();
    expect(result).toEqual([]);
  });

  it("resolves ~ in historyPath to home directory", async () => {
    const { readFile } = await getMockFns();
    readFile.mockRejectedValue(new Error("ENOENT"));
    const cc = createContextCollector(
      testConfig({ historyContext: { enabled: true, maxEntries: 10, historyPath: "~/.zsh_history" } }),
      "/test",
      noopGitExec,
    );
    await cc.getHistoryContext();
    const callPath = readFile.mock.calls[0]?.[0] as string;
    expect(callPath).toBe("/home/testuser/.zsh_history");
  });
});

// ── Git Context (5.7-5.10) ────────────────────────────────

describe("ContextCollector - git context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when gitContext is disabled", async () => {
    const gitExec = createMockGitExec();
    const cc = createContextCollector(
      testConfig({ gitContext: { enabled: false } }),
      "/test",
      gitExec,
    );
    const result = await cc.getGitContext();
    expect(result).toBeNull();
    expect(gitExec).not.toHaveBeenCalled();
  });

  it("formats branch, status, and last commit", async () => {
    const gitExec = createMockGitExec({
      branch: "feature/auth",
      status: " M src/auth.ts\n M src/login.ts",
      log: "abc1234 Fix auth bug",
    });
    const cc = createContextCollector(testConfig(), "/test", gitExec);
    const result = await cc.getGitContext();
    // Status lines are trimmed, so leading spaces are removed
    expect(result).toBe(
      'branch=feature/auth, M src/auth.ts, M src/login.ts, last: "abc1234 Fix auth bug"',
    );
  });

  it("returns null when git commands fail (git not found)", async () => {
    const gitExec = createMockGitExec({ throwError: true });
    const cc = createContextCollector(testConfig(), "/test", gitExec);
    const result = await cc.getGitContext();
    expect(result).toBeNull();
  });

  it("returns null when git commands timeout", async () => {
    const gitExec = vi.fn(async (_command: string, _args: string[], _opts?: { timeout?: number }) => {
      throw new Error("timeout");
    });
    const cc = createContextCollector(testConfig(), "/test", gitExec);
    const result = await cc.getGitContext();
    expect(result).toBeNull();
  });

  it("uses cache — second call within TTL returns cached result", async () => {
    const gitExec = createMockGitExec({
      branch: "main\n",
      status: " M file.txt\n",
      log: "abc Fix\n",
    });
    const cc = createContextCollector(testConfig(), "/test", gitExec);

    const result1 = await cc.getGitContext();
    const result2 = await cc.getGitContext();

    expect(result1).toBe(result2);
    // gitExec should only be called once (single combined command)
    expect(gitExec).toHaveBeenCalledTimes(1);
  });

  it("cache expires after TTL — re-executes git", async () => {
    // Use a short TTL for testing
    const config = testConfig({ gitContext: { enabled: true, maxStatusLines: 15, cacheTtlMs: 1 } });
    const gitExec = createMockGitExec({
      branch: "main",
      status: "",
      log: "abc Fix",
    });
    const cc = createContextCollector(config, "/test", gitExec);

    const result1 = await cc.getGitContext();

    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 5));

    const result2 = await cc.getGitContext();

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    // gitExec called twice (once per invocation)
    expect(gitExec).toHaveBeenCalledTimes(2);
  });

  it("respects maxStatusLines limit", async () => {
    const config = testConfig({ gitContext: { enabled: true, maxStatusLines: 2, cacheTtlMs: 10000 } });
    const gitExec = createMockGitExec({
      branch: "main\n",
      status: " M a.txt\n M b.txt\n M c.txt\n M d.txt\n",
      log: "commit msg\n",
    });
    const cc = createContextCollector(config, "/test", gitExec);
    const result = await cc.getGitContext();
    // Should only include first 2 status lines (trimmed)
    expect(result).toContain("M a.txt, M b.txt");
    expect(result).not.toContain("c.txt");
    expect(result).not.toContain("d.txt");
  });

  it("handles empty branch result (not a git repo)", async () => {
    const gitExec = createMockGitExec({ branch: "" });
    const cc = createContextCollector(testConfig(), "/test", gitExec);
    const result = await cc.getGitContext();
    expect(result).toBeNull();
  });
});

// ── Project Context (5.11-5.13) ──────────────────────────

describe("ContextCollector - project context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when projectContext is disabled", async () => {
    const { existsSync } = await getMockFns();
    existsSync.mockReturnValue(true);

    const cc = createContextCollector(
      testConfig({ projectContext: { enabled: false } }),
      "/test",
      noopGitExec,
    );
    const result = await cc.getProjectContext();
    expect(result).toBeNull();
  });

  it("detects npm project with name and scripts", async () => {
    const { readFile, existsSync } = await getMockFns();
    existsSync.mockImplementation((p: string) => p.endsWith("package.json"));
    readFile.mockResolvedValue(
      JSON.stringify({ name: "my-app", scripts: { test: "jest", build: "tsc", dev: "tsx" } }),
    );

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getProjectContext();
    expect(result).toBe('npm package "my-app" — scripts: test, build, dev');
  });

  it("detects docker project", async () => {
    const { existsSync } = await getMockFns();
    existsSync.mockImplementation((p: string) => p.endsWith("Dockerfile"));

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getProjectContext();
    expect(result).toBe("docker project");
  });

  it("detects multiple project types", async () => {
    const { readFile, existsSync } = await getMockFns();
    existsSync.mockReturnValue(true); // all files present
    readFile.mockResolvedValue(JSON.stringify({ name: "my-app", scripts: { test: "jest" } }));

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getProjectContext();
    expect(result).toContain("npm");
    expect(result).toContain("docker");
    expect(result).toContain("cargo");
    expect(result).toContain("make");
    expect(result).toContain("pip");
    expect(result).toContain("python");
    expect(result).toContain("go");
  });

  it("returns null when no project files detected", async () => {
    const { existsSync } = await getMockFns();
    existsSync.mockReturnValue(false);

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getProjectContext();
    expect(result).toBeNull();
  });

  it("handles package.json read error gracefully", async () => {
    const { readFile, existsSync } = await getMockFns();
    existsSync.mockImplementation((p: string) => p.endsWith("package.json"));
    readFile.mockRejectedValue(new Error("EACCES"));

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getProjectContext();
    expect(result).toBe("npm project");
  });

  it("handles invalid package.json JSON", async () => {
    const { readFile, existsSync } = await getMockFns();
    existsSync.mockImplementation((p: string) => p.endsWith("package.json"));
    readFile.mockResolvedValue("{ invalid json!!!");

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getProjectContext();
    expect(result).toBe("npm project");
  });

  it("uses cache — second call returns cached result", async () => {
    const { existsSync } = await getMockFns();
    existsSync.mockReturnValue(true);

    const cc = createContextCollector(testConfig(), "/test", noopGitExec);

    const result1 = await cc.getProjectContext();
    const result2 = await cc.getProjectContext();

    expect(result1).toBe(result2);
    // existsSync called once per project file (7) for first call, not for second
    const callCount = existsSync.mock.calls.length;
    // Just verify second call doesn't increment
    expect(callCount).toBe(7); // 7 project files checked once
  });
});

// ── Conversation Context (5.14-5.16) ─────────────────────

describe("ContextCollector - conversation context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeMessageEntry = (role: string, content: string, id: string, parentId: string | null) => ({
    type: "message" as const,
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role, content, timestamp: Date.now() },
  });

  it("returns null when conversationContext is disabled", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("user", "hello", "1", null),
      ]),
    };

    const cc = createContextCollector(
      testConfig({ conversationContext: { enabled: false } }),
      "/test",
      noopGitExec,
      sessionManager,
    );
    const result = await cc.getConversationContext();
    expect(result).toBeNull();
  });

  it("returns null when no sessionManager provided", async () => {
    const cc = createContextCollector(testConfig(), "/test", noopGitExec);
    const result = await cc.getConversationContext();
    expect(result).toBeNull();
  });

  it("extracts last user and assistant messages", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("assistant", "Here is the fix", "3", "2"),
        makeMessageEntry("user", "Fix the auth bug", "2", "1"),
        makeMessageEntry("assistant", "Hello how can I help", "1", null),
      ]),
    };

    const cc = createContextCollector(testConfig(), "/test", noopGitExec, sessionManager);
    const result = await cc.getConversationContext();
    expect(result).toBe("User: Fix the auth bug\nAssistant: Here is the fix");
  });

  it("handles only user message (no assistant response yet)", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("user", "Fix the auth bug", "1", null),
      ]),
    };

    const cc = createContextCollector(testConfig(), "/test", noopGitExec, sessionManager);
    const result = await cc.getConversationContext();
    expect(result).toBe("User: Fix the auth bug");
  });

  it("truncates messages to maxChars limit", async () => {
    const longUserMsg = "A".repeat(600);
    const longAssistantMsg = "B".repeat(600);
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("assistant", longAssistantMsg, "2", "1"),
        makeMessageEntry("user", longUserMsg, "1", null),
      ]),
    };

    const config = testConfig({ conversationContext: { enabled: true, maxChars: 100, cacheTtlMs: 5000 } });
    const cc = createContextCollector(config, "/test", noopGitExec, sessionManager);
    const result = await cc.getConversationContext();

    expect(result).not.toBeNull();
    // Total length should be ≤ maxChars + some overhead for "User: ", "Assistant: ", newline, and …
    expect(result!.length).toBeLessThanOrEqual(120);
    expect(result).toContain("…");
  });

  it("returns null when session has no messages", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([]),
    };

    const cc = createContextCollector(testConfig(), "/test", noopGitExec, sessionManager);
    const result = await cc.getConversationContext();
    expect(result).toBeNull();
  });

  it("uses cache — second call returns cached result", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("user", "hello", "1", null),
      ]),
    };

    const cc = createContextCollector(testConfig(), "/test", noopGitExec, sessionManager);

    const result1 = await cc.getConversationContext();
    const result2 = await cc.getConversationContext();

    expect(result1).toBe(result2);
    // getBranch should only be called once
    expect(sessionManager.getBranch).toHaveBeenCalledTimes(1);
  });

  it("cache expires after TTL", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("user", "hello", "1", null),
      ]),
    };

    const config = testConfig({ conversationContext: { enabled: true, maxChars: 500, cacheTtlMs: 1 } });
    const cc = createContextCollector(config, "/test", noopGitExec, sessionManager);

    await cc.getConversationContext();

    // Wait for cache to expire
    await new Promise((r) => setTimeout(r, 5));

    await cc.getConversationContext();
    // getBranch should be called twice
    expect(sessionManager.getBranch).toHaveBeenCalledTimes(2);
  });

  it("extracts text from content blocks", async () => {
    const sessionManager = {
      getBranch: vi.fn().mockReturnValue([
        makeMessageEntry("assistant", [{ type: "text", text: "block response" }], "2", "1"),
        makeMessageEntry("user", "query", "1", null),
      ]),
    };

    const cc = createContextCollector(testConfig(), "/test", noopGitExec, sessionManager);
    const result = await cc.getConversationContext();
    expect(result).toContain("block response");
  });
});
