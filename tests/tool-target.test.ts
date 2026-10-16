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
  for (const action of ["logs", "list", "read"])
    expect(
      terminalToolTarget("terminal_session", {
        action,
        description: "unrelated business value",
      }),
    ).toBe(action);
});
