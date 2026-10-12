import { mkdtemp, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { TerminalSessions } from "../src/sessions";
import { ProgressGuard } from "../../plugin-default-agent/src/run-budget";
import { findShell } from "../src/shell";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activate } from "../src";
import { readPluginManifest } from "@modera/plugin-host/testing";

const manifest = readPluginManifest(new URL("..", import.meta.url));
import { ToolRegistry } from "@modera-host/agent-host/src/tool-registry";
import { ToolExecutor } from "@modera-host/agent-host/src/tool-executor";

import { AgentPluginRuntime as PluginRuntime } from "@modera/agent-host";

it("foreground yield preserves a running command without a deadline, supports incremental reads and scope revocation", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "modera-jobs-")),
  );
  const registry = new ToolRegistry();
  let enabled = true;
  const runtime = new PluginRuntime(
    registry,
    (_id, project) => project !== "p" || enabled,
    async () => root,
  );
  runtime.add({
    manifest,
    load: async () => ({ activate }),
    readFrontend: async () => ({ body: new Uint8Array(await readFile(new URL("../dist/ui/terminal-result.js", import.meta.url))), mime: "text/javascript" }),
  });
  await runtime.reconcile(new Set([manifest.id]));
  const context = {
    projectId: "p",
    sessionId: "s",
    runId: "r",
    workspacePath: root,
    signal: new AbortController().signal,
  };
  const executor = new ToolExecutor(
    registry,
    async () => true,
    new Set(["process.spawn"]),
  );
  const call = async (name: string, input: unknown, ctx = context) =>
    JSON.parse(await executor.execute({ id: "c", name, input }, ctx));
  try {
    const command =
      process.platform === "win32"
        ? "echo first; Start-Sleep -Milliseconds 700; echo second; Start-Sleep -Seconds 10"
        : "echo first; sleep 1; echo second; sleep 10";
    const started = await call("terminal_execute", {
      command,
      description: "long task",
      yieldTimeMs: 0,
    });
    expect(started.sessionId).toBeTruthy();
    expect(started.status).toBe("running");
    expect(started.expiresAt).toBeNull();
    const sessionId = started.sessionId;
    expect(
      (
        await call(
          "terminal_session",
          { action: "read", sessionId },
          { ...context, sessionId: "other" },
        )
      ).error,
    ).toContain("unavailable");
    const progress = new ProgressGuard();
    let cursor = 0,
      output = "";
    for (let i = 0; i < 100 && !output.includes("second"); i++) {
      const read = await call("terminal_session", {
        action: "read",
        sessionId,
        cursor,
      });
      progress.observe(
        [
          {
            name: "terminal_session",
            input: { action: "read", sessionId, cursor },
          },
        ],
        [JSON.stringify(read)],
      );
      expect(read.nextCursor).toBeGreaterThanOrEqual(cursor);
      cursor = read.nextCursor;
      output += read.output;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(output).toContain("first");
    expect(output).toContain("second");
    expect(
      (await call("terminal_session", { action: "read", sessionId, cursor }))
        .output,
    ).toBe("");
    enabled = false;
    await runtime.reconcile(new Set([manifest.id])); // global plugin remains active
    await new Promise((resolve) => setTimeout(resolve, 1200));
    enabled = true;
    await runtime.reconcile(new Set([manifest.id]));
    const ended = await call("terminal_session", {
      action: "read",
      sessionId,
      cursor,
    });
    expect(ended.done).toBe(true);
    expect(ended.status).toBe("cancelled");
    const logs = await call("terminal_session", { action: "logs" });
    expect(logs.logs.map((log: { id: string }) => log.id)).toContain(sessionId);
    const saved = await call("terminal_session", {
      action: "read_log",
      sessionId,
    });
    expect(saved.logPath).toBe(started.logPath);
    expect(saved.output).toContain("first");
    expect(saved.output).toContain("second");
    expect(saved.hasMore).toBe(false);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it("background execution survives unavailable log storage and output above the log cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-log-fail-"));
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  try {
    await writeFile(join(root, "logs"), "blocked");
    const sessions = new TerminalSessions({
      pluginId: manifest.id,
      storagePath: root,
      signal: controller.signal,
      grantedPermissions: new Set(manifest.permissions),
      runBackground: (_context, run) => {
        task = run(controller.signal);
      },
    });
    const context = {
      sessionId: "s",
      runId: "r",
      workspacePath: root,
      signal: controller.signal,
    };
    const command =
      process.platform === "win32"
        ? "[Console]::Write(('x' * 4300000)); Write-Output 'AFTER_CAP'"
        : "head -c 4300000 /dev/zero | tr '\\0' x; echo AFTER_CAP";
    const started = await sessions.start(
      (await findShell())!,
      command,
      root,
      15000,
      context,
    );
    expect(started.logError).toBeTruthy();
    await task;
    expect(sessions.snapshot(started.sessionId, context)?.status).toBe(
      "completed",
    );
    expect(sessions.snapshot(started.sessionId, context)?.output).toContain(
      "AFTER_CAP",
    );
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
