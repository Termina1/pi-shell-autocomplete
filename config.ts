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

  /** Persistent zsh worker settings (positional completion path) */
  zshWorker: ZshWorkerConfig;

  /** AI ghost text settings */
  ai: AiConfig;

  /** Ghost text rendering settings */
  ghost: GhostConfig;
}

/**
 * Settings for the persistent zsh worker that serves positional completions.
 */
export interface ZshWorkerConfig {
  /**
   * When false, positional completions return empty (no zsh worker spawned).
   * Default: true.
   */
  enabled: boolean;

  /**
   * Start the worker in the background as soon as the completer is constructed,
   * so the first user query doesn't pay the bootstrap cost. Default: true.
   */
  prewarm: boolean;

  /**
   * Idle shutdown timeout in ms. When > 0, the worker is disposed after this much
   * idle time and re-spawned lazily on the next query. 0 = never. Default: 0.
   */
  idleTimeoutMs: number;

  /**
   * Path passed to `compinit -d <path>` inside the worker so the compdump is
   * cached across editor restarts and isolated from the user's own ~/.zcompdump.
   * Tilde expansion is performed at use-time. Default:
   * `~/.cache/pi-shell-autocomplete/zcompdump`.
   */
  compinitDumpPath: string;

  /**
   * If true, start the worker as `zsh -i` and source the user's rc files.
   * Slower startup but picks up user-defined functions/aliases for completion.
   * Default: false (use minimal `zsh -f`).
   */
  sourceRcFile: boolean;

  /**
   * After this many automatic respawns within a 60s window, the worker is
   * marked unavailable for the rest of the session and `query()` short-circuits
   * to []. Default: 3.
   */
  maxRespawnsPerMinute: number;
}

export interface AiConfig {
  /** Whether AI ghost text is enabled */
  enabled: boolean;

  /** Path to the GGUF model file (relative to extension directory). Deprecated: use modelPriority. */
  modelPath: string;

  /** Priority-ordered list of GGUF model paths. First existing file is used. Falls back to modelPath if empty. */
  modelPriority: string[];

  /** Debounce delay before triggering AI inference in ms */
  debounceMs: number;

  /** Maximum tokens for AI completion */
  maxTokens: number;

  /** Context size for the llama model */
  contextSize: number;

  /** Temperature for model inference (default: 0.3) */
  temperature: number;

  /** File system context settings */
  fileContext: FileContextConfig;

  /** Command history context settings */
  historyContext: HistoryContextConfig;

  /** Git context settings */
  gitContext: GitContextConfig;

  /** Project context settings */
  projectContext: ProjectContextConfig;

  /** Conversation context settings */
  conversationContext: ConversationContextConfig;
}

export interface FileContextConfig {
  /** Whether to include directory file listing in AI prompt */
  enabled: boolean;

  /** Maximum number of file/directory entries to include */
  maxFiles: number;
}

export interface HistoryContextConfig {
  /** Whether to include recent shell commands in AI prompt */
  enabled: boolean;

  /** Maximum number of history entries to include */
  maxEntries: number;

  /** Path to the zsh history file */
  historyPath: string;
}

export interface GitContextConfig {
  /** Whether to include git state in AI prompt (default: true) */
  enabled: boolean;

  /** Maximum number of status lines from git status --short (default: 15) */
  maxStatusLines: number;

  /** Cache TTL in milliseconds (default: 10000) */
  cacheTtlMs: number;
}

export interface ProjectContextConfig {
  /** Whether to include project type detection in AI prompt (default: true) */
  enabled: boolean;

  /** Cache TTL in milliseconds (default: 60000) */
  cacheTtlMs: number;
}

export interface ConversationContextConfig {
  /** Whether to include conversation context in AI prompt (default: true) */
  enabled: boolean;

  /** Maximum total characters for user + assistant messages (default: 500) */
  maxChars: number;

