/**
 * Extract the shell token after the trigger character.
 *
 * Examples:
 *   `!git co`        → "git co"
 *   `!`               → "" (empty string = trigger active but no token)
 *   `echo hello`       → undefined (no shell prefix)
 *   `echo !git`       → undefined (! in middle of line)
 *   `hello!world`     → undefined (! not at start)
 */
export function extractShellToken(
  textBeforeCursor: string,
  triggerChar: string,
): string | undefined {
  const escaped = triggerChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only at start of line (or after whitespace at start)
  const regex = new RegExp(`^[ \t]*${escaped}(.*)$`);
  const match = textBeforeCursor.match(regex);
  if (!match) return undefined;
  return match[1] ?? "";
}

/**
 * Check if the text before cursor contains an active shell prefix trigger.
 * Returns true even if no token follows (e.g., just "!").
 */
export function hasShellPrefix(
  textBeforeCursor: string,
  triggerChar: string,
): boolean {
  return extractShellToken(textBeforeCursor, triggerChar) !== undefined;
}
