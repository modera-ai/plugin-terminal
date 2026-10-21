import { processHost } from "./helpers/process-host.mjs";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { activate } from "../src";
import { findShell, childEnvironment } from "../src/shell";
import { runCommand as executeCommand } from "../src/process";

import { terminalFixture, nodeCommand } from "./helpers/terminal-fixture";

function runCommand(
  shell: string,
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
) {
  const host = processHost(() => signal);
  return executeCommand(
    shell,
    command,
    cwd,
    timeout,
    signal,
    undefined,
    undefined,
    undefined,
    undefined,
    host.command!({
      sessionId: "s",
      projectId: "p",
      runId: "r",
      workspacePath: cwd,
      signal,
    }),
  );
}

async function fixture(work: (root: string, shell: string) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "modera-terminal-test-")),
  );
  try {
    const shell = await findShell();
    expect(shell).toBeTruthy();
    await work(root, shell!);
  } finally {
    // Windows may release the terminated process working-directory handle shortly after exit.
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

it(
  "executes with project cwd, UTF-8, both streams and exit codes",
  () =>
    fixture(async (root, shell) => {
      const result = await runCommand(
        shell,
        nodeCommand(
          "console.log('你好'); console.error('stderr'); console.log(process.cwd()); process.exit(7)",
        ),
        root,
        10000,
        new AbortController().signal,
      );
      expect(result.exitCode).toBe(7);
      expect(result.output).toContain("你好");
      expect(result.output).toContain("stderr");
      expect(result.output).toContain(root);
      expect(result.status).toBe("completed");
    }),
  15000,
);

it(
  "bounds output, times out and rejects an unavailable shell",
  () =>
    fixture(async (root, shell) => {
      const result = await runCommand(
        shell,
        nodeCommand("console.log('x'.repeat(100000));console.log('TAIL')"),
        root,
        10000,
        new AbortController().signal,
      );
      expect(result.truncated).toBe(true);
      expect(result.output.length).toBeLessThan(3100);
      expect(result.output).toContain("TAIL");
      const timeout = await runCommand(
        shell,
        nodeCommand("setInterval(()=>{},1000)"),
        root,
        600,
        new AbortController().signal,
      );
      expect(timeout.status).toBe("timed_out");
      await expect(
        runCommand(
          join(root, "missing-shell"),
          "echo ok",
          root,
          1000,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    }),
  15000,
);

it("prepare has no process side effects; denied plans are disposed and allowed plans run", async () => {
  const f = await terminalFixture();
  const contribution = await activate(f.host);
  const tool = contribution!.tools!.find(
    (t) => t.definition.id === "terminal_execute",
  )!;
  const input = {
    command: nodeCommand("require('fs').writeFileSync('marker','ok')"),
    description: "marker",
  };
  try {
    const denied = await tool.prepare!(input, f.context);
    await expect(readFile(join(f.root, "marker"))).rejects.toThrow();
    denied.dispose?.();
    await expect(tool.execute(denied.input, f.context)).rejects.toThrow(
      "Invalid terminal approval",
    );
    const allowed = await tool.prepare!(input, f.context);
    expect(allowed.preview).toMatchObject({
      cwd: f.root,
      command: input.command,
    });
    expect(
      ((await tool.execute(allowed.input, f.context)) as any).exitCode,
    ).toBe(0);
    expect(await readFile(join(f.root, "marker"), "utf8")).toBe("ok");
    await expect(
      tool.prepare!({ ...input, workingDirectory: ".." }, f.context),
    ).rejects.toThrow("within the project");
    expect(tool.isAvailable?.({ ...f.context, workspacePath: undefined })).toBe(
      false,
    );
  } finally {
    await f.close();
  }
}, 15000);

it("scope cancellation terminates an executing command and its descendant", async () => {
  const f = await terminalFixture();
  let execution: Promise<unknown> | undefined;
  let pid: number | undefined;
  try {
    const contribution = await activate(f.host);
    const tool = contribution!.tools!.find(
      (t) => t.definition.id === "terminal_execute",
    )!;
    const child =
      "require('fs').writeFileSync('pid',String(process.pid));setInterval(()=>{},1000)";
    const plan = await tool.prepare!(
      {
        description: "wait",
        command: nodeCommand(
          `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000)`,
        ),
        background: true,
      },
      f.context,
    );
    execution = tool.execute(plan.input, f.context);
    const started = (await execution) as any;
    await expect
      .poll(
        async () => {
          try {
            pid = Number(await readFile(join(f.root, "pid"), "utf8"));
            return pid;
          } catch {
            return 0;
          }
        },
        { timeout: 8000 },
      )
      .toBeGreaterThan(0);
    f.host.signal.throwIfAborted();
    f.revokeScope();
    await f.drain();
    const sessions = contribution!.tools!.find(
      (t) => t.definition.id === "terminal_session",
    )!;
    expect(
      await sessions.execute(
        { action: "read", sessionId: started.sessionId },
        f.context,
      ),
    ).toMatchObject({ status: "cancelled", done: true });
    await expect
      .poll(
        () => {
          try {
            process.kill(pid!, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(false);
    pid = undefined;
  } finally {
    await f.close();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await execution;
  }
}, 20000);

it("does not propagate Electron/Node launch flags", () => {
  const old = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    expect(childEnvironment().NODE_ENV).toBeUndefined();
    expect(process.env.NODE_ENV).toBe("production");
  } finally {
    if (old === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = old;
  }
});
