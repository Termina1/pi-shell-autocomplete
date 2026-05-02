import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Cache } from "./cache";
import type { ShellAutocompleteConfig } from "./config";
import { ZshWorker } from "./zsh-worker";

/**
 * Result of a zsh completion query.
 */
export interface CompletionItem {
  value: string;
  label: string;
}

/**
 * Function signature for executing shell commands.
 */
export interface ShellExecutor {
  (command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{
    stdout: string;
    code: number;
    stderr?: string;
  }>;
}

export class ZshCompleter {
  private commandsCache: Cache<string, string[]>;
  private positionalCache: Cache<string, CompletionItem[]>;
  private available: boolean | null = null;
  private notified = false;
  private worker: ZshWorker | null = null;

  constructor(
    private config: ShellAutocompleteConfig,
    private exec: ShellExecutor,
  ) {
    this.commandsCache = new Cache(config.commandsCacheTtlMs);
    this.positionalCache = new Cache(config.positionalCacheTtlMs);
    if (this.config.zshWorker.enabled) {
      this.worker = new ZshWorker(this.config);
      if (this.config.zshWorker.prewarm) {
        // Fire-and-forget; prewarm() never throws.
        this.worker.prewarm().catch(() => {});
      }
    }
  }

  /**
   * Tear down any persistent resources (currently the zsh worker PTY).
   * Safe to call more than once.
   */
  dispose(): void {
    if (this.worker) {
      this.worker.dispose();
      this.worker = null;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const result = await this.exec(
        "zsh",
        ["-c", "autoload -Uz compinit 2>/dev/null; compinit -D 2>/dev/null; echo OK"],
        { timeout: 3000 },
      );
      this.available = result.code === 0 && result.stdout.trim() === "OK";
    } catch {
      this.available = false;
    }
    return this.available;
  }

  get needsNotification(): boolean {
    return !this.notified && this.available === false;
  }

  markNotified(): void {
    this.notified = true;
  }

  async checkAvailability(onUnavailable?: () => void): Promise<boolean> {
    const avail = await this.isAvailable();
    if (!avail && !this.notified) {
      this.markNotified();
      onUnavailable?.();
    }
    return avail;
  }

  /**
   * Get all available shell commands from zsh (executables, builtins, functions, aliases).
   * Fast (~100ms), deduplicated, sorted.
   */
  async getCommands(): Promise<string[]> {
    const loader = async (): Promise<string[]> => {
      const result = await this.exec(
        "zsh",
        [
          "-c",
          "autoload -Uz compinit 2>/dev/null; compinit -D 2>/dev/null; print -l ${(k)commands} ${(k)builtins} ${(k)functions} ${(k)aliases}",
        ],
        { timeout: this.config.zshCompletionTimeoutMs },
      );
      if (result.code !== 0) return [];

      const seen = new Set<string>();
      const commands: string[] = [];
      for (const line of result.stdout.split("\n")) {
        const cmd = line.trim();
        if (cmd && !seen.has(cmd) && this.isValidCommand(cmd)) {
          seen.add(cmd);
          commands.push(cmd);
        }
      }
      return commands.sort();
    };

    return this.commandsCache.getOrLoad("__commands__", loader);
  }

  /**
   * Get positional completions for a partial command line.
   * Uses zsh with zpty to simulate Tab completion in interactive mode.
   * Falls back to empty if zpty is unavailable (caller can use prefix-matching on commands).
   */
  async getCompletions(token: string): Promise<CompletionItem[]> {
    const loader = async (): Promise<CompletionItem[]> => {
      const items = await this.queryPositionalCompletions(token);
      return items.slice(0, this.config.maxDropdownItems);
    };

    // Positional cache keyed by exact token
    return this.positionalCache.getOrLoad(token, loader);
  }

  // ── Private ────────────────────────────────────────────────

  private async queryPositionalCompletions(
    token: string,
  ): Promise<CompletionItem[]> {
    if (!this.worker) return [];
    try {
      return await this.worker.query(token);
    } catch {
      return [];
    }
  }

  private isValidCommand(name: string): boolean {
    if (!/^[a-zA-Z0-9._-]/.test(name)) return false;
    if (name.length < 2 && !"abcdefghijklmnopqrstuvwxyz".includes(name))
      return false;
    return true;
  }
}
