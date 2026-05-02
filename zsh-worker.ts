import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type IPty } from "node-pty";
import type { ShellAutocompleteConfig } from "./config";
import type { CompletionItem } from "./zsh-completer";

/**
 * Persistent zsh worker that serves positional completions through a single,
 * long-running PTY. Replaces the per-query spawn used by the legacy
 * `captureCompletions` (zsh-pty.ts) path.
 *
 * Protocol
 * ---------
 * 1. Spawn `zsh -fi` (or `zsh -i` if `sourceRcFile` is set) via node-pty.
 * 2. Bootstrap: clear PROMPT/RPROMPT/PS2, set deterministic completion
 *    options, run `compinit -d <stable-path>`, then `print __PI_WORKER_READY__`.
 *    The reader detects the ready sentinel and resolves any waiters.
 * 3. Each `query(token)` enqueues a request with a unique id. The pump writes
 *
 *        <token>\t\x03print -- __PI_DONE_<id>__\r
 *
 *    `\t`  → expand-or-complete (renders the completion list)
 *    `\x03` → ZLE `send-break` (clears the line, fresh prompt, no command runs)
 *    `print -- __PI_DONE_<id>__\r` → emits the per-query terminating sentinel
 *
 *    The query is dispatched in two stages because ZLE can't reliably process
 *    a Tab keypress and a follow-up clear-line in the same write chunk — the
 *    clear arrives mid-render and corrupts the captured output. Stage 1 writes
 *    `<token>\t` and waits for ZLE to settle (no new bytes for ~50ms, capped
 *    at ~800ms). Stage 2 writes `\x15__pi_done <id>\r` where `\x15` is
 *    Ctrl-U / `backward-kill-line`, reliably emptying the BUFFER — unlike
 *    `\x03` (send-break) which under `AUTO_LIST` after a Tab leaves the
 *    original BUFFER intact, causing our sentinel command to be appended to
 *    the typed token and executed as e.g. `git __pi_done 0` instead of
 *    `__pi_done 0`.
 *    The reader buffers PTY output until it sees `__PI_DONE_<id>__`, then
 *    parses everything before the sentinel as the captured completion list.
 *
 *    NOTE: ZLE echoes typed input back to the terminal as a single chunk,
 *    so any sentinel string we type literally would match in the echo before
 *    zsh actually executed the command. To avoid that, the bootstrap defines
 *    a `__pi_done <id>` helper that prints the sentinel via shell-variable
 *    expansion (`local u='__'; print "${u}PI_DONE_$1${u}"`). The typed echo
 *    contains `__pi_done 0`, not the literal sentinel — so the reader only
 *    matches the *printed* sentinel that arrives once the command actually
 *    runs.
 *
 * 4. Per-query timeout (`zshCompletionTimeoutMs`): caller resolves with `[]`
 *    and the worker is respawned to discard any straggling output.
 * 5. Auto-respawn is rate-limited (`maxRespawnsPerMinute`); past the cap the
 *    worker is permanently disabled for the session and `query()` short-circuits.
 *
 * Concurrency
 * -----------
 * - One outstanding zsh interaction at a time (FIFO queue) — zsh's completion
 *   machinery is not reentrant.
 * - In-flight dedupe: simultaneous `query(token)` calls for the same token
 *   share one PTY round-trip (in addition to the time-based cache in
 *   `ZshCompleter`).
 *
 * Lifecycle
 * ---------
 * - Lazy: the PTY starts on first `query()` (or `prewarm()`).
 * - `prewarm()` resolves once compinit has completed.
 * - `dispose()` kills the PTY and drains pending queries with `[]`.
 * - When `idleTimeoutMs > 0`, the PTY is killed after that many ms of idle and
 *   re-spawned lazily on the next `query()`.
 */

const READY_SENTINEL = "__PI_WORKER_READY__";

/**
 * Bootstrap script written into the persistent zsh PTY.
 *
 * Sentinels are emitted via helper functions (`__pi_ready`, `__pi_done`) that
 * build the sentinel string through variable expansion, so the *typed-echo*
 * of these lines does not contain the literal sentinel and our reader only
 * matches the *printed* output. See the protocol comment at the top of this
 * file for background.
 */
