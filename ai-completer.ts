import type { AutocompleteItem } from "@mariozechner/pi-tui";
import debounce from "lodash.debounce";
import { createHash } from "node:crypto";
import { LruCache } from "./cache";
import type { AiConfig } from "./config";
import type { ContextCollector } from "./context-collector";
import type { LlamaCompletion } from "node-llama-cpp";

export type ModelLoader = () => Promise<LlamaCompletion | null>;
export type GhostCallback = (token: string, completion: string) => void;

export function createModelLoader(config: AiConfig): ModelLoader {
  let completion: LlamaCompletion | null = null;
  let loading = false;
  let loadError = false;

  return async (): Promise<LlamaCompletion | null> => {
    if (completion) return completion;
    if (loadError || loading) return null;
    loading = true;
    try {
      const { getLlama, LlamaCompletion: LC } = await import("node-llama-cpp");
      const llama = await getLlama({ logLevel: "error" });
      const pathModule = await import("path");
      const osModule = await import("os");
      const fsModule = await import("node:fs");
      const piAgentDir = pathModule.resolve(osModule.homedir(), ".pi", "agent");

      const modelPath = resolveModelPath(
        config, piAgentDir, pathModule, fsModule,
      );
      if (!modelPath) {
        loadError = true;
        return null;
      }

      const model = await llama.loadModel({ modelPath });
      const context = await model.createContext({ contextSize: config.contextSize });
      completion = new LC({ contextSequence: context.getSequence() });
      return completion;
    } catch {
      loadError = true;
      return null;
    } finally {
      loading = false;
    }
  };
}

/**
 * Resolve the best available model path from the priority list.
 * Returns null if no model file exists.
 */
