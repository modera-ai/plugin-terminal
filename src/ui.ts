import type { PluginUiContribution } from "@modera/plugin-sdk";
import type { TerminalSessions } from "./sessions";
import type { InteractiveCommands } from "./interactive";
import { LogCard } from "./log-card";

export function terminalUi(sessions: TerminalSessions, interactive: InteractiveCommands): PluginUiContribution[] {
  const logs = new LogCard(sessions.logs);
  return (["tool.approval", "tool.result"] as const).map((slot) => ({
    id: `modera.terminal.${slot === "tool.approval" ? "approval" : "result"}`,
    slot,
    hostRenderer: "terminal-result",
    toolNames: ["terminal_execute"],
    requiredPermissions: ["process.spawn"],
    actions: slot === "tool.result" ? ["stop", "input", "log-open", "log-next", "log-close"] : [],
    async act(action, context, request) {
      if (action.id.startsWith("log-")) return logs.act(action.id, request, context);
      if (request.toolCallId && (request.tool?.input as { interactive?: boolean })?.interactive && request.tool?.result === undefined) {
        await interactive.act(request.toolCallId, action.id, action.value, context);
        return;
      }
      if (action.id !== "stop") throw new Error("Action unavailable");
      const data = JSON.parse(request.tool?.result ?? "null");
      sessions.execute({ action: "stop", sessionId: data?.sessionId }, context, "user");
    },
    async render(request, context) {
      const pending = slot === "tool.result" && request.toolCallId && request.tool?.result === undefined;
      const input = request.tool?.input as { description?: string; command?: string; interactive?: boolean } | undefined;
      const interactiveData = pending && input?.interactive === true
        ? interactive.snapshotIfAvailable(request.toolCallId!, context) : undefined;
      const data = pending ? interactiveData ?? {
        description: input?.description,
        command: input?.command,
        cwd: context.workspacePath,
        status: "running",
        output: "",
        interactive: input?.interactive === true,
        inputReady: false,
      } : JSON.parse(request.tool?.result ?? "null");
      if (!data || data.error) throw new Error("Terminal preview/result unavailable");
      const current = data.sessionId ? sessions.snapshot(data.sessionId, context) : undefined;
      return {
        title: String(data.description ?? input?.description ?? "Terminal"),
        live: (!!pending && data.status === "running") || (!!current && !current.done),
        data: {
          ...data,
          ...(current ?? {}),
          approval: slot === "tool.approval",
          inputReady: !!pending && !!data.interactive && data.status === "running" && !!data.inputReady,
          canStop: (!!interactiveData && interactiveData.status === "running") || (!!current && !current.done),
          unavailable: !!data.sessionId && !current,
          log: slot === "tool.result" ? await logs.snapshot(request, context) : undefined,
        },
        children: [],
      };
    },
  }));
}
