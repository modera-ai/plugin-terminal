import { processHost } from "./process-host.mjs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  PluginContext,
  ToolContext,
  ToolContribution,
} from "@pal/plugin-sdk";
import { readPluginManifest } from "../../../../modera/modera-app/core/packages/plugin-host/src/testing";
const manifest=readPluginManifest(new URL("../../",import.meta.url));

/** Only supplies the SDK lifecycle contract; no dependency on host internals. */
export async function terminalFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "pal-terminal-test-")),
  );
  const lifetime = new AbortController();
  let scope = new AbortController();
  const tasks = new Set<Promise<void>>();
  const host: PluginContext = {
    ...processHost(() => AbortSignal.any([lifetime.signal, scope.signal])),
    pluginId: manifest.id,
    storagePath: root,
    grantedPermissions: new Set(manifest.permissions),
    signal: lifetime.signal,
    scopeSignal: () => scope.signal,
    runBackground: (_context, run) => {
      const signal = AbortSignal.any([lifetime.signal, scope.signal]);
      const task = Promise.resolve().then(() => run(signal));
      tasks.add(task);
      void task.finally(() => tasks.delete(task)).catch(() => {});
    },
  };
  const context: ToolContext = {
    projectId: "p",
    sessionId: "s",
    runId: "r",
    workspacePath: root,
    signal: new AbortController().signal,
  };
  const drain = () => Promise.all([...tasks]);
  return {
    root,
    host,
    context,
    drain,
    revokeScope() {
      scope.abort();
      scope = new AbortController();
    },
    async close() {
      lifetime.abort();
      scope.abort();
      await Promise.allSettled([...tasks]);
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    },
  };
}

export async function executePrepared(
  tool: ToolContribution,
  input: unknown,
  context: ToolContext,
) {
  const plan = await tool.prepare!(input, context);
  try {
    return await tool.execute(plan.input, context);
  } finally {
    plan.dispose?.();
  }
}

export function nodeCommand(script: string) {
  const argument = `eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())`;
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : `'"'"'`)}'`;
  return `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(argument)}`;
}