function buildBootstrap(dump: string): string {
  return (
    [
      // Empty / known prompts so prompt redraws don't pollute the capture.
      `PROMPT=''`,
      `RPROMPT=''`,
      `PS2=''`,
      // Always show the list on first Tab; never silently insert the first match.
      `setopt AUTO_LIST 2>/dev/null`,
      `unsetopt MENU_COMPLETE 2>/dev/null`,
      `unsetopt AUTO_MENU 2>/dev/null`,
      `unsetopt LIST_AMBIGUOUS 2>/dev/null`,
      // Don't paginate.
      `LISTMAX=0`,
      // CRITICAL: disable zsh's interactive "do you wish to see all N
      // possibilities?" / "--More--" prompts. Without this, completing a
      // bare `git ` (141 subcommands) makes zsh wait for a keypress and
      // our query times out with no parseable output.
      `zstyle ':completion:*' list-prompt ''`,
      `zstyle ':completion:*' select-prompt ''`,
      // Some completion functions try to call the system pager.
      `export PAGER=cat`,
      // Load the completion system using a stable, dedicated dump file.
      `autoload -Uz compinit`,
      `compinit -d ${shellQuote(dump)} 2>/dev/null`,
      // Sentinel emitters. The function bodies build the sentinel via
      // variable expansion so the typed-echo of these definitions does not
      // contain the literal sentinel string.
      `__pi_ready() { local u='__'; print -- "\${u}PI_WORKER_READY\${u}"; }`,
      `__pi_done() { local u='__'; print -- "\${u}PI_DONE_$1\${u}"; }`,
      // Signal bootstrap-complete.
      `__pi_ready`,
    ].join("\n") + "\n"
  );
}

interface PendingRequest {
  id: number;
  token: string;
  startedAt: number;
  resolve(items: CompletionItem[]): void;
}

/** Per-query state machine. */
type QueryStage = "idle" | "post-tab" | "post-sentinel";

/**
 * After Tab, ZLE first echoes the typed token and then there is typically a
 * pause of 50–200ms while the completion function (e.g. `_git`) computes
 * — sometimes by shelling out to the actual binary (e.g. `git --help`).
 * If we send `\x03` (send-break) during that pause, the completion function is
 * killed before it produces any output. To avoid that we don't start the
 * idle timer until we have observed the first newline AFTER the Tab —
 * which marks the start of completion-list rendering. After rendering
 * begins, the idle timer fires `POST_TAB_IDLE_MS` after the last byte.
 */
const POST_TAB_IDLE_MS = 50;
/**
 * Fallback. If no newline arrives at all (Tab produced no list, or the
 * completion machinery is unusually slow), advance to the sentinel stage
 * after this many ms.
 */
const POST_TAB_HARD_CAP_MS = 800;
/**
 * A literal LF (`\n`) is the reliable marker that zsh has begun rendering
 * completion output: the standard listing is one match per line. The typed
 * echo of `<token>\t` only contains carriage returns and prompt-redraw CSI
 * sequences (e.g. `ESC [ J`) but no LF — those CSIs are NOT a reliable signal
 * that rendering has started, so we deliberately don't match them here.
 */
const LIST_START_HEURISTIC = /\n/;

/**
 * For tests / advanced embedding: lets callers inject a custom PTY factory.
 * Must return an object that conforms to the subset of node-pty's IPty we use.
 */
