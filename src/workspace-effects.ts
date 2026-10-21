import type { PluginContributions } from "@pal/plugin-sdk";
import { isReadonlyShellCommand } from "./readonly-shell-command";

export function terminalWorkspaceEffects(id: string, input: unknown): boolean {
  if (
    [
      "terminal_read",
      "terminal_list",
      "terminal_wait",
      "terminal_focus",
    ].includes(id)
  )
    return false;
  const value =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  if (id === "terminal_session")
    return !["read", "list", "logs", "read_log"].includes(String(value.action));
  if (id === "terminal_execute") return !isReadonlyShellCommand(value.command);
  return true;
}
export function withWorkspaceEffects(
  contributions: PluginContributions,
): PluginContributions {
  return {
    ...contributions,
    tools: (contributions.tools ?? []).map((tool) => ({
      ...tool,
      ...(tool.definition.workspaceEffects === "input"
        ? {
            hasWorkspaceEffects: (input: unknown) =>
              terminalWorkspaceEffects(tool.definition.id, input),
          }
        : {}),
    })),
  };
}