export function resolveModelPath(
  config: AiConfig,
  piAgentDir: string,
  pathModule: { resolve(...paths: string[]): string; isAbsolute(path: string): boolean },
  fsModule: { existsSync(path: string): boolean },
): string | null {
  // Build the list of candidates: modelPriority first, then modelPath as fallback
  const candidates: string[] = [];
  if (config.modelPriority && config.modelPriority.length > 0) {
    candidates.push(...config.modelPriority);
  }
  // Always include modelPath as last-resort fallback (dedup)
  if (!candidates.includes(config.modelPath)) {
    candidates.push(config.modelPath);
  }

  for (const candidate of candidates) {
    const resolved = pathModule.isAbsolute(candidate)
      ? candidate
      : pathModule.resolve(piAgentDir, candidate);
    if (fsModule.existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}

/**
 * Context data collected from all sources for a single prediction.
 */
export interface PredictionContext {
  items: AutocompleteItem[];
  fileCtx: string[];
  histCtx: string[];
  gitCtx: string | null;
  projectCtx: string | null;
  conversationCtx: string | null;
}

export class AiCompleter {
  private cache = new LruCache<string, string>(200, 50);
  // Fast cache: token → result with short expiry for instant keystroke repeats
  private fastCache = new Map<string, { result: string; at: number }>();
  private fastCacheTtlMs = 3000; // 3 seconds — covers rapid typing of same token
  private doPredict: ReturnType<typeof debounce>;
  private contextCollector: ContextCollector;

  constructor(
    private config: AiConfig,
    private modelLoader: ModelLoader = createModelLoader(config),
    contextCollector?: ContextCollector,
  ) {
    this.contextCollector = contextCollector ?? createNoopCollector();
    this.doPredict = debounce(
      async (
        token: string,
        items: AutocompleteItem[],
        onResult: GhostCallback,
      ) => {
        try {
          // Collect all context sources in parallel (once per debounce window)
          const results = await Promise.allSettled([
            this.config.fileContext.enabled
              ? this.contextCollector.getFileContext() : Promise.resolve([]),
            this.config.historyContext.enabled
              ? this.contextCollector.getHistoryContext() : Promise.resolve([]),
            this.config.gitContext.enabled
              ? this.contextCollector.getGitContext() : Promise.resolve(null),
            this.config.projectContext.enabled
              ? this.contextCollector.getProjectContext() : Promise.resolve(null),
            this.config.conversationContext.enabled
              ? this.contextCollector.getConversationContext() : Promise.resolve(null),
          ]);

          const ctx: PredictionContext = {
            items,
            fileCtx: unwrapSettled(results[0]!, []),
            histCtx: unwrapSettled(results[1]!, []),
            gitCtx: unwrapSettled(results[2]!, null),
            projectCtx: unwrapSettled(results[3]!, null),
            conversationCtx: unwrapSettled(results[4]!, null),
          };

          // Check full cache (context-aware key) before running inference
          const cacheKey = makeCacheKey(token, ctx);
          const cached = this.cache.get(cacheKey);
          if (cached !== undefined) {
            // Populate fast cache so next keystroke hits instantly
            this.fastCache.set(token, { result: cached, at: Date.now() });
            onResult(token, cached);
            return;
          }

          const completion = await this.modelLoader();
          if (!completion) return;

          const prompt = buildPrompt(token, ctx);
          const result = await completion.generateInfillCompletion(
            prompt.prefix,
            prompt.suffix,
            {
              maxTokens: this.config.maxTokens,
              temperature: this.config.temperature,
            },
          );

          // First non-empty line (model often starts output with \n)
          const lines = result.split(/[\n\r]/).map((l: string) => l.trim()).filter(Boolean);
          const cleaned = (lines[0] ?? "").split(/[,\s]+/)[0] ?? "";
          if (cleaned.length > 0 && cleaned.length < 100) {
            this.cache.set(cacheKey, cleaned);
            this.fastCache.set(token, { result: cleaned, at: Date.now() });
            onResult(token, cleaned);
          }
        } catch {}
      },
      this.config.debounceMs,
      { leading: false, trailing: true },
    );
  }

  get enabled(): boolean { return this.config.enabled; }
  getCached(token: string): string | undefined { return this.cache.get(token); }

  predict(token: string, items: AutocompleteItem[], onResult: GhostCallback): void {
    if (!this.config.enabled) return;
    // Fire-and-forget async prediction
    this.predictAsync(token, items, onResult);
  }

  private async predictAsync(
    token: string,
    items: AutocompleteItem[],
    onResult: GhostCallback,
  ): Promise<void> {
    // Fast cache: return instantly for repeated tokens (common during typing).
    // Expires after 3s — long enough for rapid keystrokes, short enough to
    // not serve stale results when context changes between commands.
    const fastEntry = this.fastCache.get(token);
    if (fastEntry && Date.now() - fastEntry.at < this.fastCacheTtlMs) {
      onResult(token, fastEntry.result);
      return;
    }

    // Cache miss: delegate to debounced function which collects context + infers.
    // Context collection happens once per debounce window, not on every keystroke.
    this.doPredict(token, items, onResult);
  }
}

/**
 * Unwrap a PromiseSettledResult, returning a default on rejection.
 */
function unwrapSettled<T>(result: PromiseSettledResult<T>, defaultValue: T): T {
  return result.status === "fulfilled" ? result.value : defaultValue;
}

// ── Prompt Building ──────────────────────────────────────

/**
 * Build a compact prompt for fill-in-the-middle completion.
 *
 * Section markers use [...] so the model can distinguish context from the
 * actual command at the end. Lines are kept short (<80 chars) for token efficiency.
 */
export function buildPrompt(
  token: string,
  ctx: PredictionContext,
): { prefix: string; suffix: string } {
  const lines: string[] = [];

  // Header
  lines.push("# shell autocomplete");

  // Context sections — each on one compact line
  if (ctx.gitCtx) lines.push(`[git] ${ctx.gitCtx}`);
  if (ctx.projectCtx) lines.push(`[project] ${ctx.projectCtx}`);
  if (ctx.conversationCtx) {
    const flat = ctx.conversationCtx.replace(/\n/g, " | ");
    lines.push(`[chat] ${flat}`);
  }
  if (ctx.histCtx.length > 0) {
    lines.push(`[recent] ${ctx.histCtx.slice(-5).join(", ")}`);
  }
  if (ctx.fileCtx.length > 0) {
    lines.push(`[dir] ${ctx.fileCtx.slice(0, 10).join("  ")}`);
  }
  if (ctx.items.length > 0) {
    const names = ctx.items.slice(0, 10).map((i) => i.value).join(", ");
    lines.push(`[cmds] ${names}`);
  }

  // Separator + token — model completes from here
  lines.push("");
  lines.push(token);

  return { prefix: lines.join("\n"), suffix: "" };
}

// ── Cache Key ────────────────────────────────────────────

/**
 * Create a cache key that includes context to avoid stale results
 * when directory contents, history, git status, or conversation change.
 */
export function makeCacheKey(token: string, ctx: PredictionContext): string {
  const ctxParts: string[] = [];

  if (ctx.fileCtx.length > 0) {
    ctxParts.push(...ctx.fileCtx);
  }
  if (ctx.histCtx.length > 0) {
    ctxParts.push(ctx.histCtx[ctx.histCtx.length - 1]!); // last entry is sufficient signal
  }
  if (ctx.gitCtx) {
    ctxParts.push(ctx.gitCtx);
  }
  if (ctx.conversationCtx) {
    ctxParts.push(ctx.conversationCtx);
  }

  if (ctxParts.length === 0) {
    return token;
  }

  const hash = createHash("sha256").update(ctxParts.join("\n")).digest("hex").slice(0, 12);
  return `${token}|${hash}`;
}

// ── No-op Collector ──────────────────────────────────────

/** No-op context collector for backward compatibility. */
function createNoopCollector(): ContextCollector {
  return {
    getFileContext: () => Promise.resolve([]),
    getHistoryContext: () => Promise.resolve([]),
    getGitContext: () => Promise.resolve(null),
    getProjectContext: () => Promise.resolve(null),
    getConversationContext: () => Promise.resolve(null),
  };
}
