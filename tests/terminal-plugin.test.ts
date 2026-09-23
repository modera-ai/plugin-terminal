import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readPluginManifest } from "@modera/plugin-host/testing";
import { activate } from "../src";
import { findShell, childEnvironment } from "../src/shell";
import { runCommand } from "../src/process";
import { ToolExecutor } from "@modera-host/agent-host/src/tool-executor";
import { ToolRegistry } from "@modera-host/agent-host/src/tool-registry";

import { AgentPluginRuntime as PluginRuntime } from "@modera/agent-host";

const manifest = readPluginManifest(new URL("..", import.meta.url));

function nodeCommand(script: string): string {
  // Avoid PowerShell 5 native argv quote rewriting in nested JavaScript strings.
  const argument = `eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())`;
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : `'"'"'`)}'`;
  return `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(argument)}`;
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

it(
  "requires approval before spawn and supports plugin disable during execution",
  () =>
    fixture(async (root) => {
      const registry = new ToolRegistry();
      const runtime = new PluginRuntime(
        registry,
        () => true,
        async () => root,
      );
      runtime.add({
        manifest,
        load: async () => ({ activate }),
      });
      await runtime.reconcile(new Set([manifest.id]));
      const context = {
        sessionId: "s",
        runId: "r",
        workspacePath: root,
        signal: new AbortController().signal,
      };
      const command = nodeCommand("require('fs').writeFileSync('marker','ok')");
      let allow = false;
      const executor = new ToolExecutor(
        registry,
        async (call) => {
          await expect(readFile(join(root, "marker"))).rejects.toThrow();
          expect(call.approvalPreview).toMatchObject({ cwd: root, command });
          return allow;
        },
        new Set(["process.spawn"]),
      );
      try {
        const call = {
          id: "c",
          name: "terminal_execute",
          input: { command, description: "写入测试标记" },
        };
        expect(JSON.parse(await executor.execute(call, context))).toMatchObject(
          {
            error: "PERMISSION_DENIED",
          },
        );
        allow = true;
        expect(
          JSON.parse(
            await executor.execute(call, { ...context, runId: "new-user-run" }),
          ).exitCode,
        ).toBe(0);
        expect(await readFile(join(root, "marker"), "utf8")).toBe("ok");
        const granted = new ToolExecutor(
          registry,
          async () => true,
          new Set(["process.spawn"]),
        );
        const descendant =
          "require('fs').writeFileSync('pid',String(process.pid));setInterval(()=>{},1000)";
        const result = granted.execute(
          {
            ...call,
            input: {
              description: "wait",
              command: nodeCommand(
                `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`,
              ),
            },
          },
          context,
        );
        let pid: number | undefined;
        for (let i = 0; i < 100; i++) {
          try {
            pid = Number(await readFile(join(root, "pid"), "utf8"));
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 50));
          }
        }
        expect(pid).toBeTruthy();
        await runtime.reconcile(new Set());
        expect(JSON.parse(await result).error).toBeTruthy();
        for (let i = 0; i < 80; i++) {
          try {
            process.kill(pid!, 0);
            await new Promise((r) => setTimeout(r, 50));
          } catch {
            pid = undefined;
            break;
          }
        }
        expect(pid).toBeUndefined();
        expect(granted.definitions(context)).toHaveLength(0);
      } finally {
        await runtime.close();
      }
    }),
  20000,
);

it("rejects out-of-project cwd before approval and hides schemas without a project/grant", () =>
  fixture(async (root) => {
    const contributions = await activate({
      pluginId: manifest.id,
      storagePath: root,
      grantedPermissions: new Set(manifest.permissions),
      signal: new AbortController().signal,
    });
    const registry = new ToolRegistry();
    registry.register(manifest.id, contributions!.tools![0]!);
    let approvals = 0;
    const executor = new ToolExecutor(
      registry,
      async () => {
        approvals++;
        return true;
      },
      new Set(["process.spawn"]),
    );
    const context = {
      workspacePath: root,
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    };
    const result = JSON.parse(
      await executor.execute(
        {
          id: "c",
          name: "terminal_execute",
          input: {
            command: "echo ok",
            description: "test",
            workingDirectory: "..",
          },
        },
        context,
      ),
    );
    expect(result.error).toContain("within the project");
    expect(approvals).toBe(0);
    expect(executor.definitions()).toHaveLength(0);
    expect(
      new ToolExecutor(registry, async () => true).definitions(context),
    ).toHaveLength(0);
  }));

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
