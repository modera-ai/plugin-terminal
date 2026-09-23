import manifest from "../plugin.json";
import { declaredTool, declaredTools } from "@modera/plugin-sdk";
import type {
  PluginModule,
  PluginUiContribution,
  ToolContext,
  ToolContribution,
} from "@modera/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  findAgentShell,
  terminalConfiguration,
  workingDirectory,
} from "./shell";
import { terminalUi } from "./ui";
import { TerminalSessions, sessionDefinition } from "./sessions";
import { sessionUi } from "./session-ui";
import { InteractiveCommands } from "./interactive";
import { TerminalControl } from "./control";

const definition = declaredTool(manifest, "terminal_execute");
interface Plan {
  yieldTimeMs: number;
  interactive: boolean;
  background: boolean;
  command: string;
  cwd: string;
  shell: string;
  timeout: number;
  description: string;
  session: string;
  project: string | undefined;
  root: string;
}
export const activate: PluginModule["activate"] = async (host) => {
  const sessions = new TerminalSessions(host);
  const interactive = new InteractiveCommands(host);
  const control = new TerminalControl(host);
  const controlDefinitions = new Map(
    declaredTools(manifest)
      .filter((item) => item.id.startsWith("terminal_"))
      .map((item) => [item.id, item]),
  );
  const panelTabs = new Map<string, string>();
  const panelUi: PluginUiContribution | undefined = host.resourcePath
    ? {
        id: "modera.terminal.panel",
        slot: "panel",
        frontend: "terminal",
        nativeCapabilities: ["terminal"],
        requiredPermissions: ["process.spawn"],
        launcher: {
          multiple: true,
          title: "Terminal",
          description: "Open an interactive shell in the project",
          icon: "terminal",
          locales: {
            "zh-CN": { title: "终端", description: "在项目中打开交互式 Shell" },
          },
        },
        actions: ["refresh", "write", "resize", "close"],
        async render(request, context) {
          const panelKey = `${context.sessionId}:${request.resource || "default"}`;
          let tabId = "";
          try {
            tabId = String(JSON.parse(request.resource || "{}").tabId || "");
          } catch {
            /* new manual panel */
          }
          tabId ||= panelTabs.get(panelKey) || "";
          if (!tabId) tabId = (await control.open({}, context, false)).tabId;
          panelTabs.set(panelKey, tabId);
          const terminal = control.read({ tabId, cursor: 0 }, context);
          return {
            title: request.locale.startsWith("zh") ? "终端" : "Terminal",
            data: {
              tabId,
              terminal,
              cwd: context.workspacePath,
              config:
                (await host.config?.read(context.projectId))?.values ?? {},
            },
            children: [],
          };
        },
        async act(action, context, request) {
          const panelKey = `${context.sessionId}:${request.resource || "default"}`;
          let tabId = "";
          try {
            tabId = String(JSON.parse(request.resource || "{}").tabId || "");
          } catch {
            /* launcher resource */
          }
          tabId ||= panelTabs.get(panelKey) || "";
          if (!tabId) throw new Error("Terminal tab unavailable");
          const value = action.value ? JSON.parse(action.value) : {};
          if (action.id === "refresh") return;
          if (action.id === "write")
            control.writeRaw(tabId, String(value.data || ""), context);
          else if (action.id === "resize")
            control.resize(
              { tabId, cols: Number(value.cols), rows: Number(value.rows) },
              context,
            );
          else if (action.id === "close")
            await control.close({ tabId }, context, false);
          else throw new Error("Unknown terminal panel action");
        },
      }
    : undefined;
  const plans = new Map<string, Plan>();
  let running = 0;
  host.signal.addEventListener("abort", () => plans.clear(), { once: true });
  const prepare = async (raw: unknown, context: ToolContext) => {
    const input = raw as {
      command: string;
      description: string;
      workingDirectory?: string;
      timeout?: number;
      yieldTimeMs?: number;
      background?: boolean;
      interactive?: boolean;
    };
    const configuration = terminalConfiguration(
      (await host.config?.read(context.projectId))?.values,
    );
    const shell = await findAgentShell(configuration);
    if (!shell || !context.workspacePath)
      throw new Error("Terminal unavailable");
    if (!input.command?.trim() || input.command.includes("\0"))
      throw new Error("Invalid command");
    if (input.interactive && input.background)
      throw new Error("interactive and background cannot be combined");
    if (plans.size >= 8) throw new Error("Too many pending terminal approvals");
    const cwd = await workingDirectory(
      context.workspacePath,
      input.workingDirectory,
    );
    if (!input.interactive && !host.runBackground)
      throw new Error("Managed background runtime unavailable");
    context.signal.throwIfAborted();
    if (plans.size >= 8) throw new Error("Too many pending terminal approvals");
    const plan: Plan = {
      yieldTimeMs: input.yieldTimeMs ?? 10000,
      interactive: input.interactive === true,
      background: input.background === true,
      command: input.command,
      description: input.description,
      cwd,
      shell,
      timeout: input.timeout ?? (input.interactive ? 1800000 : Infinity),
      session: context.sessionId,
      project: context.projectId,
      root: context.workspacePath,
    };
    const token = randomUUID();
    plans.set(token, plan);
    return {
      input: { token },
      executionTimeoutMs: plan.interactive ? plan.timeout + 5000 : 60000,
      preview: {
        command: plan.command,
        description: plan.description,
        cwd,
        shell,
        timeout: Number.isFinite(plan.timeout) ? plan.timeout : null,
        yieldTimeMs: plan.yieldTimeMs,
        background: plan.background,
        interactive: plan.interactive,
      },
      dispose: () => {
        plans.delete(token);
      },
    };
  };
  return {
    settings: {
      actions: ["detect"],
      async act(action) {
        if (action.id !== "detect") throw new Error("Unknown settings action");
        const { detectTerminalOptions, detectWslDistributions } =
          await import("./terminal-detection");
        return {
          shells: await detectTerminalOptions(),
          distributions: await detectWslDistributions(),
        };
      },
    },
    ui: [
      ...terminalUi(sessions, interactive),
      sessionUi(),
      ...(panelUi ? [panelUi] : []),
    ],
    tools: [
      {
        definition,
        isAvailable: (context) => !!context.workspacePath,
        prepare,
        async execute(raw, context) {
          const token = (raw as { token?: string }).token ?? "";
          const plan = plans.get(token);
          plans.delete(token);
          if (
            !plan ||
            plan.session !== context.sessionId ||
            plan.project !== context.projectId ||
            plan.root !== context.workspacePath
          )
            throw new Error("Invalid terminal approval");
          if (running + sessions.active >= 2)
            throw new Error("Terminal concurrency limit reached");
          running++;
          try {
            if ((await workingDirectory(plan.root, plan.cwd)) !== plan.cwd)
              throw new Error("Working directory changed since approval");
            context.signal.throwIfAborted();
            if (plan.interactive)
              return await interactive.execute(
                plan.shell,
                plan.command,
                plan.description,
                plan.cwd,
                plan.timeout,
                context,
              );
            const started = await sessions.start(
              plan.shell,
              plan.command,
              plan.cwd,
              plan.timeout,
              context,
            );
            if (plan.background) return started;
            return {
              ...started,
              ...(await sessions.wait(
                started.sessionId,
                context,
                plan.yieldTimeMs,
              )),
            };
          } finally {
            running--;
          }
        },
      },
      {
        definition: sessionDefinition,
        isAvailable: (context) =>
          !!context.workspacePath && !!host.runBackground,
        async execute(input, context) {
          return sessions.execute(input, context);
        },
      },
      ...[
        "terminal_open",
        "terminal_send",
        "terminal_read",
        "terminal_resize",
        "terminal_wait",
        "terminal_close",
        "terminal_focus",
        "terminal_list",
      ].map((id): ToolContribution => ({
        definition: controlDefinitions.get(id)!,
        isAvailable: (context) => !!context.workspacePath && !!host.panels,
        async execute(input, context) {
          switch (id) {
            case "terminal_open":
              return control.open(input as never, context);
            case "terminal_send":
              return control.send(input as never, context);
            case "terminal_read": {
              const value = input as {
                tabId?: string;
                waitMs?: number;
                cursor?: number;
              };
              if (value.waitMs)
                await new Promise((resolve) =>
                  setTimeout(resolve, Math.min(60000, value.waitMs!)),
                );
              return control.read(value, context);
            }
            case "terminal_resize":
              return control.resize(input as never, context);
            case "terminal_wait":
              return control.wait(input as never, context);
            case "terminal_close":
              return control.close(input as never, context);
            case "terminal_focus":
              return control.focus(input as never, context);
            case "terminal_list":
              return control.list(context);
            default:
              throw new Error("Unknown terminal control tool");
          }
        },
      })),
    ],
  };
};
