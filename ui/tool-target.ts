/** Tools choose their own summaries; description is never a host protocol field. */
export function terminalToolTarget(
  name: string,
  input: unknown,
  result?: unknown,
  locale = "zh",
) {
  const args = record(input),
    data = record(result),
    zh = locale.startsWith("zh");
  const title = text(data.title) || (zh ? "当前终端" : "Current terminal");
  if (name === "terminal_execute") return text(args.description);
  if (name === "terminal_session") {
    const labels: Record<string, string> = zh
      ? {
          list: "查看任务列表",
          read: "读取任务输出",
          stop: "停止任务",
          logs: "查看任务日志",
          read_log: "读取任务日志",
        }
      : {
          list: "List jobs",
          read: "Read job output",
          stop: "Stop job",
          logs: "List job logs",
          read_log: "Read job log",
        };
    return labels[text(args.action)] ?? "";
  }
  if (name === "terminal_open") return text(data.cwd) || text(args.cwd);
  if (name === "terminal_send")
    return (
      text(args.description) ||
      (zh ? `向${title}发送输入` : `Send input to ${title}`)
    );
  if (name === "terminal_resize")
    return `${title} · ${data.cols ?? args.cols} × ${data.rows ?? args.rows}`;
  if (name === "terminal_list")
    return Array.isArray(data.terminals)
      ? `${data.terminals.length} ${zh ? "个终端" : "terminals"}`
      : "";
  return title;
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
