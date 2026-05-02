import { describe, it, expect } from "vitest";
import { AiCompleter, createModelLoader } from "../../ai-completer";
import { defaultConfig } from "../../config";
import fs from "fs";
import path from "path";

const MODEL_PATH = path.resolve(process.env.HOME ?? "/tmp", ".pi", "agent", "models", "starcoder2-3b-Q4_K_M.gguf");
const modelExists = fs.existsSync(MODEL_PATH);

describe("AiCompleter with real model", () => {
  (modelExists ? it : it.skip)("predict calls onResult with completion", async () => {
    const ai = new AiCompleter(
      { ...defaultConfig.ai, modelPath: "models/starcoder2-3b-Q4_K_M.gguf", debounceMs: 100 },
      createModelLoader({ ...defaultConfig.ai, modelPath: "models/starcoder2-3b-Q4_K_M.gguf" }),
    );

    const result = await new Promise<string | null>(resolve => {
      ai.predict("git c", [{ value: "git", label: "git" }], (_, r) => resolve(r));
    });

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    expect(result!.length).toBeLessThan(100);
  }, 120000);
});
