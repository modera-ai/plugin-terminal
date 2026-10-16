import { expect, it, vi } from "vitest";
import type { PluginUiRequest, ToolContext } from "@pal/plugin-sdk";
import { definePlugin } from "@pal/plugin-sdk";
import { registerTerminalPresentation } from "../src/presentation";
import type { PluginContext } from "@pal/plugin-sdk";
import { InteractiveCommands } from "../src/interactive";
import type { TerminalSessions } from "../src/sessions";

const context: ToolContext = {
  sessionId: "s",
  runId: "r",
  toolCallId: "c",
  workspacePath: process.cwd(),
  signal: new AbortController().signal,
};
async function fixture() {
  const interactive = new InteractiveCommands({
    pluginId: "test",
    storagePath: "",
    grantedPermissions: new Set(["process.spawn"]),
    signal: context.signal,
  });
  const snapshot = vi.spyOn(interactive, "snapshotIfAvailable");
  const sessions = {
    logs: {},
    snapshot: vi.fn(),
    snapshotForCall: vi.fn(),
  } as unknown as TerminalSessions;
  const registered = await definePlugin((pal) =>
    registerTerminalPresentation(pal, sessions, interactive),
  ).activate({ signal: context.signal } as PluginContext);
  const command = registered!.commands!.find(
    (item) => item.id === "pal.terminal.presentation.read",
  )!;
  return {
    ui: {
      render: (request: PluginUiRequest, context: ToolContext) =>
        command.run!({}, { request, context } as never) as Promise<any>,
    },
    snapshot,
  };
}
const request = (interactive: boolean): PluginUiRequest =>
  ({
    locale: "zh-CN",
    toolCallId: "c",
    tool: {
      name: "terminal_execute",
      input: { command: "echo test", description: "test command", interactive },
    },
  }) as PluginUiRequest;

it("renders a pending ordinary command without reading an interactive session", async () => {
  const { ui, snapshot } = await fixture();
  const view = await ui.render(request(false), context);
  expect(view.title).toBe("执行终端命令");
  expect(snapshot).not.toHaveBeenCalled();
  expect(view.live).toBe(true);
  expect(view.data).toMatchObject({
    command: "echo test",
    interactive: false,
    inputReady: false,
    canStop: false,
  });
});

it.each(["logs", "list", "read"])(
  "uses the declared tool label for session %s instead of the generic fallback",
  async (action) => {
    const { ui } = await fixture();
    const input = { action };
    const toolRequest = {
      locale: "zh-CN",
      toolCallId: "c",
      tool: {
        name: "terminal_session",
        input,
        result: JSON.stringify({ items: [] }),
      },
    } as PluginUiRequest;
    expect((await ui.render(toolRequest, context)).title).toBe("管理终端任务");
    expect(
      (await ui.render({ ...toolRequest, locale: "en" }, context)).title,
    ).toBe("Manage terminal tasks");
  },
);
it("renders an interactive command before process registration without an error or active controls", async () => {
  const { ui, snapshot } = await fixture();
  const view = await ui.render(request(true), context);
  expect(snapshot).toHaveBeenCalled();
  expect(view.live).toBe(true);
  expect(view.data).toMatchObject({
    interactive: true,
    inputReady: false,
    canStop: false,
  });
});

it.each([
  "terminal_open",
  "terminal_send",
  "terminal_read",
  "terminal_resize",
  "terminal_wait",
  "terminal_close",
  "terminal_focus",
  "terminal_list",
])(
  "%s uses the plugin-owned control result instead of managed-command rendering",
  async (name) => {
    const { ui } = await fixture();
    const result = { tabId: "tab", title: "开发终端", text: "output" };
    const view = await ui.render(
      {
        ...request(false),
        tool: { name, input: {}, result: JSON.stringify(result) },
      },
      context,
    );
    expect(view.kind).toBe("control");
    expect(view.title).toBeTruthy();
    expect(view.data).toEqual(result);
  },
);
