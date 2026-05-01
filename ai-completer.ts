import type { AutocompleteItem } from "@mariozechner/pi-tui";
import debounce from "lodash.debounce";
import { LruCache } from "./cache";
import type { AiConfig } from "./config";
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

export class AiCompleter {
  private cache = new LruCache<string, string>(200, 50);
  private doPredict: ReturnType<typeof debounce>;

  constructor(
    private config: AiConfig,
    private modelLoader: ModelLoader = createModelLoader(config),
  ) {
    this.doPredict = debounce(
      async (token: string, items: AutocompleteItem[], onResult: GhostCallback) => {
        try {
          const completion = await this.modelLoader();
          if (!completion) return;

          const cmds = items.slice(0, 8).map((i) => i.value).join(", ");
          const result = await completion.generateInfillCompletion(
            `# Choose one option and complete it naturally with arguments: ${cmds}\n${token}`,
            "",
            { maxTokens: this.config.maxTokens, temperature: 0 },
          );

          const cleaned = result.split(/[\n\r]/)[0]?.trim().split(/[,\s]+/)[0] ?? "";
          if (cleaned.length > 0 && cleaned.length < 100) {
            this.cache.set(token, cleaned);
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
    const cached = this.cache.get(token);
    if (cached !== undefined) { onResult(token, cached); return; }
    this.doPredict(token, items, onResult);
  }
}
