/**
 * Integration tests for ZshCompleter against real zsh.
 * Run inside Docker or on a host with zsh + completions.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

// Real shell executor using Node child_process (no bash wrapper)
const realExec = async (command: string, args: string[], opts?: { timeout?: number }) => {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const child = spawn(command, args, {
      timeout: opts?.timeout ?? 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
    child.on("error", () => {
      resolve({ stdout, stderr, code: 1 });
    });
  });
};

import { ZshCompleter } from "../../zsh-completer";
import { defaultConfig } from "../../config";

const config = { ...defaultConfig, ai: { ...defaultConfig.ai }, ghost: { ...defaultConfig.ghost } };

describe("ZshCompleter (real zsh)", () => {
  const completer = new ZshCompleter(config, realExec);

  it("detects zsh availability", async () => {
    const available = await completer.isAvailable();
    expect(available).toBe(true);
  });

  it("returns real commands from zsh", async () => {
    const cmds = await completer.getCommands();
    expect(cmds.length).toBeGreaterThan(100);
    // Common commands should be present
    expect(cmds).toContain("git");
    expect(cmds).toContain("ls");
    expect(cmds).toContain("cat");
    expect(cmds).toContain("echo");
  });

  it("deduplicates commands", async () => {
    const cmds = await completer.getCommands();
    const gitCount = cmds.filter((c) => c === "git").length;
    expect(gitCount).toBe(1);
  });

  it("caches commands (second call faster)", async () => {
    // First call populates cache
    await completer.getCommands();
    // Second call should be instant (from cache)
    const start = Date.now();
    await completer.getCommands();
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(50); // cache hit should be sub-50ms
  });

  it("returns positional completions for git c", async () => {
    // This uses zpty - may be slow on first call
    const items = await completer.getCompletions("git c");
    // Git subcommands starting with 'c': commit, checkout, clean, clone, cherry-pick
    const labels = items.map((i) => i.label);
    expect(labels).toContain("commit");
    expect(labels.length).toBeGreaterThan(0);
  }, 10000);

  it("returns positional completions for git co", async () => {
    const items = await completer.getCompletions("git co");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("commit");
    expect(labels).toContain("config");
  }, 10000);

  it("returns nothing for nonsense command", async () => {
    const items = await completer.getCompletions("xyznonexistent ");
    expect(items.length).toBe(0);
  }, 5000);
});
