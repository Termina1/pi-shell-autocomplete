import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@mariozechner/pi-tui";
import type { ShellAutocompleteConfig } from "./config";
import type { ZshCompleter } from "./zsh-completer";
import type { AiCompleter } from "./ai-completer";
import { extractShellToken } from "./prefix";

export function createShellAutocompleteProvider(
  current: AutocompleteProvider,
  zshCompleter: ZshCompleter,
  aiCompleter: AiCompleter,
  config: ShellAutocompleteConfig,
  onAiResult?: (token: string, completion: string) => void,
): AutocompleteProvider {
  let latestToken: string | undefined;

  return {
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const token = extractShellToken(currentLine.slice(0, cursorCol), config.triggerChar);

      if (token === undefined || token.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      latestToken = token;
      if (options.signal.aborted) return null;

      let shellItems: AutocompleteItem[];
      if (token.includes(" ")) {
        const completions = await zshCompleter.getCompletions(token);
        if (token !== latestToken) return null;
        shellItems = completions.map((c) => ({ value: c.value, label: c.label }));
      } else {
        const commands = await zshCompleter.getCommands();
        if (token !== latestToken) return null;
        shellItems = scoreAndRank(token, commands, config.maxDropdownItems);
      }

      if (options.signal.aborted) return null;

      const defaultSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (token !== latestToken) return null;
      const defaultItems = defaultSuggestions?.items ?? [];

      const allItems = [...shellItems];
      const seen = new Set(shellItems.map((i) => i.value));
      for (const di of defaultItems) { if (!seen.has(di.value)) { allItems.push(di); seen.add(di.value); } }

      if (aiCompleter.enabled) {
        aiCompleter.predict(token, allItems, (t, r) => onAiResult?.(t, r));
      }

      return shellItems.length === 0 ? defaultSuggestions : { items: shellItems, prefix: token };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const currentLine = lines[cursorLine] ?? "";
      if (extractShellToken(currentLine.slice(0, cursorCol), config.triggerChar)) return false;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export function scoreAndRank(query: string, items: string[], limit: number): AutocompleteItem[] {
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
