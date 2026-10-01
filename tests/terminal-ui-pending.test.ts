import { expect, it, vi } from "vitest";
import type { PluginUiRequest, ToolContext } from "@modera/plugin-sdk";
import { terminalUi } from "../src/ui";
import { InteractiveCommands } from "../src/interactive";
import type { TerminalSessions } from "../src/sessions";

const context: ToolContext = { sessionId: "s", runId: "r", toolCallId: "c", workspacePath: process.cwd(), signal: new AbortController().signal };
function fixture() {
  const interactive = new InteractiveCommands({ pluginId: "test", storagePath: "", grantedPermissions: new Set(["process.spawn"]), signal: context.signal });
  const snapshot = vi.spyOn(interactive, "snapshotIfAvailable");
  const sessions = { logs: {}, snapshot: vi.fn() } as unknown as TerminalSessions;
  return { ui: terminalUi(sessions, interactive).find(item => item.slot === "tool.result")!, snapshot };
}
const request = (interactive: boolean): PluginUiRequest => ({ locale: "zh-CN", toolCallId: "c", tool: { name: "terminal_execute", input: { command: "echo test", description: "test command", interactive } } } as PluginUiRequest);

it("renders a pending ordinary command without reading an interactive session", async () => {
  const { ui, snapshot } = fixture();
  const view = await ui.render(request(false), context);
  expect(snapshot).not.toHaveBeenCalled();
  expect(view.live).toBe(true);
  expect(view.data).toMatchObject({ command: "echo test", interactive: false, inputReady: false, canStop: false });
});
it("renders an interactive command before process registration without an error or active controls", async () => {
  const { ui, snapshot } = fixture();
  const view = await ui.render(request(true), context);
  expect(snapshot).toHaveBeenCalled();
  expect(view.live).toBe(true);
  expect(view.data).toMatchObject({ interactive: true, inputReady: false, canStop: false });
});
