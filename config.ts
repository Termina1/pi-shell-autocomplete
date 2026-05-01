/**
 * Configuration for the shell-autocomplete extension.
 * All fields have sensible defaults — no configuration required to start.
 */
export interface ShellAutocompleteConfig {
  /** Character that triggers shell autocomplete (default: "!") */
  triggerChar: string;

  /** Maximum items shown in the autocomplete dropdown */
  maxDropdownItems: number;

  /** Timeout for zsh completion queries in ms */
  zshCompletionTimeoutMs: number;

  /** TTL for cached shell command list in ms */
  commandsCacheTtlMs: number;

  /** TTL for cached positional completions in ms */
  positionalCacheTtlMs: number;

  /** AI ghost text settings */
  ai: AiConfig;

  /** Ghost text rendering settings */
  ghost: GhostConfig;
}

export interface AiConfig {
  /** Whether AI ghost text is enabled */
  enabled: boolean;

  /** Path to the GGUF model file (relative to extension directory) */
  modelPath: string;

  /** Debounce delay before triggering AI inference in ms */
  debounceMs: number;

  /** Maximum tokens for AI completion */
  maxTokens: number;

  /** Context size for the llama model */
  contextSize: number;
}

export interface GhostConfig {
  /** ANSI escape code for ghost text color (default: gray) */
  color: string;
}

/**
 * Default configuration used when no overrides are provided.
 */
/**
 * Create a resolved config by merging user overrides with defaults.
 * Deep-merges nested objects (ai, ghost).
 */
export function createConfig(
  overrides?: Partial<ShellAutocompleteConfig> & {
    ai?: Partial<AiConfig>;
    ghost?: Partial<GhostConfig>;
  },
): ShellAutocompleteConfig {
  if (!overrides) return { ...defaultConfig, ai: { ...defaultConfig.ai }, ghost: { ...defaultConfig.ghost } };

  return {
    triggerChar: overrides.triggerChar ?? defaultConfig.triggerChar,
    maxDropdownItems: overrides.maxDropdownItems ?? defaultConfig.maxDropdownItems,
    zshCompletionTimeoutMs: overrides.zshCompletionTimeoutMs ?? defaultConfig.zshCompletionTimeoutMs,
    commandsCacheTtlMs: overrides.commandsCacheTtlMs ?? defaultConfig.commandsCacheTtlMs,
    positionalCacheTtlMs: overrides.positionalCacheTtlMs ?? defaultConfig.positionalCacheTtlMs,
    ai: {
      enabled: overrides.ai?.enabled ?? defaultConfig.ai.enabled,
      modelPath: overrides.ai?.modelPath ?? defaultConfig.ai.modelPath,
      debounceMs: overrides.ai?.debounceMs ?? defaultConfig.ai.debounceMs,
      maxTokens: overrides.ai?.maxTokens ?? defaultConfig.ai.maxTokens,
      contextSize: overrides.ai?.contextSize ?? defaultConfig.ai.contextSize,
    },
    ghost: {
      color: overrides.ghost?.color ?? defaultConfig.ghost.color,
    },
  };
}

export const defaultConfig: ShellAutocompleteConfig = {
  triggerChar: "!",
  maxDropdownItems: 15,
  zshCompletionTimeoutMs: 3000,
  commandsCacheTtlMs: 30000,
  positionalCacheTtlMs: 15000,
  ai: {
    enabled: true,
    modelPath: "models/starcoder2-3b-Q4_K_M.gguf",
    debounceMs: 400,
    maxTokens: 40,
    contextSize: 2048,
  },
  ghost: {
    color: "\x1b[38;5;244m",
  },
};
