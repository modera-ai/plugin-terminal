import { processHost } from "./helpers/process-host.mjs";
import { beforeEach, expect, it } from "vitest";

const spawned: FakePty[] = [];
class FakePty {
  cols = 100;
  rows = 30;
  writes: string[] = [];
  data?: (value: string) => void;
  exit?: (value: { exitCode: number; signal?: number }) => void;
  write(value: string) {
    this.writes.push(value);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  kill() {
    this.exit?.({ exitCode: 0 });
  }
  onData(listener: (value: string) => void) {
    this.data = listener;
    return { dispose() {} };
  }
  onExit(listener: (value: { exitCode: number; signal?: number }) => void) {
    this.exit = listener;
    return { dispose() {} };
  }
}
import { TerminalControl } from "../src/control";

beforeEach(() => spawned.splice(0));

it("opens, controls, focuses, lists and closes scoped PTY tabs", async () => {
  const controller = new AbortController();
  const opened: { id: string; resource?: string }[] = [];
  const host = {
    ...processHost(
      () => controller.signal,
      () => {
        const p = new FakePty();
        spawned.push(p);
        return p;
      },
    ),
    pluginId: "pal.terminal",
    storagePath: "",
    grantedPermissions: new Set(["process.spawn"]),
    signal: controller.signal,
    config: {
      read: async () => ({
        revision: 0,
        values: { integratedShell: process.execPath },
        inherited: {},
        overrides: {},
        sources: {},
      }),
    },
    panels: {
      open: async (id: string, resource?: string) => {
        opened.push({ id, ...(resource ? { resource } : {}) });
      },
      close: async () => {},
    },
    invalidateUi() {},
  } as never;
  const context = {
    sessionId: "session",
    runId: "run",
    toolCallId: "call",
    projectId: "project",
    workspacePath: process.cwd(),
    signal: controller.signal,
  };
  const control = new TerminalControl(host);
  const first = await control.open({}, context);
  expect(opened[0]?.id).toBe("pal.terminal.panel");
  expect(JSON.parse(opened[0]?.resource || "{}").tabId).toBe(first.tabId);
  await control.send({ input: "echo hello" }, context);
  expect(spawned[0]?.writes.at(-1)).toBe("echo hello\r");
  await control.send({ tabId: first.tabId, keys: ["up", "enter"] }, context);
  expect(spawned[0]?.writes.at(-1)).toBe("\x1b[A\r");
  await control.send(
    { keys: [" Control+C ", "ctrl+a", "ctrl+r", "return"] },
    context,
  );
  expect(spawned[0]?.writes.at(-1)).toBe("\x03\x01\x12\r");
  spawned[0]?.data?.("hello\r\n");
  const read = control.read({ tabId: first.tabId, cursor: 0 }, context);
  expect(read.text).toContain("hello");
  await control.resize({ tabId: first.tabId, cols: 120, rows: 40 }, context);
  expect([spawned[0]?.cols, spawned[0]?.rows]).toEqual([120, 40]);
  const waited = await control.wait(
    { tabId: first.tabId, timeoutMs: 1000, idleMs: 100 },
    context,
  );
  expect(waited.text).toContain("hello");
  const second = await control.open({}, context);
  expect(control.list(context).terminals).toHaveLength(2);
  await control.focus({ tabId: first.tabId }, context);
  expect(control.list(context).activeTabId).toBe(first.tabId);
  expect(
    (await control.close({ tabId: first.tabId }, context)).activeTabId,
  ).toBe(second.tabId);
  expect(control.list(context).terminals).toHaveLength(1);
  controller.abort();
});

it("rejects cross-conversation access and ambiguous send input", async () => {
  const controller = new AbortController();
  const host = {
    ...processHost(
      () => controller.signal,
      () => {
        const p = new FakePty();
        spawned.push(p);
        return p;
      },
    ),
    pluginId: "pal.terminal",
    storagePath: "",
    grantedPermissions: new Set(["process.spawn"]),
    signal: controller.signal,
    config: {
      read: async () => ({
        revision: 0,
        values: { integratedShell: process.execPath },
        inherited: {},
        overrides: {},
        sources: {},
      }),
    },
    panels: { open: async () => {}, close: async () => {} },
  } as never;
  const context = {
    sessionId: "a",
    runId: "r",
    toolCallId: "c",
    projectId: "p",
    workspacePath: process.cwd(),
    signal: controller.signal,
  };
  const control = new TerminalControl(host);
  const terminal = await control.open({}, context);
  expect(() =>
    control.read({ tabId: terminal.tabId }, { ...context, sessionId: "b" }),
  ).toThrow("unavailable");
  await expect(
    control.send(
      { tabId: terminal.tabId, input: "x", keys: ["enter"] },
      context,
    ),
  ).rejects.toThrow("exactly one");
  controller.abort();
});
