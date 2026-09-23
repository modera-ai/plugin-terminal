import type {
  PluginUiContribution,
  PluginUiNode,
} from "@modera/plugin-sdk";

export function sessionUi(): PluginUiContribution {
  return {
    id: "modera.terminal.session-result",
    slot: "tool.result",
    toolNames: ["terminal_session"],
    requiredPermissions: ["process.spawn"],
    async render(request) {
      const data = JSON.parse(request.tool?.result ?? "null");
      if (!data || data.error) throw new Error("Session result unavailable");
      const zh = request.locale.startsWith("zh");
      const states: Record<string, string> = zh
        ? {
            running: "运行中",
            completed: "已结束",
            stopping: "正在停止",
            cancelled: "已取消",
            timed_out: "超时",
            failed: "失败",
            output_limit: "输出超限",
          }
        : {};
      const children: PluginUiNode[] = (
        data.sessions ?? (data.logId ? [] : [data])
      ).flatMap((job: Record<string, unknown>) => [
        {
          type: "text",
          text: `${job.sessionId} · ${states[String(job.status)] ?? job.status}`,
        },
        { type: "code", text: String(job.command ?? "") },
      ]);
      if (data.logs)
        return {
          title: zh ? "终端日志" : "Terminal logs",
          children: data.logs.map((log: { id: string; path: string }) => ({
            type: "text" as const,
            text: `${log.id}\n${log.path}`,
          })),
        };
      if (data.logPath)
        children.push({ type: "text", tone: "muted", text: data.logPath });
      if (typeof data.output === "string")
        children.push({
          type: "code",
          text: data.output || (zh ? "暂无新输出" : "No new output"),
        });
      if (data.lostOutput)
        children.push({
          type: "text",
          text: zh
            ? "较早输出已回收，当前从可用位置继续。"
            : "Older output was evicted; resumed at available offset.",
          tone: "muted",
        });
      return { title: zh ? "终端任务" : "Terminal jobs", children };
    },
  };
}
