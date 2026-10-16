import { expect, it, vi, beforeEach } from "vitest";
vi.mock("../src/process", () => ({ runCommand: vi.fn() }));
import { runCommand, type CommandResult } from "../src/process";
import { activate } from "../src/index";
import { TerminalLogs } from "../src/logs";
import { terminalFixture, executePrepared } from "./helpers/terminal-fixture";
import type { ToolContext } from "@pal/plugin-sdk";

const processes: { finish(): void }[] = [];
beforeEach(() => {
  processes.length = 0;
  vi.mocked(runCommand)
    .mockReset()
    .mockImplementation(
      (shell, command, cwd, _timeout, signal) =>
        new Promise<CommandResult>((resolve) => {
          const finish = () => {
            signal.removeEventListener("abort", finish);
            resolve({
              command,
              shell,
              cwd,
              status: signal.aborted ? "cancelled" : "completed",
              exitCode: 0,
              signal: null,
              output: "done",
              outputBytes: 4,
              truncated: false,
              durationMs: 1,
            });
          };
          processes.push({ finish });
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
        }),
    );
});

async function fixture(
  work: (
    f: Awaited<ReturnType<typeof terminalFixture>> & {
      start(
        input?: Record<string, unknown>,
        context?: ToolContext,
      ): Promise<unknown>;
    },
  ) => Promise<void>,
) {
  const f = await terminalFixture();
  const contribution = await activate(f.host);
  const tool = contribution!.tools!.find(
    (t) => t.definition.id === "terminal_execute",
  )!;
  const pending: Promise<unknown>[] = [];
  const start = (input: Record<string, unknown> = {}, context = f.context) => {
    const call = executePrepared(
      tool,
      {
        command: "echo fake",
        description: "work",
        ...input,
      },
      context,
    );
    pending.push(call);
    void call.catch(() => {});
    return call;
  };
  try {
    await work({ ...f, start });
  } finally {
    await f.close();
    await Promise.allSettled(pending);
  }
}

it("admits two foreground jobs, rejects a third and releases the completed slot", () =>
  fixture(async (f) => {
    const first = f.start();
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const second = f.start();
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await expect(f.start()).rejects.toThrow("concurrency limit");
    processes[0].finish();
    await first;
    const third = f.start();
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    processes[1].finish();
    processes[2].finish();
    await Promise.all([second, third]);
  }));

it("shares the limit with interactive and background jobs", () =>
  fixture(async (f) => {
    const interactive = f.start(
      { interactive: true },
      { ...f.context, toolCallId: "interactive" },
    );
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    await f.start({ background: true });
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await expect(f.start()).rejects.toThrow("concurrency limit");
    processes[0].finish();
    await interactive;
    const next = f.start();
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    processes[1].finish();
    processes[2].finish();
    await next;
  }));

it("reserves capacity across simultaneous asynchronous startups", () =>
  fixture(async (f) => {
    const calls = [f.start(), f.start(), f.start()];
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes.forEach((p) => p.finish());
    const results = await Promise.allSettled(calls);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((r) => r.status === "rejected");
    expect(
      rejected?.status === "rejected" && rejected.reason.message,
    ).toContain("concurrency limit");
  }));

