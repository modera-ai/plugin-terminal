import { processHost } from "./helpers/process-host.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { TerminalSessions } from "../src/sessions";
import { findShell } from "../src/shell";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { activate } from "../src";
import { terminalFixture, executePrepared } from "./helpers/terminal-fixture";

it("explicit background preserves output, scope cancellation and persistent logs", async () => {
  const f = await terminalFixture();
  const contributions = await activate(f.host);
  const execute = contributions!.tools!.find(
    (t) => t.definition.id === "terminal_execute",
  )!;
  const sessions = contributions!.tools!.find(
    (t) => t.definition.id === "terminal_session",
  )!;
  try {
    const started = (await executePrepared(
      execute,
      {
        command:
          process.platform === "win32"
            ? "echo first; Start-Sleep -Milliseconds 200; echo second; Start-Sleep -Seconds 30"
            : "echo first; sleep 0.2; echo second; sleep 30",
        description: "long task",
        background: true,
      },
      f.context,
    )) as any;
    expect(started.sessionId).toBeTruthy();
    expect(started.expiresAt).toBeNull();
    await expect(
      sessions.execute(
        { action: "read", sessionId: started.sessionId },
        { ...f.context, sessionId: "other" },
      ),
    ).rejects.toThrow("unavailable");
    let cursor = 0,
      output = "";
    await expect
      .poll(
        async () => {
          const read = (await sessions.execute(
            { action: "read", sessionId: started.sessionId, cursor },
            f.context,
          )) as any;
          expect(read.nextCursor).toBeGreaterThanOrEqual(cursor);
          cursor = read.nextCursor;
          output += read.output;
          return output;
        },
        { timeout: 8000 },
      )
      .toContain("second");
    expect(output).toContain("first");
    expect(
      (
        (await sessions.execute(
          { action: "read", sessionId: started.sessionId, cursor },
          f.context,
        )) as any
      ).output,
    ).toBe("");
    f.revokeScope();
    await f.drain();
    const ended = (await sessions.execute(
      { action: "read", sessionId: started.sessionId, cursor },
      f.context,
    )) as any;
    expect(ended).toMatchObject({ done: true, status: "cancelled" });
    const saved = (await sessions.execute(
      { action: "read_log", sessionId: started.sessionId },
      f.context,
    )) as any;
    expect(saved.logPath).toBe(started.logPath);
    expect(saved.output).toContain("first");
    expect(saved.output).toContain("second");
    expect(saved.hasMore).toBe(false);
  } finally {
    await f.close();
  }
}, 15000);

it("background execution survives unavailable log storage and output above the log cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-log-fail-"));
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  try {
    await writeFile(join(root, "logs"), "blocked");
    const sessions = new TerminalSessions({
      ...processHost(() => controller.signal),
      pluginId: "pal.terminal",
      storagePath: root,
      signal: controller.signal,
      grantedPermissions: new Set([
        "process.spawn",
        "storage.read",
        "storage.write",
      ]),
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

it("foreground commands return output without creating log storage", async () => {
  const f = await terminalFixture();
  try {
    // Even an unusable log directory must not affect foreground execution.
    await writeFile(join(f.root, "logs"), "not a directory");
    const contributions = await activate(f.host);
    const execute = contributions!.tools!.find(
      (t) => t.definition.id === "terminal_execute",
    )!;
    const result = (await executePrepared(
      execute,
      { command: "echo FOREGROUND", description: "foreground" },
      f.context,
    )) as any;
    expect(result.output).toContain("FOREGROUND");
    expect(result.logError).toBeUndefined();
    expect(result.logPath).toBeUndefined();
  } finally {
    await f.close();
  }
}, 15000);
