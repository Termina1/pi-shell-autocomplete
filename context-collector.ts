import { readdir, readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AiConfig } from "./config";

/**
 * Injectable context collector for AI autocomplete.
 * Provides file listings and command history to enrich AI prompts.
 */
export interface ContextCollector {
  /** Get a list of file/directory names from the current working directory. */
  getFileContext(): Promise<string[]>;
  /** Get recent commands from shell history. */
  getHistoryContext(): Promise<string[]>;
}

/**
 * Create a ContextCollector backed by the filesystem.
 * @param config AI configuration controlling which sources and limits
 * @param cwd Current working directory for file context
 */
export function createContextCollector(
  config: AiConfig,
  cwd: string,
): ContextCollector {
  return {
    async getFileContext(): Promise<string[]> {
      if (!config.fileContext.enabled) return [];

      try {
        const entries = await withTimeout(
          readdir(cwd),
          500,
        );

        const visible = entries.filter((e) => !e.startsWith("."));

        // Sort: directories first, then alphabetical
        const dirs: string[] = [];
        const files: string[] = [];
        for (const entry of visible) {
          try {
            const fullPath = join(cwd, entry);
            if (statSync(fullPath).isDirectory()) {
              dirs.push(entry + "/");
            } else {
              files.push(entry);
            }
          } catch {
            // If stat fails (e.g., broken symlink), treat as file
            files.push(entry);
          }
        }

        const sorted = [...dirs.sort(), ...files.sort()];
        return sorted.slice(0, config.fileContext.maxFiles);
      } catch {
        return [];
      }
    },

    async getHistoryContext(): Promise<string[]> {
      if (!config.historyContext.enabled) return [];

      try {
        const historyPath = resolveHistoryPath(config.historyContext.historyPath);
        const content = await readFile(historyPath, "utf-8");
        const lines = content.split("\n");

        const commands: string[] = [];
        // Walk from end to get most recent first, then reverse
        for (let i = lines.length - 1; i >= 0 && commands.length < config.historyContext.maxEntries; i--) {
          const line = lines[i]!.trim();
          if (!line) continue;

          // Strip EXTENDED_HISTORY timestamp prefix: ": 1234567890:0;command"
          const command = stripHistoryTimestamp(line);
          if (command && !commands.includes(command)) {
            commands.push(command);
          }
        }

        // Reverse to chronological order (oldest first within the window)
        return commands.reverse();
      } catch {
        return [];
      }
    },
  };
}

/**
 * Resolve a history path: expand ~ to home directory.
 */
function resolveHistoryPath(historyPath: string): string {
  if (historyPath.startsWith("~/")) {
    return join(homedir(), historyPath.slice(2));
  }
  if (historyPath === "~") {
    return join(homedir(), ".zsh_history");
  }
  return historyPath;
}

/**
 * Strip EXTENDED_HISTORY timestamp prefix.
 * Format: ": 1234567890:0;command"
 * Also handles ": 1234567890:0;" prefix with nothing after.
 */
function stripHistoryTimestamp(line: string): string | null {
  // Match ": <digits>:<digits>;" prefix
  const match = line.match(/^:\s*\d+:\d+;(.+)$/);
  if (match) {
    const cmd = match[1]!.trim();
    return cmd || null;
  }
  // No timestamp prefix — use line as-is
  return line;
}

/**
 * Execute a promise with a timeout. Resolves with the promise result or rejects on timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
