import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type ShellAutocompleteConfig } from "../config";
import { ZshWorker, type PtySpawn } from "../zsh-worker";

// ── Fake pty ────────────────────────────────────────────────────

class FakePty {
  killed = false;
  written: string[] = [];
  exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  dataListeners: Array<(d: string) => void> = [];

  write(data: string): void {
    this.written.push(data);
  }

  kill(_signal?: string): void {
    this.killed = true;
    // Mimic node-pty firing onExit when the process is killed.
    queueMicrotask(() => {
      for (const cb of this.exitListeners) cb({ exitCode: 0 });
    });
  }

  onData(cb: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(cb);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((c) => c !== cb);
      },
    };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(cb);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((c) => c !== cb);
      },
    };
  }

  // Test helpers
  feed(data: string): void {
    for (const cb of [...this.dataListeners]) cb(data);
  }

  exit(code = 0): void {
    for (const cb of [...this.exitListeners]) cb({ exitCode: code });
  }

  /** Return everything written to the pty as a single string. */
  writtenText(): string {
    return this.written.join("");
  }

  /** Reset accumulated writes (e.g. to ignore the bootstrap script in assertions). */
  resetWrites(): void {
    this.written = [];
  }
}

function makeConfig(overrides?: Partial<ShellAutocompleteConfig>): ShellAutocompleteConfig {
  if (!overrides) {
    return {
      ...defaultConfig,
      zshWorker: { ...defaultConfig.zshWorker },
      ai: { ...defaultConfig.ai },
      ghost: { ...defaultConfig.ghost },
    };
  }
  return {
    ...defaultConfig,
    ...overrides,
    zshWorker: { ...defaultConfig.zshWorker, ...(overrides.zshWorker ?? {}) },
    ai: { ...defaultConfig.ai, ...(overrides.ai ?? {}) },
    ghost: { ...defaultConfig.ghost, ...(overrides.ghost ?? {}) },
  };
}

interface Harness {
  worker: ZshWorker;
  spawnFn: ReturnType<typeof vi.fn> & PtySpawn;
  ptys: FakePty[];
  /** Drive the most recent FakePty through bootstrap by feeding the ready sentinel. */
  finishBootstrap(): void;
  latest(): FakePty;
}

function makeHarness(overrides?: Partial<ShellAutocompleteConfig>): Harness {
  const ptys: FakePty[] = [];
  const spawnFn = vi.fn((_cmd: string, _args: string[]) => {
    const p = new FakePty();
    ptys.push(p);
    return p as unknown as ReturnType<PtySpawn>;
  }) as unknown as ReturnType<typeof vi.fn> & PtySpawn;
  const worker = new ZshWorker(makeConfig(overrides), spawnFn, "/bin/zsh-fake");
  return {
    worker,
    spawnFn,
    ptys,
    latest: () => ptys[ptys.length - 1]!,
    finishBootstrap: () => {
      ptys[ptys.length - 1]!.feed("__PI_WORKER_READY__\n");
    },
  };
}

// Small helper: yield to the microtask queue.
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * Drive a query through the staged protocol against a FakePty.
 *
 * The worker dispatches a query in two stages:
 *  1. write `<token>\t`, then wait for the post-tab idle window after a
 *     newline-containing data event
 *  2. write `\x03__pi_done <id>\r`
 *
 * This helper simulates that flow: feed the list output (with newlines), let
 * the idle timer fire, then feed the sentinel.
 */
