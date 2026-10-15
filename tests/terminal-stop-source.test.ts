import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalSessions } from "../src/sessions";
import { findShell } from "../src/shell";

it.each(["user", "agent"] as const)(
  "background cancellation records %s as the source",
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), "terminal-stop-source-"));
    const controller = new AbortController();
    const tasks: Promise<unknown>[] = [];
    const sessions = new TerminalSessions({
      pluginId: "test",
      storagePath: root,
      grantedPermissions: new Set(["process.spawn"]),
      signal: controller.signal,
      runBackground: (_context, run) => {
        tasks.push(run(controller.signal));
        return "task";
      },
    });
    const context = {
      sessionId: "s",
      runId: "r",
      workspacePath: root,
      signal: controller.signal,
    };
    try {
      const started = await sessions.start(
        (await findShell())!,
        process.platform === "win32" ? "Start-Sleep 30" : "sleep 30",
        root,
        60000,
        context,
      );
      await expect
        .poll(() => sessions.snapshot(started.sessionId, context)?.pid)
        .toBeTruthy();
      await sessions.execute(
        { action: "stop", sessionId: started.sessionId },
        context,
        source,
      );
      await Promise.all(tasks);
      const result = await sessions.execute(
        { action: "read", sessionId: started.sessionId },
        context,
      );
      expect(result).toMatchObject({
        status: "cancelled",
        stoppedBy: source,
        reason: source,
      });
      expect(sessions.snapshot(started.sessionId, context)?.stoppedBy).toBe(
        source,
      );
    } finally {
      controller.abort();
      await Promise.all(tasks);
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
