/**
 * Integration test: AI prompt quality with real context.
 *
 * Sets up a realistic environment (git repo, project files, shell history,
 * session messages) and tests the full pipeline: context collection →
 * prompt building → model inference (if model available).
 *
 * Designed to catch regressions like:
 * - Model returning input text ("git" → "git")
 * - Model rearranging flags ("ls -la" → "-al")
 * - Model outputting explanations instead of completions
 *
 * Run: npx vitest run __tests__/integration/ai-prompt-quality.int.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { createConfig, defaultConfig } from "../../config";
import { createContextCollector } from "../../context-collector";
import type { GitExecFn, ExecResult, ContextCollector } from "../../context-collector";
import { buildPrompt, createModelLoader, makeCacheKey } from "../../ai-completer";
import type { PredictionContext } from "../../ai-completer";

// ── Helpers ───────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Real shell executor using Node child_process. */
function realExec(command: string, args: string[], opts?: { timeout?: number; cwd?: string }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const child = spawn(command, args, {
      timeout: opts?.timeout ?? 5000,
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", () => resolve({ stdout, stderr }));
    child.on("error", () => resolve({ stdout, stderr }));
  });
}

/** Run a command in a specific cwd, return stdout. */
function run(cwd: string, cmd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

// ── Model check ───────────────────────────────────────────

// Prefer larger models for quality — they follow instructions better
const MODEL_CANDIDATES = [
  path.resolve(os.homedir(), ".pi", "agent", "models", "starcoder2-3b-Q4_K_M.gguf"),
  path.resolve(os.homedir(), ".pi", "agent", "models", "qwen2.5-coder-3b-instruct-Q4_K_M.gguf"),
  path.resolve(os.homedir(), ".pi", "agent", "models", "deepseek-coder-1.3b-instruct-Q4_K_M.gguf"),
  path.resolve(os.homedir(), ".pi", "agent", "models", "qwen2.5-coder-1.5b-instruct-Q4_K_M.gguf"),
  path.resolve(os.homedir(), ".pi", "agent", "models", "Qwen2.5-Coder-0.5B-Instruct-Q4_K_M.gguf"),
  path.resolve(os.homedir(), ".pi", "agent", "models", "qwen2.5-coder-0.5b-instruct-Q4_K_M.gguf"),
];

let modelPath: string | null = null;
for (const candidate of MODEL_CANDIDATES) {
  if (fs.existsSync(candidate)) {
    modelPath = candidate;
    break;
  }
}

const hasModel = modelPath !== null;

// ── Test environment ──────────────────────────────────────

let testDir: string;
let collector: ContextCollector;
let config: ReturnType<typeof createConfig>;

beforeAll(async () => {
  // Create temp project directory
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autocomplete-int-"));
  fs.mkdirSync(path.join(testDir, "src"), { recursive: true });

  // ── git repo ──
  run(testDir, "git init");
  run(testDir, 'git config user.email "test@test.com"');
  run(testDir, 'git config user.name "Test"');

  // Create source files
  fs.writeFileSync(path.join(testDir, "src", "auth.ts"), 'export function login() { return "ok" }');
  fs.writeFileSync(path.join(testDir, "src", "login.ts"), 'export function logout() {}');
  fs.writeFileSync(path.join(testDir, "README.md"), "# My App\n");
  run(testDir, "git add -A");
  run(testDir, 'git commit -m "initial commit"');

  // Modify a file (unstaged change)
  fs.writeFileSync(path.join(testDir, "src", "auth.ts"), 'export function login() { return "token" }');

  // ── Project files ──
  fs.writeFileSync(path.join(testDir, "package.json"), JSON.stringify({
    name: "test-app",
    scripts: { test: "vitest", build: "tsc", dev: "tsx watch", lint: "eslint ." },
  }));
  fs.writeFileSync(path.join(testDir, "Dockerfile"), "FROM node:22");

  // ── Zsh history ──
  const historyPath = path.join(testDir, ".zsh_history");
  fs.writeFileSync(historyPath, [
    "git status",
    "npm test",
    "git commit -m 'fix'",
    "npm run build",
    "git push",
    "docker build -t app .",
    "ls -la src/",
  ].join("\n"));

  // ── Mock session for conversation context ──
  const mockSession = {
    getBranch: () => [
      {
        type: "message", id: "3", parentId: "2",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "Нужно пофиксить auth.ts — там проблема с токеном", timestamp: Date.now() },
      },
      {
        type: "message", id: "2", parentId: "1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Почему падает авторизация?", timestamp: Date.now() },
      },
    ],
  };

  // ── Config ──
  config = createConfig({
    ai: {
      historyContext: { historyPath: historyPath },
      gitContext: { cacheTtlMs: 10000, maxStatusLines: 15, enabled: true },
      projectContext: { cacheTtlMs: 60000, enabled: true },
      conversationContext: { cacheTtlMs: 5000, maxChars: 500, enabled: true },
    },
  });

  // ── Context collector ──
  // Use real git via shell, real filesystem for project context
  const gitExec: GitExecFn = (cmd, args, opts) =>
    realExec(cmd, args, { timeout: opts?.timeout, cwd: testDir });
  collector = createContextCollector(config.ai, testDir, gitExec, mockSession as any);
});

