import type {
  PluginUiContribution,
  PluginUiNode,
} from "@modera/plugin-sdk";
import type { TerminalSessions } from "./sessions";
import type { InteractiveCommands } from "./interactive";
import { LogCard } from "./log-card";

export function terminalUi(
  sessions: TerminalSessions,
  interactive: InteractiveCommands,
): PluginUiContribution[] {
  const logs = new LogCard(sessions.logs);
  return (["tool.approval", "tool.result"] as const).map((slot) => ({
    id: `modera.terminal.${slot === "tool.approval" ? "approval" : "result"}`,
    slot,
    toolNames: ["terminal_execute"],
    requiredPermissions: ["process.spawn"],
    actions:
      slot === "tool.result"
        ? ["stop", "input", "log-open", "log-next", "log-close"]
        : [],
    async act(action, context, request) {
      if (action.id.startsWith("log-"))
        return logs.act(action.id, request, context);
      if (
        request.toolCallId &&
        (request.tool?.input as { interactive?: boolean })?.interactive &&
        request.tool?.result === undefined
      ) {
        await interactive.act(
          request.toolCallId,
          action.id,
          action.value,
          context,
        );
        return;
      }
      if (action.id !== "stop") throw new Error("Action unavailable");
      const data = JSON.parse(request.tool?.result ?? "null");
      sessions.execute({ action: "stop", sessionId: data?.sessionId }, context);
    },
    async render(request, context) {
      const zh = request.locale.startsWith("zh");
      const pending =
        slot === "tool.result" &&
        request.toolCallId &&
        request.tool?.result === undefined;
      const data = pending
        ? interactive.snapshot(request.toolCallId!, context)
        : JSON.parse(request.tool?.result ?? "null");
      if (!data || data.error)
        throw new Error("Terminal preview/result unavailable");
      const current = data.sessionId
        ? sessions.snapshot(data.sessionId, context)
        : undefined;
      const input = request.tool?.input as { description?: string } | undefined;
      const status = current?.status ?? data.status;
      const statuses: Record<string, string> = zh
        ? {
            running: data.interactive
              ? "交互式 · 等待输入或命令完成"
              : "后台运行中",
            completed: "执行完成",
            timed_out: "执行超时",
            cancelled: "已取消",
            output_limit: "输出超限，已停止",
            failed: "执行失败",
          }
        : {
            running: data.interactive
              ? "Interactive · waiting for input or completion"
              : "Running in background",
            completed: "Completed",
            timed_out: "Timed out",
            cancelled: "Cancelled",
            output_limit: "Output limit",
            failed: "Failed",
          };
      const label =
        (statuses[status] ?? "") +
        (pending && data.inputCount
          ? zh
            ? ` · 已发送 ${data.inputCount} 次输入`
            : ` · ${data.inputCount} inputs sent`
          : "");
      const badge =
        current?.pid && status === "running"
          ? `${label} · PID ${current.pid}`
          : status === "completed"
            ? `${zh ? "退出码" : "Exit code"} ${current?.exitCode ?? data.exitCode}`
            : label;
      const children: PluginUiNode[] = [
        {
          type: "console",
          cwd: String(data.cwd),
          command: String(data.command),
          description: String(data.description ?? input?.description ?? ""),
          output: current?.output ?? data.output ?? "",
          status: badge,
        },
      ];
      if (slot === "tool.result")
        children.push(...(await logs.render(request, context)));
      if (current?.expiresAt && !current.done)
        children.push({
          type: "text",
          tone: "muted",
          text: `${zh ? "运行期限" : "Deadline"}: ${new Date(current.expiresAt).toLocaleString(zh ? "zh-CN" : "en")}`,
        });
      if (current?.logTruncated)
        children.push({
          type: "text",
          tone: "muted",
          text: zh
            ? "日志已达 4 MiB 上限，后续输出不再落盘；进程继续运行。"
            : "Log truncated at 4 MiB; process continues without further disk recording.",
        });
      if (current?.logError || data.logError)
        children.push({
          type: "text",
          text: `${zh ? "日志未保存，命令不受影响" : "Log unavailable; command continues"}: ${current?.logError ?? data.logError}`,
        });
      if (pending && data.interactive && data.status === "running") {
        if (data.inputReady)
          children.push({
            type: "form",
            action: "input",
            submitIcon: "send",
            maxLength: 3999,
            label: zh ? "发送输入" : "Send input",
            placeholder: zh
              ? "输入内容并按回车键…"
              : "Enter input and press Enter…",
          });
        children.push({
          type: "button",
          action: "stop",
          label: zh ? "终止" : "Stop",
        });
      }
      if (current && !current.done)
        children.push({
          type: "button",
          label: zh ? "停止后台任务" : "Stop background task",
          action: "stop",
        });
      if (data.sessionId && !current)
        children.push({
          type: "text",
          tone: "muted",
          text: zh
            ? "后台任务已不可用；这里只显示启动时的记录。"
            : "Background task unavailable; showing the launch snapshot.",
        });
      if (slot === "tool.approval")
        children.push({
          type: "text",
          tone: "muted",
          text: zh
            ? `超时：${data.timeout} ms。命令以当前用户权限运行，可访问项目外文件和网络；不是安全沙箱。`
            : `Timeout: ${data.timeout} ms. Runs with your OS privileges, including files outside the project and network. Not sandboxed.`,
        });
      if (data.truncated)
        children.push({
          type: "text",
          tone: "muted",
          text: zh
            ? "输出已截断，仅保留开头和结尾。"
            : "Output truncated to head and tail.",
        });
      return {
        title: String(
          data.description ??
            input?.description ??
            (zh ? "终端命令" : "Terminal command"),
        ),
        badge,
        live:
          (!!pending && data.status === "running") ||
          (!!current && !current.done),
        children,
      };
    },
  }));
}