it("releases reservations after directory revalidation and background registration failures", async () => {
  // A prepare plan is valid, but its cwd may disappear before execution.
  const { mkdir, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await fixture(async (f) => {
    await mkdir(join(f.root, "gone"));
    const contribution = await activate(f.host);
    const tool = contribution!.tools!.find(
      (t) => t.definition.id === "terminal_execute",
    )!;
    const input = {
      command: "echo fake",
      description: "work",
      workingDirectory: "gone",
    };
    const plans = await Promise.all([
      tool.prepare!(input, f.context),
      tool.prepare!(input, f.context),
    ]);
    await rm(join(f.root, "gone"), { recursive: true });
    for (const plan of plans)
      await expect(tool.execute(plan.input, f.context)).rejects.toThrow();
    const original = f.host.runBackground;
    f.host.runBackground = () => {
      throw new Error("registration failed");
    };
    try {
      for (let i = 0; i < 2; i++)
        await expect(
          executePrepared(
            tool,
            { command: "echo", description: "work" },
            f.context,
          ),
        ).rejects.toThrow("registration failed");
    } finally {
      f.host.runBackground = original;
    }
    const calls = [
      executePrepared(
        tool,
        { command: "echo", description: "work" },
        f.context,
      ),
      executePrepared(
        tool,
        { command: "echo", description: "work" },
        f.context,
      ),
    ];
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes.forEach((p) => p.finish());
    await Promise.all(calls);
  });
});

it("releases a failed process and an interactive reservation", () =>
  fixture(async (f) => {
    for (const interactive of [false, true]) {
      vi.mocked(runCommand).mockRejectedValueOnce(new Error("spawn failed"));
      if (interactive)
        await expect(
          f.start({ interactive: true }, { ...f.context, toolCallId: "bad" }),
        ).rejects.toThrow("spawn failed");
      else expect(await f.start()).toMatchObject({ status: "failed" });
    }
    const first = f.start(),
      second = f.start();
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes.forEach((p) => p.finish());
    await Promise.all([first, second]);
  }));

it("releases a registration failure even when closing its log also fails", () =>
  fixture(async (f) => {
    const create = vi
      .spyOn(TerminalLogs.prototype, "create")
      .mockResolvedValue({
        path: "unused",
        error: undefined,
        truncated: false,
        append() {},
        close: async () => {
          throw new Error("log close failed");
        },
      });
    const original = f.host.runBackground;
    f.host.runBackground = () => {
      throw new Error("registration failed");
    };
    try {
      for (let i = 0; i < 2; i++)
        await expect(f.start()).rejects.toThrow("log close failed");
    } finally {
      f.host.runBackground = original;
      create.mockRestore();
    }
    const first = f.start(),
      second = f.start();
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes.forEach((p) => p.finish());
    await Promise.all([first, second]);
  }));

it("a 1000-second foreground operation stays pending and returns only the final result", () =>
  fixture(async (f) => {
    let settled = false;
    const pending = f.start().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    try {
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(1000000);
      expect(settled).toBe(false);
      expect(runCommand).toHaveBeenCalledTimes(1);
      processes[0].finish();
      const result = await pending;
      expect(result).toMatchObject({ status: "completed", output: "done" });
      expect(result).not.toHaveProperty("sessionId");
    } finally {
      vi.useRealTimers();
    }
  }));
it("cancelling a pending foreground call stops its process and rejects the old result", () =>
  fixture(async (f) => {
    const controller = new AbortController();
    const pending = f.start({}, { ...f.context, signal: controller.signal });
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const signal = vi.mocked(runCommand).mock.calls[0][4];
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(signal.aborted).toBe(true);
    await f.drain();
  }));
it("foreground and background use different waiting budgets and no yieldTimeMs schema", () =>
  fixture(async (f) => {
    const contributions = await activate(f.host);
    const tool = contributions!.tools!.find(
      (tool) => tool.definition.id === "terminal_execute",
    )!;
    expect(
      (tool.definition.inputSchema.properties as any).yieldTimeMs,
    ).toBeUndefined();
    for (const [input, budget] of [
      [{}, 1805000],
      [{ background: true }, 60000],
      [{ timeout: 1000000 }, 1005000],
    ] as const) {
      const prepared = await tool.prepare!(
        { command: "echo test", description: "测试", ...input },
        f.context,
      );
      expect(prepared.executionTimeoutMs).toBe(budget);
      prepared.dispose?.();
    }
  }));

it("a foreground card can inspect and stop its own pending command without a public job ID", () =>
  fixture(async (f) => {
    const contributions = await activate(f.host);
    const tool = contributions!.tools!.find(
      (tool) => tool.definition.id === "terminal_execute",
    )!;
    const context = { ...f.context, toolCallId: "foreground" };
    const pending = executePrepared(
      tool,
      { command: "echo test", description: "测试等待" },
      context,
    );
    const read = contributions!.commands!.find(
      (command) => command.id === "pal.terminal.presentation.read",
    )!;
    const act = contributions!.commands!.find(
      (command) => command.id === "pal.terminal.presentation.act",
    )!;
    const request = {
      tool: {
        name: "terminal_execute",
        input: { command: "echo test", description: "测试等待" },
      },
      toolCallId: "foreground",
      locale: "zh-CN",
    };
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const view = (await read.run!({}, { request, context } as never)) as any;
    expect(view.data.canStop).toBe(true);
    expect(view.data.status).toBe("running");
    await act.run!({ action: "stop" }, { request, context } as never);
    expect(await pending).toMatchObject({
      status: "cancelled",
      stoppedBy: "user",
    });
  }));
