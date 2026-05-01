import { spawn } from "node-pty";
import type { CompletionItem } from "./zsh-completer";
import type { ShellAutocompleteConfig } from "./config";

const ZSH_PATH = "/bin/zsh";

export function captureCompletions(token: string, config: ShellAutocompleteConfig): Promise<{ items: CompletionItem[]; rawOutput: string }> {
  return new Promise((resolve) => {
    let output = "";
    const done = (items: CompletionItem[]) => { clearTimeout(t); try { p.kill(); } catch {}; resolve({ items, rawOutput: output }); };
    const t = setTimeout(() => done([]), config.zshCompletionTimeoutMs);

    const p = spawn(ZSH_PATH, ["-i"], {
      name: "xterm-256color", cols: 120, rows: 30,
      cwd: process.cwd(), env: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm-256color" },
    });

    let stage = 0;
    p.onData((d: string) => {
      output += d;
      if (stage === 0 && (output.includes("❯") || output.includes("%") || output.includes("$"))) {
        stage = 1;
        p.write("zstyle ':completion:*' list-prompt ''\rLISTMAX=0\r");
        p.write("autoload -Uz compinit && compinit 2>/dev/null\r");
        // Wait for compinit, then send completion
        setTimeout(() => {
          p.write(`${token}\t`);
          setTimeout(() => done(parseOutput(token, output, config.maxDropdownItems)), 600);
        }, 500);
      }
    });
    p.onExit(() => done([]));
  });
}

function parseOutput(token: string, output: string, max: number): CompletionItem[] {
  const cleaned = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\r/g, "\n");
  const items: CompletionItem[] = [];
  const seen = new Set<string>();
  for (const line of cleaned.split("\n")) {
    const t = line.trim();
    if (!t || /^[@~%❯$#>]/.test(t)) continue;
    const m = t.match(/^([a-zA-Z][a-zA-Z0-9._-]{0,40})\s+--\s/);
    if (m) {
      const cmd = m[1]!;
      const full = token.includes(" ") ? `${token.split(" ")[0]!} ${cmd}` : cmd;
      if (!seen.has(full)) { seen.add(full); items.push({ value: full, label: cmd }); }
    }
  }
  return items.slice(0, max);
}
