/**
 * Real-zsh latency benchmark for `ZshWorker`.
 *
 * Skipped in CI (no real /bin/zsh, slow test). Run locally with:
 *
 *     CI= npx vitest run __tests__/integration/zsh-worker.bench.test.ts
 *
 * Or set `RUN_ZSH_BENCH=1` to force-run anywhere.
 *
 * The benchmark measures cache-miss latency for varied tokens so each query
 * is a fresh round-trip to the worker (the in-memory token cache in
 * `ZshCompleter` is bypassed by going through `ZshWorker` directly).
 *
 * Latency budget per `openspec/specs/zsh-native-completion/spec.md`
 * after worker warmup:
 *   - p50 ≤ 250 ms
 *   - p95 ≤ 800 ms
 */

import { existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { defaultConfig } from "../../config";
import { ZshWorker } from "../../zsh-worker";

const ZSH_PRESENT = existsSync("/bin/zsh");
const FORCE = process.env.RUN_ZSH_BENCH === "1";
const SHOULD_RUN = FORCE || (ZSH_PRESENT && !process.env.CI);

const describeBench = SHOULD_RUN ? describe : describe.skip;

describeBench("ZshWorker latency benchmark (real /bin/zsh)", () => {
  it(
    "p50 ≤ 250ms / p95 ≤ 800ms over 50 warm cache-miss queries",
    async () => {
      const worker = new ZshWorker({
        ...defaultConfig,
        zshWorker: {
          ...defaultConfig.zshWorker,
          // Use a dedicated dump so concurrent test runs don't fight.
          compinitDumpPath: "/tmp/zcompdump-pi-bench",
        },
      });

      try {
        await worker.prewarm();

        // Warm each completion function once (first invocation triggers
        // `autoload _<cmd>` which is slow); the spec's latency budget is
        // explicitly post-warmup.
        const warmupTokens = ["git c", "docker r", "git co", "kubectl g", "npm i", "ssh "];
        for (const t of warmupTokens) {
          await worker.query(t);
        }

        // Generate 50 unique-ish tokens that are cache misses but reuse the
        // already-warm completion functions.
        const baseTokens = ["git c", "git co", "git che", "git cl", "docker r", "git b", "git d"];
        const tokens: string[] = [];
        for (let i = 0; i < 50; i++) {
          tokens.push(baseTokens[i % baseTokens.length]!);
        }

        const samples: number[] = [];
        for (const tok of tokens) {
          const t0 = Date.now();
          await worker.query(tok);
          samples.push(Date.now() - t0);
        }

        samples.sort((a, b) => a - b);
        const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!;
        const p50 = p(0.5);
        const p95 = p(0.95);
        const min = samples[0]!;
        const max = samples[samples.length - 1]!;
        // eslint-disable-next-line no-console
        console.log(
          `[zsh-worker bench] n=${samples.length} min=${min}ms p50=${p50}ms p95=${p95}ms max=${max}ms`,
        );

        expect(p50).toBeLessThanOrEqual(250);
        expect(p95).toBeLessThanOrEqual(800);
      } finally {
        worker.dispose();
      }
    },
    60_000,
  );
});
