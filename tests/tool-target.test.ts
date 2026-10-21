import manifest from "../pal-manifest.json";
import { expect, it } from "vitest";
import { terminalToolTarget } from "../ui/tool-target";
it("execute displays the tool's own AI description, never the raw command", () => {
  expect(
    terminalToolTarget("terminal_execute", {
      command: "git status",
      description: " 检查工作区 ",
    }),
  ).toBe("检查工作区");
  for (const input of [{ command: "git status" }, { description: " " }, null])
    expect(terminalToolTarget("terminal_execute", input)).toBe("");
});
it("session tools choose their own action summary without borrowing another tool's description", () => {
  for (const [action, expected] of [
    ["logs", "查看任务日志"],
    ["list", "查看任务列表"],
    ["read", "读取任务输出"],
  ])
    expect(
      terminalToolTarget("terminal_session", {
        action,
        description: "unrelated business value",
      }),
    ).toBe(expected);
});

it("PTY tools own directory, terminal, size, count and optional send descriptions", () => {
  const result = { title: "开发终端", cwd: "/repo", cols: 120, rows: 40 };
  expect(terminalToolTarget("terminal_open", {}, result)).toBe("/repo");
  expect(terminalToolTarget("terminal_send", { input: "y" }, result)).toBe(
    "向开发终端发送输入",
  );
  expect(
    terminalToolTarget(
      "terminal_send",
      { description: "启动开发服务" },
      result,
    ),
  ).toBe("启动开发服务");
  expect(terminalToolTarget("terminal_resize", {}, result)).toBe(
    "开发终端 · 120 × 40",
  );
  for (const name of [
    "terminal_read",
    "terminal_wait",
    "terminal_close",
    "terminal_focus",
  ])
    expect(terminalToolTarget(name, {}, result)).toBe("开发终端");
  expect(terminalToolTarget("terminal_list", {}, { terminals: [] })).toBe(
    "0 个终端",
  );
  expect(terminalToolTarget("terminal_list", {})).toBe("");
  expect(
    terminalToolTarget("terminal_send", { input: "password" }, result, "en"),
  ).toBe("Send input to 开发终端");
});

it("only send gains an optional description and all ten tools declare the result slot", () => {
  const send = manifest.tools.find((tool) => tool.id === "terminal_send")!;
  expect(send.inputSchema.properties).toHaveProperty("description");
  expect(send.inputSchema.required ?? []).not.toContain("description");
  for (const tool of manifest.tools.filter(
    (tool) => !["terminal_send", "terminal_execute"].includes(tool.id),
  ))
    expect(tool.inputSchema.properties).not.toHaveProperty("description");
  const result = manifest.declarations.consumes.slots.find(
    (slot) => slot.id === "pal.terminal.result",
  )!;
  expect(result.content.toolNames).toEqual(
    manifest.tools.map((tool) => tool.id),
  );
});
