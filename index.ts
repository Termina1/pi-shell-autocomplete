import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createConfig } from "./config";
import { ZshCompleter } from "./zsh-completer";
import { AiCompleter } from "./ai-completer";
import { ShellAutocompleteEditor } from "./editor";
import { createShellAutocompleteProvider } from "./provider";

export default function (pi: ExtensionAPI) {
  const config = createConfig();

  // Diagnostic command to verify extension loaded
  pi.registerCommand("shell-test", {
    description: "Test if shell-autocomplete extension is loaded",
    handler: async (_args, ctx) => {
      const zsh = new ZshCompleter(config, (cmd, args, opts) =>
        pi.exec(cmd, args, opts ?? {}),
      );
      const available = await zsh.isAvailable();
      ctx.ui.notify(
        `shell-autocomplete: zsh=${available ? "OK" : "NOT FOUND"}`,
        "info",
      );
    },
  });

  const zshCompleter = new ZshCompleter(config, (command, args, opts) =>
    pi.exec(command, args, opts ?? {}),
  );

  const aiCompleter = new AiCompleter(config.ai);

  pi.on("session_start", async (_event, ctx) => {
    const available = await zshCompleter.checkAvailability(() => {
      ctx.ui.notify("shell-autocomplete: zsh not available", "error");
    });
    if (!available) return;

    ctx.ui.notify("shell-autocomplete ready", "success");

    let editorRef: ShellAutocompleteEditor | null = null;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new ShellAutocompleteEditor(tui, theme, keybindings, config.ghost);
      editorRef = editor;
      return editor;
    });

    ctx.ui.addAutocompleteProvider((current) =>
      createShellAutocompleteProvider(current, zshCompleter, aiCompleter, config,
        (token, completion) => {
          if (editorRef && completion && editorRef.currentToken === token) {
            const fullCommand = completion.startsWith(token) ? completion : token + completion;
            const suffix = fullCommand.slice(token.length);
            if (suffix) {
              editorRef.setGhostText(suffix);
              editorRef.requestRender();
            }
          }
        },
      ),
    );
  });
}
