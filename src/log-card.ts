import type {
  PluginUiNode,
  PluginUiRequest,
  ToolContext,
} from "@modera/plugin-sdk";
import type { TerminalLogs } from "./logs";

/** Read-only log paging, bound to the host-resolved tool result. */
export class LogCard {
  private cursors = new Map<string, number>();
  constructor(private logs: TerminalLogs) {}
  private key(request: PluginUiRequest, context: ToolContext) {
    return JSON.stringify([
      context.projectId,
      context.sessionId,
      request.toolCallId,
    ]);
  }
  async act(action: string, request: PluginUiRequest, context: ToolContext) {
    const data = JSON.parse(request.tool?.result ?? "null");
    if (!data?.logPath || !data.sessionId) throw new Error("Log unavailable");
    const key = this.key(request, context);
    if (action === "log-close") {
      this.cursors.delete(key);
      return;
    }
    const page = await this.logs.read(
      data.sessionId,
      this.cursors.get(key) ?? 0,
      context,
    );
    if (this.cursors.size >= 32)
      this.cursors.delete(this.cursors.keys().next().value!);
    this.cursors.set(key, action === "log-next" ? page.nextCursor : 0);
  }
  async render(
    request: PluginUiRequest,
    context: ToolContext,
  ): Promise<PluginUiNode[]> {
    const data = JSON.parse(request.tool?.result ?? "null");
    if (!data?.logPath) return [];
    const zh = request.locale.startsWith("zh");
    const nodes: PluginUiNode[] = [
      {
        type: "text",
        tone: "muted",
        text: `${zh ? "日志" : "Log"}: ${data.logPath}`,
      },
    ];
    const cursor = this.cursors.get(this.key(request, context));
    if (cursor === undefined)
      return [
        ...nodes,
        {
          type: "button",
          action: "log-open",
          label: zh ? "查看日志" : "View log",
        },
      ];
    const page = await this.logs.read(data.sessionId, cursor, context);
    nodes.push(
      { type: "code", text: page.output || (zh ? "暂无输出" : "No output") },
      {
        type: "text",
        tone: "muted",
        text: `${cursor}–${page.nextCursor} / ${page.sizeBytes} ${zh ? "字节" : "bytes"}`,
      },
      {
        type: "button",
        action: "log-open",
        label: zh ? "回到开头" : "First page",
      },
    );
    if (page.hasMore)
      nodes.push({
        type: "button",
        action: "log-next",
        label: zh ? "下一页" : "Next page",
      });
    nodes.push({
      type: "button",
      action: "log-close",
      label: zh ? "收起日志" : "Hide log",
    });
    return nodes;
  }
}
