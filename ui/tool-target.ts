/** Each tool owns its summary; the shared layout only renders the supplied text. */
export function terminalToolTarget(name: string, input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const args = input as Record<string, unknown>;
  const value =
    name === "terminal_execute"
      ? args.description
      : name === "terminal_session"
        ? args.action
        : undefined;
  return typeof value === "string" ? value.trim() : "";
}
