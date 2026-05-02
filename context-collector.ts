import { readdir, readFile } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AiConfig } from "./config";
import { Cache } from "./cache";

/**
 * Result from executing a shell command (for git context).
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Function signature for executing shell commands (git CLI).
 * Injected for testability.
 */
export type GitExecFn = (
  command: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<ExecResult>;

/**
 * Injectable context collector for AI autocomplete.
 * Provides file listings, command history, git state, project type,
 * and conversation context to enrich AI prompts.
 */
export interface ContextCollector {
  /** Get a list of file/directory names from the current working directory. */
  getFileContext(): Promise<string[]>;
  /** Get recent commands from shell history. */
  getHistoryContext(): Promise<string[]>;
  /** Get git repository state (branch, modified files, last commit). Returns null if not a git repo or git error. */
  getGitContext(): Promise<string | null>;
  /** Get project type detection (npm, docker, etc.) from known config files. Returns null if no projects detected. */
  getProjectContext(): Promise<string | null>;
  /** Get recent user + assistant messages from the Pi session. Returns null if no messages. */
  getConversationContext(): Promise<string | null>;
}

/**
 * Create a ContextCollector backed by the filesystem.
 * @param config AI configuration controlling which sources and limits
 * @param cwd Current working directory for file context
 * @param gitExec Shell command executor for git CLI (injected for testability)
 * @param sessionManager Optional Pi session manager for conversation context
 */
export function createContextCollector(
  config: AiConfig,
  cwd: string,
  gitExec: GitExecFn,
  sessionManager?: { getBranch(fromId?: string): unknown[] },
): ContextCollector {
  // Per-source TTL caches
  const gitCache = new Cache<string, string | null>(config.gitContext.cacheTtlMs);
  const projectCache = new Cache<string, string | null>(config.projectContext.cacheTtlMs);
  const conversationCache = new Cache<string, string | null>(config.conversationContext.cacheTtlMs);

  // Shared cache key (single value per source type)
  const GIT_KEY = "git";
  const PROJECT_KEY = "project";
  const CONVERSATION_KEY = "conversation";

  return {
    // ── File Context (unchanged) ────────────────────────
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

    // ── History Context (unchanged) ─────────────────────
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

    // ── Git Context ─────────────────────────────────────
    async getGitContext(): Promise<string | null> {
      if (!config.gitContext.enabled) return null;

      const cached = gitCache.get(GIT_KEY);
      if (cached !== undefined) return cached;

      try {
        // Run a single shell command that chains all three git queries.
        // One process spawn instead of three, with a 1000ms timeout.
        const result = await gitExec(
          "sh",
          ["-c", "git branch --show-current 2>/dev/null; echo '---STATUS---'; git status --short 2>/dev/null; echo '---LOG---'; git log -1 --oneline 2>/dev/null"],
          { timeout: 1000 },
        );

        const sections = result.stdout.split(/---(?:STATUS|LOG)---/);
        const branch = sections[0]?.trim() ?? "";
        if (!branch) {
          gitCache.set(GIT_KEY, null);
          return null;
        }

        // Build status part
        let statusPart = "";
        const statusLines = (sections[1] ?? "").trim().split("\n").filter(Boolean);
        const limited = statusLines.slice(0, config.gitContext.maxStatusLines);
        if (limited.length > 0) {
          statusPart = ", " + limited.map((l) => l.trim()).join(", ");
        }

        // Build last commit part
        let logPart = "";
        const logLine = (sections[2] ?? "").trim();
        if (logLine) {
          logPart = `, last: "${logLine}"`;
        }

        const formatted = `branch=${branch}${statusPart}${logPart}`;
        gitCache.set(GIT_KEY, formatted);
        return formatted;
      } catch {
        gitCache.set(GIT_KEY, null);
        return null;
      }
    },

    // ── Project Context ─────────────────────────────────
    async getProjectContext(): Promise<string | null> {
      if (!config.projectContext.enabled) return null;

      const cached = projectCache.get(PROJECT_KEY);
      if (cached !== undefined) return cached;

      try {
        const detections: string[] = [];

        // Check for known project files
        const projectFiles: Array<{ path: string; label: string; extractor?: (content: string) => string }> = [
          {
            path: "package.json",
            label: "npm",
            extractor: (content: string) => {
              try {
                const pkg = JSON.parse(content.slice(0, 65536)); // 64KB cap
                const name = pkg.name ? `"${pkg.name}"` : "";
                const scripts = pkg.scripts
                  ? Object.keys(pkg.scripts).slice(0, 10).join(", ")
                  : "";
                if (!name && !scripts) return "npm project";
                return `npm package${name ? ` ${name}` : ""}${scripts ? ` — scripts: ${scripts}` : ""}`;
              } catch {
                return "npm project";
              }
            },
          },
          { path: "Dockerfile", label: "docker" },
          { path: "Cargo.toml", label: "cargo" },
          { path: "Makefile", label: "make" },
          { path: "requirements.txt", label: "pip" },
          { path: "pyproject.toml", label: "python" },
          { path: "go.mod", label: "go" },
        ];

        for (const pf of projectFiles) {
          const fullPath = join(cwd, pf.path);
          if (!existsSync(fullPath)) continue;

          if (pf.extractor) {
            try {
              const content = await readFile(fullPath, "utf-8");
              detections.push(pf.extractor(content));
            } catch {
              // Fallback: presence-only
              detections.push(`${pf.label} project`);
            }
          } else {
            detections.push(`${pf.label} project`);
          }
        }

        if (detections.length === 0) {
          projectCache.set(PROJECT_KEY, null);
          return null;
        }

        const result = detections.join(", ");
        projectCache.set(PROJECT_KEY, result);
        return result;
      } catch {
        projectCache.set(PROJECT_KEY, null);
        return null;
      }
    },

    // ── Conversation Context ────────────────────────────
    async getConversationContext(): Promise<string | null> {
      if (!config.conversationContext.enabled || !sessionManager) return null;

      const cached = conversationCache.get(CONVERSATION_KEY);
      if (cached !== undefined) return cached;

      try {
        // Walk the session branch from current leaf to root
        const branch = sessionManager.getBranch() as Array<{
          type: string;
          message?: { role: string; content: unknown; timestamp: number };
        }>;

        let lastUserMessage: string | null = null;
        let lastAssistantMessage: string | null = null;

        // Walk from leaf (most recent) to root
        for (const entry of branch) {
          if (entry.type !== "message" || !entry.message) continue;

          const msg = entry.message;
          const role = msg.role;
          const content = extractMessageText(msg.content);

          if (role === "user" && lastUserMessage === null) {
            lastUserMessage = content;
          } else if (role === "assistant" && lastAssistantMessage === null) {
            lastAssistantMessage = content;
          }

          // Once we have both, stop walking
          if (lastUserMessage !== null && lastAssistantMessage !== null) break;
        }

        if (!lastUserMessage && !lastAssistantMessage) {
          conversationCache.set(CONVERSATION_KEY, null);
          return null;
        }

        // Truncate messages to fit within maxChars total
        const maxChars = config.conversationContext.maxChars;
        let userText = lastUserMessage ?? "";
        let assistantText = lastAssistantMessage ?? "";

        if (userText.length + assistantText.length > maxChars) {
          // Divide limit evenly, but give user priority if only one exists
          const half = Math.floor(maxChars / 2);

          if (userText.length > half) {
            userText = userText.slice(0, half - 1) + "…";
          }

          const remaining = maxChars - userText.length;
          if (assistantText) {
            if (assistantText.length > remaining) {
              assistantText = assistantText.slice(0, Math.max(0, remaining - 1)) + "…";
            }
          }
        }

        // Build section
        const parts: string[] = [];
        if (userText) {
          parts.push(`User: ${userText}`);
        }
        if (assistantText) {
          parts.push(`Assistant: ${assistantText}`);
        }

        const result = parts.join("\n");
        conversationCache.set(CONVERSATION_KEY, result);
        return result;
      } catch {
        conversationCache.set(CONVERSATION_KEY, null);
        return null;
      }
    },
  };
}

/**
 * Extract plain text from a message content.
 * Handles both string content and ContentBlock[] arrays.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
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
