import React from "react";
import { record } from "./tool-target";
/** PTY operation bodies belong to this plugin, not to host tool-name routing. */
export function TerminalControlResult({
  name,
  input,
  result,
  locale,
}: {
  name: string;
  input: unknown;
  result: unknown;
  locale: string;
}) {
  const data = record(result),
    args = record(input),
    zh = locale.startsWith("zh");
  if (name === "terminal_list")
    return (
      <ul>
        {(Array.isArray(data.terminals) ? data.terminals : []).map(
          (value, i) => {
            const item = record(value);
            return (
              <li key={String(item.tabId ?? i)}>
                <strong>{String(item.title ?? "Terminal")}</strong> ·{" "}
                {String(item.cwd ?? "")} ·{" "}
                {item.alive
                  ? zh
                    ? "运行中"
                    : "Running"
                  : zh
                    ? "已退出"
                    : "Exited"}
              </li>
            );
          },
        )}
      </ul>
    );
  if (name === "terminal_send")
    return (
      <div>
        {typeof args.input === "string" ? (
          <pre>{args.input}</pre>
        ) : (
          <pre>{Array.isArray(args.keys) ? args.keys.join(" + ") : ""}</pre>
        )}
        <p>{zh ? "输入已发送" : "Input sent"}</p>
      </div>
    );
  if (name === "terminal_read" || name === "terminal_wait")
    return (
      <div>
        <pre>
          {typeof data.text === "string" && data.text
            ? data.text
            : zh
              ? "暂无新输出"
              : "No new output"}
        </pre>
        {data.lostOutput === true && (
          <p>
            {zh
              ? "较早输出已超出缓冲范围"
              : "Earlier output exceeded the buffer"}
          </p>
        )}
        {data.timedOut === true && (
          <p>
            {zh
              ? "等待时间已到，终端仍可继续运行"
              : "Wait elapsed; the terminal may still be running"}
          </p>
        )}
      </div>
    );
  const statuses: Record<string, string> = zh
    ? {
        terminal_open: "终端已打开",
        terminal_resize: "尺寸已更新",
        terminal_focus: "已切换到终端",
        terminal_close: "终端已关闭",
      }
    : {
        terminal_open: "Terminal opened",
        terminal_resize: "Size updated",
        terminal_focus: "Terminal focused",
        terminal_close: "Terminal closed",
      };
  return (
    <div>
      <p>{statuses[name]}</p>
      <p>
        {String(data.title ?? "")} · {String(data.cwd ?? "")}
      </p>
      {typeof data.cols === "number" && (
        <p>
          {data.cols} × {String(data.rows)}
        </p>
      )}
    </div>
  );
}