export type PtySpawn = (
  command: string,
  args: string[],
  opts: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => IPty;

export class ZshWorker {
  // ── State ─────────────────────────────────────────────────────
  private pty: IPty | null = null;
  private dataDisposable: { dispose(): void } | null = null;
  private exitDisposable: { dispose(): void } | null = null;
  private buffer = "";
  private queue: PendingRequest[] = [];
  private inFlight = new Map<string, Promise<CompletionItem[]>>();
  private currentReq: PendingRequest | null = null;
  private currentTimer: NodeJS.Timeout | null = null;
  private queryStage: QueryStage = "idle";
  private postTabIdleTimer: NodeJS.Timeout | null = null;
  private postTabHardTimer: NodeJS.Timeout | null = null;
  private postTabSawListStart = false;
  private bootstrapResolved = false;
  private bootstrapWaiters: Array<() => void> = [];
  private nextRequestId = 0;
  private respawnTimes: number[] = [];
  private _permanentlyDisabled = false;
  private _disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting = false;

  constructor(
    private config: ShellAutocompleteConfig,
    private ptySpawn: PtySpawn = spawn as unknown as PtySpawn,
    private zshPath: string = "/bin/zsh",
  ) {}

  // ── Public state getters ──────────────────────────────────────

  get isReady(): boolean {
    return this.bootstrapResolved && this.pty !== null && !this._disposed;
  }

  get isAlive(): boolean {
    return this.pty !== null && !this._disposed;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get isPermanentlyDisabled(): boolean {
    return this._permanentlyDisabled;
  }

  get respawnCount(): number {
    return this.respawnTimes.length;
  }

  // ── Public API ────────────────────────────────────────────────

  /**
   * Start the worker (if not already started) and resolve once the bootstrap
   * `compinit` has completed. Safe to call multiple times.
   */
  prewarm(): Promise<void> {
    if (this._disposed || this._permanentlyDisabled) return Promise.resolve();
    if (this.isReady) return Promise.resolve();
    if (!this.pty) this.start();
    if (this.isReady) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.bootstrapWaiters.push(resolve);
    });
  }

  /**
   * Get positional completions for a token. Resolves with `[]` on timeout,
   * worker failure, or after the worker has been disabled.
   */
  query(token: string): Promise<CompletionItem[]> {
    if (this._disposed || this._permanentlyDisabled) {
      return Promise.resolve([]);
    }
    const existing = this.inFlight.get(token);
    if (existing) return existing;
    const p = this.enqueueQuery(token);
    this.inFlight.set(token, p);
    // Use .then().finally() variant since `finally` returns the same promise but
    // we want to clean up regardless of resolution path.
    p.finally(() => {
      // Only clear if still pointing at this exact promise.
      if (this.inFlight.get(token) === p) this.inFlight.delete(token);
    }).catch(() => {});
    return p;
  }

  /**
   * Tear down the PTY and drain any pending queries with `[]`.
   * Safe to call more than once.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    for (const req of this.queue) req.resolve([]);
    this.queue = [];
    if (this.currentReq) {
      this.currentReq.resolve([]);
      this.currentReq = null;
    }
    this.queryStage = "idle";
    this.clearPostTabTimers();
    this.clearCurrentTimer();
    this.cancelIdleTimer();

    const waiters = this.bootstrapWaiters;
    this.bootstrapWaiters = [];
    for (const w of waiters) {
      try {
        w();
      } catch {
        /* ignore */
      }
    }

    this.killPty();
  }

  // ── Queue / pump ──────────────────────────────────────────────

  private enqueueQuery(token: string): Promise<CompletionItem[]> {
    return new Promise<CompletionItem[]>((resolve) => {
      const req: PendingRequest = {
        id: this.nextRequestId++,
        token,
        startedAt: Date.now(),
        resolve,
      };
      this.queue.push(req);
      this.cancelIdleTimer();
      this.pump();
    });
  }

  private pump(): void {
    if (this._disposed) return;
    if (this._permanentlyDisabled) {
      while (this.queue.length) this.queue.shift()!.resolve([]);
      return;
    }
    if (this.currentReq) return;
    if (this.queue.length === 0) {
      this.armIdleTimer();
      return;
    }
    if (!this.pty) {
      this.start();
      if (!this.pty || this._permanentlyDisabled) {
        while (this.queue.length) this.queue.shift()!.resolve([]);
        return;
      }
    }
    if (!this.bootstrapResolved) {
      // Re-pump once bootstrap completes. Ensure we only register one waiter.
      if (!this.bootstrapWaiters.includes(this.pumpBound)) {
        this.bootstrapWaiters.push(this.pumpBound);
      }
      return;
    }

    const req = this.queue.shift()!;
    this.currentReq = req;
    this.dispatchRequest(req);
  }

  private pumpBound = () => this.pump();

  private dispatchRequest(req: PendingRequest): void {
    this.currentTimer = setTimeout(
      () => this.onTimeout(req),
      this.config.zshCompletionTimeoutMs,
    );
    // Reset the rolling buffer so we only parse what arrives for this request.
    this.buffer = "";
    this.queryStage = "post-tab";
    this.postTabSawListStart = false;
    // Stage 1: send the token + Tab. ZLE renders the completion list; the
    // post-tab idle/hard-cap timers decide when the list is done rendering
    // and we can safely send Ctrl-U + the sentinel command without ZLE
    // dropping bytes.
    try {
      this.pty!.write(`${req.token}\t`);
    } catch {
      this.respawn();
      return;
    }
    this.armPostTabHardCap();
  }

  private armPostTabHardCap(): void {
    this.clearPostTabTimers();
    this.postTabHardTimer = setTimeout(
      () => this.advanceToSentinelStage(),
      POST_TAB_HARD_CAP_MS,
    );
  }

  private bumpPostTabIdle(): void {
    if (this.postTabIdleTimer) clearTimeout(this.postTabIdleTimer);
    this.postTabIdleTimer = setTimeout(
      () => this.advanceToSentinelStage(),
      POST_TAB_IDLE_MS,
    );
  }

  private advanceToSentinelStage(): void {
    if (this.queryStage !== "post-tab" || !this.currentReq) return;
    this.clearPostTabTimers();
    this.queryStage = "post-sentinel";
    // Stage 2: \x15 (ZLE backward-kill-line / kill-whole-line) reliably
    // empties the BUFFER — \x03 (send-break) is NOT reliable here because
    // zsh's AUTO_LIST + completion-list display puts ZLE into a state
    // where send-break only dismisses the list without clearing the
    // typed BUFFER, so our sentinel command would be appended to the
    // user's token (e.g. `git __pi_done 0`) instead of running standalone.
    try {
      this.pty!.write(`\x15__pi_done ${this.currentReq.id}\r`);
    } catch {
      this.respawn();
    }
  }

  private clearPostTabTimers(): void {
    if (this.postTabIdleTimer) {
      clearTimeout(this.postTabIdleTimer);
      this.postTabIdleTimer = null;
    }
    if (this.postTabHardTimer) {
      clearTimeout(this.postTabHardTimer);
      this.postTabHardTimer = null;
    }
  }

  private completeCurrentRequest(rawBlob: string): void {
    const req = this.currentReq;
    if (!req) return;
    this.currentReq = null;
    this.queryStage = "idle";
    this.clearPostTabTimers();
    this.clearCurrentTimer();
    let items: CompletionItem[];
    try {
      items = parseTabCapture(req.token, rawBlob, this.config.maxDropdownItems);
    } catch {
      items = [];
    }
    req.resolve(items);
    queueMicrotask(() => this.pump());
  }

  private onTimeout(req: PendingRequest): void {
    if (this.currentReq?.id !== req.id) return; // already resolved
    req.resolve([]);
    this.currentReq = null;
    this.queryStage = "idle";
    this.clearPostTabTimers();
    this.clearCurrentTimer();
    // Hard-respawn discards any straggling output and any partially-rendered
    // completion list, leaving the worker in a known state.
    this.respawn();
  }

  // ── PTY data ──────────────────────────────────────────────────

  private onData(data: string): void {
    this.buffer += data;

    // Cap the buffer to defend against runaway output.
    if (this.buffer.length > 256 * 1024) {
      this.buffer = this.buffer.slice(-128 * 1024);
    }

    if (!this.bootstrapResolved) {
      const idx = this.buffer.indexOf(READY_SENTINEL);
      if (idx >= 0) {
        this.bootstrapResolved = true;
        this.buffer = this.buffer.slice(idx + READY_SENTINEL.length);
        const waiters = this.bootstrapWaiters;
        this.bootstrapWaiters = [];
        for (const w of waiters) {
          try {
            w();
          } catch {
            /* ignore */
          }
        }
      }
      return;
    }

    if (!this.currentReq) {
      // No active query; bound the buffer so old prompts don't accumulate.
      if (this.buffer.length > 8192) this.buffer = this.buffer.slice(-2048);
      return;
    }

    if (this.queryStage === "post-tab") {
      // Wait for the first sign that ZLE has *started* rendering the list
      // before we start the idle timer — otherwise the natural pause
      // between the typed-echo and the start of rendering (while `_git`,
      // `_docker`, etc. compute) would fire the idle timer prematurely
      // and `\x03` would kill the completion function before it emits
      // anything.
      if (!this.postTabSawListStart) {
        if (LIST_START_HEURISTIC.test(data)) {
          this.postTabSawListStart = true;
          this.bumpPostTabIdle();
        }
      } else {
        this.bumpPostTabIdle();
      }
      return;
    }

    const sentinel = doneSentinel(this.currentReq.id);
    const idx = this.buffer.indexOf(sentinel);
    if (idx < 0) return;

    const blob = this.buffer.slice(0, idx);
    let after = idx + sentinel.length;
    // Eat trailing CR/LF after the sentinel so the next request starts clean.
    while (after < this.buffer.length && (this.buffer[after] === "\r" || this.buffer[after] === "\n")) {
      after++;
    }
    this.buffer = this.buffer.slice(after);
    this.completeCurrentRequest(blob);
  }

  // ── Process lifecycle ─────────────────────────────────────────

  private start(): void {
    if (this.starting || this.pty || this._disposed) return;
    this.starting = true;
    const args = this.config.zshWorker.sourceRcFile ? ["-i"] : ["-fi"];
    let pty: IPty;
    try {
      pty = this.ptySpawn(this.zshPath, args, {
        name: "xterm-256color",
        cols: 200,
        rows: 50,
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: "xterm-256color",
          PAGER: "cat",
          LESS: "",
        },
      });
    } catch {
      this.starting = false;
      this._permanentlyDisabled = true;
      return;
    }
    this.pty = pty;
    this.starting = false;
    this.dataDisposable = pty.onData((d: string) => {
      try {
        this.onData(d);
      } catch {
        /* ignore */
      }
    });
    this.exitDisposable = pty.onExit(() => this.handlePtyExit());

    // Ensure the compdump directory exists so `compinit -d <path>` can write.
    const dump = expandTilde(this.config.zshWorker.compinitDumpPath);
    try {
      fs.mkdirSync(path.dirname(dump), { recursive: true });
    } catch {
      /* ignore — worst case compinit recomputes each run */
    }

    try {
      pty.write(buildBootstrap(dump));
    } catch {
      this.handlePtyExit();
    }
  }

  private killPty(): void {
    if (this.dataDisposable) {
      try {
        this.dataDisposable.dispose();
      } catch {
        /* ignore */
      }
      this.dataDisposable = null;
    }
    if (this.exitDisposable) {
      try {
        this.exitDisposable.dispose();
      } catch {
        /* ignore */
      }
      this.exitDisposable = null;
    }
    if (!this.pty) return;
    try {
      this.pty.kill();
    } catch {
      /* ignore */
    }
    this.pty = null;
  }

  private handlePtyExit(): void {
    if (this._disposed) return;
    this.pty = null;
    this.bootstrapResolved = false;
    if (this.currentReq) {
      this.currentReq.resolve([]);
      this.currentReq = null;
    }
    this.queryStage = "idle";
    this.clearPostTabTimers();
    this.clearCurrentTimer();
    if (this.queue.length > 0 || this.bootstrapWaiters.length > 0) {
      this.respawn();
    }
  }

  private respawn(): void {
    if (this._disposed) return;
    const now = Date.now();
    this.respawnTimes = this.respawnTimes.filter((t) => now - t < 60_000);
    this.respawnTimes.push(now);
    if (this.respawnTimes.length > this.config.zshWorker.maxRespawnsPerMinute) {
      this._permanentlyDisabled = true;
      this.killPty();
      this.bootstrapResolved = false;
      this.buffer = "";
      while (this.queue.length) this.queue.shift()!.resolve([]);
      const waiters = this.bootstrapWaiters;
      this.bootstrapWaiters = [];
      for (const w of waiters) {
        try {
          w();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    this.killPty();
    this.bootstrapResolved = false;
    this.buffer = "";
    if (this.currentReq) {
      this.currentReq.resolve([]);
      this.currentReq = null;
    }
    this.queryStage = "idle";
    this.clearPostTabTimers();
    this.clearCurrentTimer();
    queueMicrotask(() => this.pump());
  }

  // ── Timers ────────────────────────────────────────────────────

  private clearCurrentTimer(): void {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    const ms = this.config.zshWorker.idleTimeoutMs;
    if (!ms || ms <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this._disposed) return;
      if (this.queue.length === 0 && !this.currentReq) {
        this.killPty();
        this.bootstrapResolved = false;
        this.buffer = "";
      }
    }, ms);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function doneSentinel(id: number): string {
  return `__PI_DONE_${id}__`;
}

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function stripAnsi(s: string): string {
  // CSI sequences (ESC [ ... letter) and OSC sequences (ESC ] ... BEL).
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * Parse the raw blob captured between `<token>\t` and the per-query sentinel.
 * Looks for either `name -- description` lines (zsh's standard list format)
 * or bare token-shaped lines, returning `CompletionItem`s with values that
 * splice the candidate back into the original token's word position.
 */
function parseTabCapture(token: string, rawBlob: string, max: number): CompletionItem[] {
  const cleaned = stripAnsi(rawBlob).replace(/\r/g, "\n");
  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Drop lines that look like prompts, separators, or our own helper output.
    if (/^[@~%❯$#>]/.test(line)) continue;
    if (/^--\s/.test(line)) continue;
    if (/__PI_/.test(line) || /^__pi_/.test(line)) continue;

    // Strict: only accept the canonical zsh listing shape `name  -- description`.
    // This is the format git, docker, kubectl, npm, etc. all use, and it is
    // unambiguous — echoes of typed input or prompt fragments do not match.
    const descMatch = line.match(/^([a-zA-Z0-9][a-zA-Z0-9._:+-]{0,80})\s+--\s/);
    if (!descMatch) continue;
    const candidate = descMatch[1]!;

    const parts = token.split(" ");
    const full =
      parts.length > 1
        ? parts.slice(0, -1).concat(candidate).join(" ")
        : candidate;
    if (seen.has(full)) continue;
    seen.add(full);
    items.push({ value: full, label: candidate });
    if (items.length >= max) break;
  }

  return items;
}

// Exposed for unit tests only.
export const __test = { parseTabCapture, stripAnsi, doneSentinel, READY_SENTINEL };
