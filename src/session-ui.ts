import type { PluginUiContribution } from "@pal/plugin-sdk";
export function sessionUi(): PluginUiContribution {
  return {
    id: "pal.terminal.session-result",
    slot: "tool.result",
    hostRenderer: "terminal-result",
    toolNames: ["terminal_session"],
    requiredPermissions: ["process.spawn"],
    async render(request) {
      const data = JSON.parse(request.tool?.result ?? "null");
      if (!data || data.error) throw new Error("Session result unavailable");
      return { title: request.locale.startsWith("zh") ? "终端任务" : "Terminal jobs", data, children: [] };
    },
  };
}
