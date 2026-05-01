/**
 * Zsh completion capture via node-pty.
 *
 * node-pty gives us a real pseudo-terminal connected to zsh in interactive mode.
 * We send Tab completion characters and capture the rendered output,
 * then parse completions from the terminal display.
 */
import { spawn } from "node-pty";
import type { CompletionItem } from "./zsh-completer";
import type { ShellAutocompleteConfig } from "./config";

const ZSH_PATH = "/bin/zsh";

interface PtyResult {
  items: CompletionItem[];
  rawOutput: string;
}

/**
 * Spawn an interactive zsh via node-pty, load completions, send a Tab-completion
 * for the given token, capture the output, and parse completion candidates.
 */
export function captureCompletions(
  token: string,
  config: ShellAutocompleteConfig,
): Promise<PtyResult> {
  return new Promise((resolve) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ items: [], rawOutput: output });
    }, config.zshCompletionTimeoutMs);

    const pty = spawn(ZSH_PATH, ["-i"], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
    });

    const cleanup = () => {
      clearTimeout(timeout);
      try { pty.kill(); } catch {}
    };

    let stage: "init" | "compinit" | "complete" | "done" = "init";
    let initTimer: ReturnType<typeof setTimeout> | null = null;

    pty.onData((data: string) => {
      output += data;

      switch (stage) {
        case "init":
          // Wait for initial prompt, then load compinit
          if (output.includes("%") || output.includes("❯") || output.includes("$")) {
            stage = "compinit";
            pty.write("autoload -Uz compinit && compinit -D 2>/dev/null\r");
            initTimer = setTimeout(() => {
              if (stage === "compinit") {
                stage = "complete";
                pty.write(`${token}\t`);
                // Give time for completion to render
                setTimeout(() => {
                  stage = "done";
                  cleanup();
                  resolve({ items: parseCompletionOutput(token, output, config.maxDropdownItems), rawOutput: output });
                }, 300);
              }
            }, 300);
          }
          break;

        case "compinit":
          // compinit runs, wait for prompt to reappear
          if (data.includes("%") || data.includes("❯") || data.includes("$")) {
            stage = "complete";
            if (initTimer) clearTimeout(initTimer);
            pty.write(`${token}\t`);
            setTimeout(() => {
              stage = "done";
              cleanup();
              resolve({ items: parseCompletionOutput(token, output, config.maxDropdownItems), rawOutput: output });
            }, 400);
          }
          break;

        case "done":
          // Already resolved
          break;
      }
    });

    pty.onExit(() => {
      cleanup();
      if (stage !== "done") {
        resolve({ items: parseCompletionOutput(token, output, config.maxDropdownItems), rawOutput: output });
      }
    });
  });
}

/**
 * Parse captured terminal output to extract completion candidates.
 * Zsh auto-completion output format:
 *   command_name    -- description
 *   command_name2   -- description2
 */
function parseCompletionOutput(
  token: string,
  output: string,
  maxItems: number,
): CompletionItem[] {
  // Strip ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  const cleaned = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "\n");

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  for (const line of cleaned.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip prompt fragments and garbage
    if (/^[@~%❯$#>]/.test(trimmed)) continue;

    // Extract command from "command    -- description" format
    const cmdMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9._-]{0,40})\s+--\s/);
    if (cmdMatch) {
      const cmd = cmdMatch[1]!;
      if (token.includes(" ")) {
        const firstWord = token.split(" ")[0]!;
        const full = `${firstWord} ${cmd}`;
        if (!seen.has(full)) {
          seen.add(full);
          items.push({ value: full, label: cmd });
        }
      } else {
        if (!seen.has(cmd)) {
          seen.add(cmd);
          items.push({ value: cmd, label: cmd });
        }
      }
    }
  }

  return items.slice(0, maxItems);
}
