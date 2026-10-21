import type { PluginContext } from "@pal/plugin-sdk";
export function processHost(
  scope: (projectId?: string) => AbortSignal,
  createPty?: (input: any) => any,
): Pick<PluginContext, "command" | "processPort">;
