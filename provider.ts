import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@mariozechner/pi-tui";
import type { ShellAutocompleteConfig } from "./config";
import type { ZshCompleter } from "./zsh-completer";
import type { AiCompleter } from "./ai-completer";
import { extractShellToken } from "./prefix";

/**
 * Create an autocomplete provider that wraps zsh completions for `!`-prefixed input.
 * Delegates non-`!` input to the default Pi provider.
 */
export function createShellAutocompleteProvider(
  current: AutocompleteProvider,
  zshCompleter: ZshCompleter,
  aiCompleter: AiCompleter,
  config: ShellAutocompleteConfig,
  onAiResult?: (token: string, completion: string) => void,
): AutocompleteProvider {
  const aiPending = new Map<string, boolean>();


  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const token = extractShellToken(
        currentLine.slice(0, cursorCol),
        config.triggerChar,
      );

      // Not a shell prefix — delegate to default provider
      if (token === undefined || token.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (options.signal.aborted) return null;

      // Get zsh completions (positional or command list)
      let shellItems: AutocompleteItem[];
      if (token.includes(" ")) {
        const completions = await zshCompleter.getCompletions(token);
        shellItems = completions.map((c) => ({ value: c.value, label: c.label }));
      } else {
        const commands = await zshCompleter.getCommands();
        shellItems = scoreAndRank(token, commands, config.maxDropdownItems);
      }

      if (options.signal.aborted) return null;

      // Also get default completions (e.g., file paths)
      const defaultSuggestions = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      );
      const defaultItems = defaultSuggestions?.items ?? [];

      // Merge and deduplicate
      const allItems = [...shellItems];
      const seen = new Set(shellItems.map((i) => i.value));
      for (const di of defaultItems) {
        if (!seen.has(di.value)) {
          allItems.push(di);
          seen.add(di.value);
        }
      }

      // Fire-and-forget AI completion for ghost text
      if (aiCompleter.enabled) {
        aiPending.clear(); // clear stale entries from cancelled debounce
        aiPending.set(token, true);
        aiCompleter.predict(token, allItems).then((result) => {
          aiPending.delete(token);
          if (result) {
            onAiResult?.(token, result);
          }
        });
      }

      if (shellItems.length === 0) {
        return defaultSuggestions;
      }

      return { items: shellItems, prefix: token };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const currentLine = lines[cursorLine] ?? "";
      if (extractShellToken(currentLine.slice(0, cursorCol), config.triggerChar)) {
        return false;
      }
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/**
 * Score and rank items by fuzzy match against query.
 * Prefix match > substring match > length penalty.
 */
export function scoreAndRank(
  query: string,
  items: string[],
  limit: number,
): AutocompleteItem[] {
  const lowerQuery = query.toLowerCase();
  const unique = [...new Set(items)];

  const scored = unique
    .map((item) => {
      const lowerItem = item.toLowerCase();
      let score = 0;
      if (lowerItem.startsWith(lowerQuery)) score += 100;
      else if (lowerItem.includes(lowerQuery)) score += 50;
      score -= item.length * 0.1;
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => ({ value: s.item, label: s.item }));
}