  /** Cache TTL in milliseconds (default: 5000) */
  cacheTtlMs: number;
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
    ai?: Partial<AiConfig> & {
      fileContext?: Partial<FileContextConfig>;
      historyContext?: Partial<HistoryContextConfig>;
      gitContext?: Partial<GitContextConfig>;
      projectContext?: Partial<ProjectContextConfig>;
      conversationContext?: Partial<ConversationContextConfig>;
    };
    ghost?: Partial<GhostConfig>;
    zshWorker?: Partial<ZshWorkerConfig>;
  },
): ShellAutocompleteConfig {
  if (!overrides) return {
    ...defaultConfig,
    zshWorker: { ...defaultConfig.zshWorker },
    ai: {
      ...defaultConfig.ai,
      fileContext: { ...defaultConfig.ai.fileContext },
      historyContext: { ...defaultConfig.ai.historyContext },
      gitContext: { ...defaultConfig.ai.gitContext },
      projectContext: { ...defaultConfig.ai.projectContext },
      conversationContext: { ...defaultConfig.ai.conversationContext },
    },
    ghost: { ...defaultConfig.ghost },
  };

  return {
    triggerChar: overrides.triggerChar ?? defaultConfig.triggerChar,
    maxDropdownItems: overrides.maxDropdownItems ?? defaultConfig.maxDropdownItems,
    zshCompletionTimeoutMs: overrides.zshCompletionTimeoutMs ?? defaultConfig.zshCompletionTimeoutMs,
    commandsCacheTtlMs: overrides.commandsCacheTtlMs ?? defaultConfig.commandsCacheTtlMs,
    positionalCacheTtlMs: overrides.positionalCacheTtlMs ?? defaultConfig.positionalCacheTtlMs,
    zshWorker: {
      enabled: overrides.zshWorker?.enabled ?? defaultConfig.zshWorker.enabled,
      prewarm: overrides.zshWorker?.prewarm ?? defaultConfig.zshWorker.prewarm,
      idleTimeoutMs: overrides.zshWorker?.idleTimeoutMs ?? defaultConfig.zshWorker.idleTimeoutMs,
      compinitDumpPath: overrides.zshWorker?.compinitDumpPath ?? defaultConfig.zshWorker.compinitDumpPath,
      sourceRcFile: overrides.zshWorker?.sourceRcFile ?? defaultConfig.zshWorker.sourceRcFile,
      maxRespawnsPerMinute: overrides.zshWorker?.maxRespawnsPerMinute ?? defaultConfig.zshWorker.maxRespawnsPerMinute,
    },
    ai: {
      enabled: overrides.ai?.enabled ?? defaultConfig.ai.enabled,
      modelPath: overrides.ai?.modelPath ?? defaultConfig.ai.modelPath,
      modelPriority: overrides.ai?.modelPriority ?? defaultConfig.ai.modelPriority,
      debounceMs: overrides.ai?.debounceMs ?? defaultConfig.ai.debounceMs,
      maxTokens: overrides.ai?.maxTokens ?? defaultConfig.ai.maxTokens,
      contextSize: overrides.ai?.contextSize ?? defaultConfig.ai.contextSize,
      temperature: overrides.ai?.temperature ?? defaultConfig.ai.temperature,
      fileContext: {
        enabled: overrides.ai?.fileContext?.enabled ?? defaultConfig.ai.fileContext.enabled,
        maxFiles: overrides.ai?.fileContext?.maxFiles ?? defaultConfig.ai.fileContext.maxFiles,
      },
      historyContext: {
        enabled: overrides.ai?.historyContext?.enabled ?? defaultConfig.ai.historyContext.enabled,
        maxEntries: overrides.ai?.historyContext?.maxEntries ?? defaultConfig.ai.historyContext.maxEntries,
        historyPath: overrides.ai?.historyContext?.historyPath ?? defaultConfig.ai.historyContext.historyPath,
      },
      gitContext: {
        enabled: overrides.ai?.gitContext?.enabled ?? defaultConfig.ai.gitContext.enabled,
        maxStatusLines: overrides.ai?.gitContext?.maxStatusLines ?? defaultConfig.ai.gitContext.maxStatusLines,
        cacheTtlMs: overrides.ai?.gitContext?.cacheTtlMs ?? defaultConfig.ai.gitContext.cacheTtlMs,
      },
      projectContext: {
        enabled: overrides.ai?.projectContext?.enabled ?? defaultConfig.ai.projectContext.enabled,
        cacheTtlMs: overrides.ai?.projectContext?.cacheTtlMs ?? defaultConfig.ai.projectContext.cacheTtlMs,
      },
      conversationContext: {
        enabled: overrides.ai?.conversationContext?.enabled ?? defaultConfig.ai.conversationContext.enabled,
        maxChars: overrides.ai?.conversationContext?.maxChars ?? defaultConfig.ai.conversationContext.maxChars,
        cacheTtlMs: overrides.ai?.conversationContext?.cacheTtlMs ?? defaultConfig.ai.conversationContext.cacheTtlMs,
      },
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
  zshWorker: {
    enabled: true,
    prewarm: true,
    idleTimeoutMs: 0,
    compinitDumpPath: "~/.cache/pi-shell-autocomplete/zcompdump",
    sourceRcFile: false,
    maxRespawnsPerMinute: 3,
  },
  ai: {
    enabled: true,
    modelPath: "models/starcoder2-3b-Q4_K_M.gguf",
    modelPriority: [
      "models/qwen2.5-coder-3b-instruct-Q4_K_M.gguf",
      "models/qwen2.5-coder-1.5b-instruct-Q4_K_M.gguf",
      "models/starcoder2-3b-Q4_K_M.gguf",
      "models/deepseek-coder-1.3b-instruct-Q4_K_M.gguf",
    ],
    debounceMs: 100,
    maxTokens: 40,
    contextSize: 2048,
    temperature: 0.3,
    fileContext: {
      enabled: true,
      maxFiles: 20,
    },
    historyContext: {
      enabled: true,
      maxEntries: 10,
      historyPath: "~/.zsh_history",
    },
    gitContext: {
      enabled: true,
      maxStatusLines: 15,
      cacheTtlMs: 10000,
    },
    projectContext: {
      enabled: true,
      cacheTtlMs: 60000,
    },
    conversationContext: {
      enabled: true,
      maxChars: 500,
      cacheTtlMs: 5000,
    },
  },
  ghost: {
    color: "\x1b[38;5;244m",
  },
};
