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

export class AiCompleter {
  private cache = new LruCache<string, string>(200, 50);
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
        fileCtx: string[],
        histCtx: string[],
      ) => {
        try {
          const completion = await this.modelLoader();
          if (!completion) return;

          const prompt = buildPrompt(token, items, fileCtx, histCtx);
          const result = await completion.generateInfillCompletion(
            prompt.prefix,
            prompt.suffix,
            { maxTokens: this.config.maxTokens, temperature: 0 },
          );

          const cleaned = result.split(/[\n\r]/)[0]?.trim().split(/[,\s]+/)[0] ?? "";
          if (cleaned.length > 0 && cleaned.length < 100) {
            const cacheKey = makeCacheKey(token, fileCtx, histCtx);
            this.cache.set(cacheKey, cleaned);
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
    // Collect context first for cache key and prompt
    let fileCtx: string[] = [];
    let histCtx: string[] = [];
    try {
      [fileCtx, histCtx] = await Promise.all([
        this.config.fileContext.enabled
          ? this.contextCollector.getFileContext() : Promise.resolve([]),
        this.config.historyContext.enabled
          ? this.contextCollector.getHistoryContext() : Promise.resolve([]),
      ]);
    } catch {
      // Context collection failed — proceed with empty context
    }

    const cacheKey = makeCacheKey(token, fileCtx, histCtx);
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      onResult(token, cached);
      return;
    }

    this.doPredict(token, items, onResult, fileCtx, histCtx);
  }
}

/**
 * Build a structured prompt for fill-in-the-middle completion.
 * Returns { prefix, suffix } where prefix is the context and token.
 */
export function buildPrompt(
  token: string,
  items: AutocompleteItem[],
  fileCtx: string[],
  histCtx: string[],
): { prefix: string; suffix: string } {
  const parts: string[] = [];

  // Section 1: available commands from compinit
  if (items.length > 0) {
    const cmds = items.slice(0, 8).map((i) => i.value).join(", ");
    parts.push(`# Choose one option and complete it naturally with arguments: ${cmds}`);
  }

  // Section 2: recent command history (optional)
  if (histCtx.length > 0) {
    parts.push("# Recent commands:");
    for (const cmd of histCtx) {
      parts.push(`#   ${cmd}`);
    }
  }

  // Section 3: files in current directory (optional)
  if (fileCtx.length > 0) {
    parts.push("# Files in directory:");
    for (const f of fileCtx) {
      parts.push(`#   ${f}`);
    }
  }

  parts.push(token);

  return { prefix: parts.join("\n"), suffix: "" };
}

/**
 * Create a cache key that includes context to avoid stale results
 * when directory contents or history change.
 */
export function makeCacheKey(token: string, fileCtx: string[], histCtx: string[]): string {
  // Use a fast hash of context to keep keys reasonable
  const ctxParts: string[] = [];
  if (fileCtx.length > 0) {
    ctxParts.push(...fileCtx);
  }
  if (histCtx.length > 0) {
    ctxParts.push(histCtx[histCtx.length - 1]!); // last entry is sufficient signal
  }

  if (ctxParts.length === 0) {
    return token;
  }

  const hash = createHash("sha256").update(ctxParts.join("\n")).digest("hex").slice(0, 12);
  return `${token}|${hash}`;
}

/** No-op context collector for backward compatibility. */
function createNoopCollector(): ContextCollector {
  return {
    getFileContext: () => Promise.resolve([]),
    getHistoryContext: () => Promise.resolve([]),
  };
}
