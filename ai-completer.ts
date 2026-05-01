import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { LruCache } from "./cache";
import type { AiConfig } from "./config";
import type { LlamaCompletion } from "node-llama-cpp";

/** Function that loads and returns a LlamaCompletion instance */
export type ModelLoader = () => Promise<LlamaCompletion | null>;

/**
 * Create the default model loader using node-llama-cpp.
 * Loads starcoder2-3b lazily with global singleton (one model per process).
 */
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
      const piAgentDir = pathModule.resolve(osModule.homedir(), ".pi", "agent");
      const resolvedPath = pathModule.resolve(piAgentDir, config.modelPath);

      const model = await llama.loadModel({ modelPath: resolvedPath });
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
 * AI-powered ghost text completion using a local FIM model.
 *
 * Manages model lifecycle via injected ModelLoader,
 * debounced inference, and LRU caching of results.
 */
export class AiCompleter {
  private cache = new LruCache<string, string>(200, 50);
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<string, boolean>();

  constructor(
    private config: AiConfig,
    private modelLoader: ModelLoader = createModelLoader(config),
  ) {}

  /** Whether AI ghost text is enabled */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Predict the completion for a given shell token.
   * Debounced — only the last call within the debounce window triggers inference.
   */
  predict(
    token: string,
    contextItems: AutocompleteItem[],
  ): Promise<string | null> {
    if (!this.config.enabled) return Promise.resolve(null);

    const cached = this.cache.get(token);
    if (cached !== undefined) return Promise.resolve(cached);

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    return new Promise((resolve) => {
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null;

        // Re-check cache after debounce (might have been populated by concurrent load)
        const freshCached = this.cache.get(token);
        if (freshCached !== undefined) { resolve(freshCached); return; }

        if (this.pending.has(token)) { resolve(null); return; }
        this.pending.set(token, true);

        try {
          const completion = await this.modelLoader();
          if (!completion) { resolve(null); return; }

          const cmds = contextItems
            .slice(0, 8)
            .map((i) => i.value)
            .join(", ");
          const fimPrefix = `# available: ${cmds}\n${token}`;

          const result = await completion.generateInfillCompletion(
            fimPrefix,
            "",
            { maxTokens: this.config.maxTokens, temperature: 0 },
          );

          const cleaned = result.split(/[\n\r]/)[0]?.trim() ?? "";
          if (cleaned.length > 0 && cleaned.length < 100) {
            this.cache.set(token, cleaned);
            resolve(cleaned);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        } finally {
          this.pending.delete(token);
        }
      }, this.config.debounceMs);
    });
  }
}
