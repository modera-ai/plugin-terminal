import { expect, it, vi } from "vitest";
import { activate } from "../src/index";
import { TerminalControl } from "../src/control";
it("returns a terminal view on PTY startup failure and permits retry before a tab exists", async () => {
  const controller = new AbortController();
  const host = { resourcePath: "resource", storagePath: "storage", signal: controller.signal };
  const open = vi.spyOn(TerminalControl.prototype, "open").mockRejectedValue(new Error("Cannot create process, error code: 267"));
  try {
    const contributions = await activate(host as never);
    const ui = contributions.ui!.find((item) => item.id === "modera.terminal.panel")!;
    const context = { workspacePath: "missing", projectId: "p", sessionId: "s", runId: "r", signal: controller.signal };
    const request = { id: ui.id, sessionId: "s", locale: "zh-CN" };
    expect(await ui.render(request, context)).toMatchObject({ title: "终端", data: { startupError: "Cannot create process, error code: 267" } });
    await expect(ui.act!({ id: "refresh" }, context, request)).resolves.toBeUndefined();
    await ui.render(request, context);
    expect(open).toHaveBeenCalledTimes(2);
  } finally { controller.abort(); open.mockRestore(); }
});