async function drive(
  h: Harness,
  listOutput: string,
  id: number,
  opts: { advanceTimers?: boolean } = {},
): Promise<void> {
  // Wait a turn so the worker has written stage-1 (`<token>\t`).
  if (opts.advanceTimers) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await flush();
  }
  // Feed list output — this triggers `LIST_START_HEURISTIC` and bumps idle.
  h.latest().feed(listOutput);
  // Advance past the post-tab idle window so stage 2 fires.
  if (opts.advanceTimers) {
    await vi.advanceTimersByTimeAsync(60);
  } else {
    await new Promise((r) => setTimeout(r, 80));
  }
  // Feed the sentinel — stage 2's reader now resolves the request.
  h.latest().feed(`__PI_DONE_${id}__\n`);
  if (opts.advanceTimers) {
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await flush();
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe("ZshWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("bootstrap", () => {
    it("starts a pty with the configured shell args", async () => {
      const h = makeHarness();
      void h.worker.prewarm();
      await flush();
      expect(h.spawnFn).toHaveBeenCalledTimes(1);
      const [cmd, args] = h.spawnFn.mock.calls[0]!;
      expect(cmd).toBe("/bin/zsh-fake");
      expect(args).toEqual(["-fi"]);
      // Bootstrap script was written.
      const out = h.latest().writtenText();
      expect(out).toContain("autoload -Uz compinit");
      expect(out).toContain("compinit -d");
      // Helpers that emit the sentinels via shell-variable expansion (so the
      // typed-echo of the bootstrap script does NOT contain the literal
      // sentinel and our reader only matches the printed output).
      expect(out).toContain("__pi_ready");
      expect(out).toContain("__pi_done");
      expect(out).toMatch(/PI_WORKER_READY/);
      // CRITICALLY: the bootstrap script must NOT contain the literal
      // sentinel string; otherwise the typed-echo would falsely trigger
      // the bootstrap-detected state.
      expect(out).not.toContain("__PI_WORKER_READY__");
    });

    it("uses '-i' when sourceRcFile is true", async () => {
      const h = makeHarness({ zshWorker: { ...defaultConfig.zshWorker, sourceRcFile: true } });
      void h.worker.prewarm();
      await flush();
      const [, args] = h.spawnFn.mock.calls[0]!;
      expect(args).toEqual(["-i"]);
    });

    it("prewarm() resolves only after __PI_WORKER_READY__ is seen", async () => {
      const h = makeHarness();
      let resolved = false;
      const p = h.worker.prewarm().then(() => {
        resolved = true;
      });
      await flush();
      expect(resolved).toBe(false);
      expect(h.worker.isReady).toBe(false);
      h.finishBootstrap();
      await p;
      expect(resolved).toBe(true);
      expect(h.worker.isReady).toBe(true);
    });

    it("prewarm() called twice resolves once for both callers", async () => {
      const h = makeHarness();
      const a = h.worker.prewarm();
      const b = h.worker.prewarm();
      await flush();
      h.finishBootstrap();
      await Promise.all([a, b]);
      expect(h.spawnFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("query", () => {
    it("writes the framed protocol and resolves with parsed items", async () => {
      const h = makeHarness();
      const qp = h.worker.query("git c");
      await flush();
      h.finishBootstrap();
      await flush();

      // Stage 1 only — the sentinel command must NOT yet have been written.
      let writes = h.latest().writtenText();
      expect(writes).toContain("git c\t");
      expect(writes).not.toContain("__pi_done 0");

      await drive(
        h,
        "commit  -- record changes to the repository\n" +
          "checkout -- switch branches or restore working tree files\n" +
          "clone    -- clone a repository into a new directory\n",
        0,
      );

      // Stage 2 was sent (Ctrl-U + helper command).
      writes = h.latest().writtenText();
      expect(writes).toContain("\x15__pi_done 0\r");

      const items = await qp;
      expect(items).toHaveLength(3);
      expect(items[0]).toEqual({ value: "git commit", label: "commit" });
      expect(items[1]).toEqual({ value: "git checkout", label: "checkout" });
      expect(items[2]).toEqual({ value: "git clone", label: "clone" });
    });

    it("respects maxDropdownItems", async () => {
      const h = makeHarness({ maxDropdownItems: 2 });
      const qp = h.worker.query("a");
      await flush();
      h.finishBootstrap();
      await drive(h, "alpha -- one\nbeta  -- two\ngamma -- three\n", 0);
      const items = await qp;
      expect(items).toHaveLength(2);
    });

    it("queues a second query and assigns sequential ids", async () => {
      const h = makeHarness();
      const a = h.worker.query("alpha");
      const b = h.worker.query("beta");
      await flush();
      h.finishBootstrap();
      await flush();

      // Only the first request's stage-1 should be written.
      let writes = h.latest().writtenText();
      expect(writes).toContain("alpha\t");
      expect(writes).not.toContain("beta\t");
      expect(writes).not.toContain("__pi_done 1");

      await drive(h, "aone -- 1\n", 0);
      const aItems = await a;
      expect(aItems[0]?.label).toBe("aone");

      // After microtask, second request's stage-1 should be dispatched.
      await flush();
      writes = h.latest().writtenText();
      expect(writes).toContain("beta\t");

      await drive(h, "bone -- 1\n", 1);
      const bItems = await b;
      expect(bItems[0]?.label).toBe("bone");
    });

    it("ignores stale output for an old id", async () => {
      const h = makeHarness();
      const a = h.worker.query("alpha");
      await flush();
      h.finishBootstrap();
      await drive(h, "aone -- 1\n", 0);
      await a;

      // Stale output for id 99 should not affect the next query.
      h.latest().feed("ghost -- old\n__PI_DONE_99__\n");

      const b = h.worker.query("beta");
      await drive(h, "bone -- 1\n", 1);
      const items = await b;
      expect(items.map((i) => i.label)).toEqual(["bone"]);
    });

    it("dedupes in-flight queries for the same token (single PTY write)", async () => {
      const h = makeHarness();
      const p1 = h.worker.query("foo");
      const p2 = h.worker.query("foo");
      // The two callers must share the very same promise.
      expect(p1).toBe(p2);
      await flush();
      h.finishBootstrap();
      await flush();
      const writes = h.latest().writtenText();
      // Token appears in only one query payload (one stage-1 write).
      const matches = writes.match(/foo\t/g);
      expect(matches).toHaveLength(1);
      await drive(h, "foozle -- 1\n", 0);
      const [a, b] = await Promise.all([p1, p2]);
      expect(a).toBe(b);
    });
  });

  describe("timeout & respawn", () => {
    it("resolves the caller with [] on timeout and respawns", async () => {
      vi.useFakeTimers();
      const h = makeHarness({ zshCompletionTimeoutMs: 100 });
      const qp = h.worker.query("hangs");
      // Bootstrap immediately, then never deliver list output OR sentinel.
      await vi.advanceTimersByTimeAsync(0);
      h.finishBootstrap();
      await vi.advanceTimersByTimeAsync(0);

      const firstPty = h.latest();
      // Trigger the per-query timeout.
      await vi.advanceTimersByTimeAsync(150);
      const items = await qp;
      expect(items).toEqual([]);
      expect(firstPty.killed).toBe(true);
      expect(h.worker.respawnCount).toBe(1);

      // After the next query is issued, a new pty is spawned.
      const next = h.worker.query("again");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.spawnFn).toHaveBeenCalledTimes(2);
      // Bootstrap the new worker and drive the new query.
      h.finishBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      // Inline drive() because we're under fake timers.
      h.latest().feed("again-x -- 1\n");
      await vi.advanceTimersByTimeAsync(60);
      h.latest().feed("__PI_DONE_1__\n");
      await vi.advanceTimersByTimeAsync(0);
      const items2 = await next;
      expect(items2.map((i) => i.label)).toEqual(["again-x"]);
    });

    it("disables permanently after respawn cap is exceeded", async () => {
      vi.useFakeTimers();
      const h = makeHarness({
        zshCompletionTimeoutMs: 50,
        zshWorker: { ...defaultConfig.zshWorker, maxRespawnsPerMinute: 2 },
      });

      // Trigger 3 timeouts in a row → 3 respawns → exceeds cap of 2.
      for (let i = 0; i < 3; i++) {
        const qp = h.worker.query(`q${i}`);
        await vi.advanceTimersByTimeAsync(0);
        h.finishBootstrap();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(60);
        const items = await qp;
        expect(items).toEqual([]);
      }

      expect(h.worker.isPermanentlyDisabled).toBe(true);

      // Subsequent queries short-circuit to [] without spawning a new pty.
      const spawnsBefore = h.spawnFn.mock.calls.length;
      const items = await h.worker.query("never");
      expect(items).toEqual([]);
      expect(h.spawnFn.mock.calls.length).toBe(spawnsBefore);
    });
  });

  describe("dispose", () => {
    it("kills the pty and drains queued promises", async () => {
      const h = makeHarness();
      const a = h.worker.query("a");
      const b = h.worker.query("b");
      await flush();
      h.finishBootstrap();
      await flush();

      const pty = h.latest();
      h.worker.dispose();

      const [aItems, bItems] = await Promise.all([a, b]);
      expect(aItems).toEqual([]);
      expect(bItems).toEqual([]);
      // node-pty's onExit is fired async via queueMicrotask in our FakePty;
      // dispose() also calls kill() directly so the pty is marked killed.
      expect(pty.killed).toBe(true);
      expect(h.worker.isDisposed).toBe(true);
    });

    it("makes future query() calls resolve to [] without spawning", async () => {
      const h = makeHarness();
      h.worker.dispose();
      const items = await h.worker.query("anything");
      expect(items).toEqual([]);
      expect(h.spawnFn).not.toHaveBeenCalled();
    });

    it("is idempotent", () => {
      const h = makeHarness();
      h.worker.dispose();
      expect(() => h.worker.dispose()).not.toThrow();
    });
  });

  describe("idle timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("kills the pty after idle, then respawns lazily", async () => {
      const h = makeHarness({
        zshWorker: { ...defaultConfig.zshWorker, idleTimeoutMs: 1000 },
      });
      const qp = h.worker.query("a");
      await vi.advanceTimersByTimeAsync(0);
      h.finishBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      // Drive query (under fake timers).
      h.latest().feed("ax -- 1\n");
      await vi.advanceTimersByTimeAsync(60);
      h.latest().feed("__PI_DONE_0__\n");
      await vi.advanceTimersByTimeAsync(0);
      await qp;

      const firstPty = h.latest();
      // Idle past the threshold.
      await vi.advanceTimersByTimeAsync(1100);
      expect(firstPty.killed).toBe(true);

      // Next query lazily spawns a new pty.
      const next = h.worker.query("b");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.spawnFn).toHaveBeenCalledTimes(2);
      h.finishBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      h.latest().feed("bx -- 1\n");
      await vi.advanceTimersByTimeAsync(60);
      h.latest().feed("__PI_DONE_1__\n");
      await vi.advanceTimersByTimeAsync(0);
      const items = await next;
      expect(items.map((i) => i.label)).toEqual(["bx"]);
    });
  });
});
