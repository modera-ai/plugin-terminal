import type {
  PluginUiRequest,
  ToolContext,
} from "@pal/plugin-sdk";
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
  async snapshot(request: PluginUiRequest, context: ToolContext) {
    const data = JSON.parse(request.tool?.result ?? "null");
    if (!data?.logPath) return undefined;
    const cursor = this.cursors.get(this.key(request, context));
    if (cursor === undefined) return { path: data.logPath, open: false };
    const page = await this.logs.read(data.sessionId, cursor, context);
    return { path: data.logPath, open: true, cursor, ...page };
  }
}
