import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createConfig } from "./config";
import { ZshCompleter } from "./zsh-completer";
import { AiCompleter } from "./ai-completer";
import { createContextCollector } from "./context-collector";
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

  // ── Lifecycle: tear down the persistent zsh worker on shutdown ──
  let disposed = false;
  const disposeOnce = () => {
    if (disposed) return;
    disposed = true;
    try { zshCompleter.dispose(); } catch { /* ignore */ }
  };
  pi.on("session_shutdown", async () => { disposeOnce(); });
  // Safety net: orphaned PTYs in dev (Ctrl-C, crash) — best-effort cleanup.
  process.once("exit", disposeOnce);
  process.once("SIGINT", () => { disposeOnce(); });
  process.once("SIGTERM", () => { disposeOnce(); });

  pi.on("session_start", async (_event, ctx) => {
    const available = await zshCompleter.checkAvailability(() => {
      ctx.ui.notify("shell-autocomplete: zsh not available", "error");
    });
    if (!available) return;

    ctx.ui.notify("shell-autocomplete ready", "success");

    // Create context collector with current working directory, git executor, and session manager
    const gitExec = (command: string, args: string[], opts?: { timeout?: number }) =>
      pi.exec(command, args, opts ?? {});
    const contextCollector = createContextCollector(
      config.ai,
      process.cwd(),
      gitExec,
      ctx.sessionManager,
    );
    const aiCompleter = new AiCompleter(config.ai, undefined, contextCollector);

    let editorRef: ShellAutocompleteEditor | null = null;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new ShellAutocompleteEditor(
        tui, theme, keybindings,
        config.ghost,
        (token) => aiCompleter.getCached(token),
      );
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