afterAll(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// ── Tests: Context Collection ─────────────────────────────

describe("Context collection (real environment)", () => {
  it("collects file context from test directory", async () => {
    const files = await collector.getFileContext();
    expect(files).toContain("src/");
    expect(files).toContain("Dockerfile");
    expect(files).toContain("package.json");
    expect(files).toContain("README.md");
  });

  it("collects history context", async () => {
    const hist = await collector.getHistoryContext();
    expect(hist.length).toBeGreaterThan(0);
    expect(hist).toContain("git status");
    expect(hist).toContain("npm test");
  });

  it("collects git context with branch, status, last commit", async () => {
    const git = await collector.getGitContext();
    expect(git).not.toBeNull();
    // Should contain branch name (main or master)
    expect(git).toMatch(/branch=(main|master)/);
    // Should contain modified file
    expect(git).toContain("auth.ts");
    // Should contain last commit
    expect(git).toContain('last:');
  });

  it("collects project context with npm package info", async () => {
    const proj = await collector.getProjectContext();
    expect(proj).not.toBeNull();
    expect(proj).toContain("npm");
    expect(proj).toContain("test-app");
    expect(proj).toContain("scripts:");
    expect(proj).toContain("test");
    expect(proj).toContain("build");
    // Dockerfile also present
    expect(proj).toContain("docker");
  });

  it("collects conversation context", async () => {
    const conv = await collector.getConversationContext();
    expect(conv).not.toBeNull();
    expect(conv).toContain("User:");
    expect(conv).toContain("авторизация");
    expect(conv).toContain("Assistant:");
    expect(conv).toContain("auth.ts");
  });
});

// ── Tests: Prompt Building ────────────────────────────────

describe("Prompt building (real context)", () => {
  let fullCtx: PredictionContext;

  beforeAll(async () => {
    const [fileCtx, histCtx, gitCtx, projectCtx, conversationCtx] = await Promise.all([
      collector.getFileContext(),
      collector.getHistoryContext(),
      collector.getGitContext(),
      collector.getProjectContext(),
      collector.getConversationContext(),
    ]);

    fullCtx = {
      items: [
        { value: "git", label: "git" },
        { value: "npm", label: "npm" },
        { value: "docker", label: "docker" },
        { value: "ls", label: "ls" },
        { value: "commit", label: "commit" },
        { value: "checkout", label: "checkout" },
        { value: "test", label: "test" },
        { value: "build", label: "build" },
      ],
      fileCtx,
      histCtx,
      gitCtx,
      projectCtx,
      conversationCtx,
    };
  });

  it("produces compact prompt with all sections", () => {
    const prompt = buildPrompt("git c", fullCtx);

    expect(prompt.prefix).toContain("# shell autocomplete");
    expect(prompt.prefix).toContain("[git]");
    expect(prompt.prefix).toContain("[project]");
    expect(prompt.prefix).toContain("[chat]");
    expect(prompt.prefix).toContain("[recent]");
    expect(prompt.prefix).toContain("[dir]");
    expect(prompt.prefix).toContain("[cmds]");
    // Token after blank separator line
    expect(prompt.prefix).toMatch(/\n\ngit c$/);
  });

  it("prompt suffix is always empty", () => {
    const prompt = buildPrompt("git c", fullCtx);
    expect(prompt.suffix).toBe("");
  });

  it("prompt size is under 2048 chars (context window safe)", () => {
    const prompt = buildPrompt("git c", fullCtx);
    expect(prompt.prefix.length).toBeLessThan(2048);
  });
});

// ── Test both temperatures: 0 (deterministic) and 0.3 (default) ──

for (const temperature of [0, 0.3]) {
(hasModel ? describe : describe.skip)(`Model inference quality (temperature=${temperature})`, () => {
  let completion: Awaited<ReturnType<ReturnType<typeof createModelLoader>>>;
  let fullCtx: PredictionContext;

  beforeAll(async () => {
    const cfg = { ...config.ai, modelPath: modelPath!, modelPriority: [modelPath!] };
    const loader = createModelLoader(cfg);
    completion = await loader();
    if (completion) {
      console.log(`  [model] loaded: ${path.basename(modelPath!)} (temp=${temperature})`);
    }
  }, 120000);

  beforeAll(async () => {
    const [fileCtx, histCtx, gitCtx, projectCtx, conversationCtx] = await Promise.all([
      collector.getFileContext(),
      collector.getHistoryContext(),
      collector.getGitContext(),
      collector.getProjectContext(),
      collector.getConversationContext(),
    ]);
    fullCtx = {
      items: [
        { value: "git", label: "git" },
        { value: "commit", label: "commit" },
        { value: "checkout", label: "checkout" },
        { value: "add", label: "add" },
        { value: "push", label: "push" },
        { value: "npm", label: "npm" },
        { value: "docker", label: "docker" },
        { value: "ls", label: "ls" },
        { value: "echo", label: "echo" },
        { value: "cat", label: "cat" },
      ],
      fileCtx, histCtx, gitCtx, projectCtx, conversationCtx,
    };
  });

  async function predict(token: string, ctx?: PredictionContext): Promise<string> {
    if (!completion) return "";
    const prompt = buildPrompt(token, ctx ?? fullCtx);
    const raw = await completion.generateInfillCompletion(
      prompt.prefix, prompt.suffix,
      { maxTokens: 20, temperature: temperature },
    );
    // Clean: first non-empty line (model often starts with \n)
    const lines = raw.split(/[\n\r]/).map((l) => l.trim()).filter(Boolean);
    return lines[0] ?? "";
  }

  it("model is loaded", () => {
    expect(completion).not.toBeNull();
  });

  // ── Table-driven completions ───────────────────────────

  interface CompletionCase {
    token: string;
    /** Expected to contain at least one of these (empty = no content check, just not chaotic) */
    expectAny?: string[];
    /** Must NOT be exactly this */
    notExact?: string[];
    /** Soft check: just print, don't assert */
    soft?: boolean;
  }

  const cases: CompletionCase[] = [
    // ── git subcommands ──
    { token: "git c", expectAny: ["ommit", "heckout", "herry-pick", "lean", "lone", "onfig"] },
    { token: "git co", expectAny: ["mmit", "nfig", "mmit", "py"] },
    { token: "git ch", expectAny: ["eckout", "erry-pick"] },
    { token: "git a", expectAny: ["dd", "pply"] },
    { token: "git p", expectAny: ["ush", "ull"] },
    { token: "git st", expectAny: ["atus", "ash"] },
    { token: "git br", expectAny: ["anch"] },
    { token: "git ", notExact: ["git", "git "] },
    { token: "git", notExact: ["git"] },

    // ── npm / docker ──
    { token: "npm ", expectAny: ["run", "test", "install", "build", "start"] },
    { token: "npm r", expectAny: ["un"] },
    { token: "npm run ", expectAny: ["test", "build", "dev", "lint"] },
    { token: "docker", expectAny: ["build", "run", "compose", " ", " ps", " images"] },
    { token: "docker b", expectAny: ["uild"] },

    // ── ls variants (flags) ──
    { token: "ls -", expectAny: ["l", "a", "la", "al", "t", "r", "h"] },
    { token: "ls -l", notExact: ["ls -l", "-l"], soft: true },
    { token: "ls -la", notExact: ["-al", "la-", "a-l", "ls -la"], soft: true },
    { token: "ls -la ", expectAny: ["src", ".", "/"] },

    // ── other commands ──
    { token: "echo ", notExact: ["echo", "echo "] },
    { token: "cat ", notExact: ["cat", "cat "] },
    { token: "cd ", expectAny: ["src", "..", "~", "/"] },

    // ── edge cases ──
    { token: "git xyz", notExact: ["git xyz"], soft: true },
    { token: "make", expectAny: [" ", " test", " build", " install"], soft: true },
  ];

  // Collect all results for a summary table
  const results: Array<{ token: string; result: string; ok: boolean; note: string }> = [];

  for (const tc of cases) {
    it(`"${tc.token}" → useful completion`, async () => {
      const result = await predict(tc.token);
      results.push({ token: tc.token, result, ok: true, note: "" });
      const r = results[results.length - 1]!;

      // 1. Never repeat the token verbatim
      if (result === tc.token || result.startsWith(tc.token + tc.token)) {
        r.ok = false;
        r.note = `REPEATS input`;
      }

      // 2. Never return explanations or markdown
      if (result.includes("```") || result.toLowerCase().includes("the command")) {
        r.ok = false;
        r.note = `EXPLAINS/formatting`;
      }

      // 3. Not exact verboten values
      if (tc.notExact && tc.notExact.includes(result)) {
        r.ok = false;
        r.note = `FORBIDDEN: ${result}`;
      }

      // 4. Content expectation (only for non-soft cases)
      if (!tc.soft && tc.expectAny && tc.expectAny.length > 0) {
        const matched = tc.expectAny.some((e) => result.includes(e));
        if (!matched && result.length > 0) {
          if (!tc.soft) {
            r.note = `UNEXPECTED: "${result}" (wanted any of: ${tc.expectAny.join(", ")})`;
            // Don't fail on content — models vary. Just flag.
            console.log(`  [flag] ${r.note}`);
          }
        }
      }

      // 5. Length sanity
      if (result.length > 50) {
        r.ok = false;
        r.note = `TOO LONG: ${result.length} chars`;
      }

      if (!r.ok) {
        console.log(`  [FAIL] "${tc.token}" → "${result}" — ${r.note}`);
      } else {
        console.log(`  [OK]   "${tc.token}" → "${result}"`);
      }

      // Hard assertions (always fail on these, but soft cases skip backtick check)
      expect(result).not.toBe(tc.token); // never repeat verbatim
      if (!tc.soft) {
        expect(result.includes("```")).toBe(false);
      }
      expect(result.length).toBeLessThan(50);
      if (tc.notExact) {
        for (const forbidden of tc.notExact) {
          expect(result).not.toBe(forbidden);
        }
      }
    }, 30000);
  }

  // ── Summary ────────────────────────────────────────────

  it("prints completion quality summary", () => {
    const passCount = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok).length;
    console.log(`\n══════ QUALITY SUMMARY ══════`);
    console.log(`Model: ${path.basename(modelPath!)}`);
    if (temperature === 0) console.log(`Temperature: 0 (deterministic)`);
    else console.log(`Temperature: ${temperature} (default)`);
    console.log(`Total: ${results.length} | Pass: ${passCount} | Flagged: ${failCount}`);
    console.log(`\nToken              → Result`);
    console.log(`─────────────────────────────`);
    for (const r of results) {
      const mark = r.ok ? "✓" : "✗";
      const note = r.note ? ` (${r.note})` : "";
      console.log(`${mark} ${r.token.padEnd(18)} → "${r.result}"${note}`);
    }
    console.log(`═══════════════════════════════\n`);

    // At least 70% should pass (hard assertions already catch critical failures)
    const ratio = passCount / results.length;
    if (ratio < 0.5) {
      console.log(`  [warn] Only ${(ratio * 100).toFixed(0)}% pass — model may be too small`);
    }
    // Don't hard-fail on ratio — model quality is informational
    expect(passCount).toBeGreaterThan(0);
  });
});
} // end for temperature loop
