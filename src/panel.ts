import manifest from "../plugin.json";
import {
  operationErrorDetail,
  type PluginCommandDeclaration,
} from "@pal/contracts";
import type {
  PluginRegistration,
  PluginUiRequest,
  ToolContext,
} from "@pal/plugin-sdk";
import type { TerminalControl } from "./control";

/** One registration source; stream output remains on the existing PTY port. */
export function registerTerminalPanel(
  pal: PluginRegistration,
  control: TerminalControl,
) {
  for (const definition of manifest.declarations.provides.commands) {
    pal.commands.register({
      ...(definition as PluginCommandDeclaration),
      inputSchema: definition.inputSchema,
      requiredPermissions: definition.requiredPermissions,
      run(input, execution) {
        const value = input as Record<string, unknown>;
        const context = execution.context;
        switch (definition.id) {
          case "pal.terminal.open":
            return control.open(
              value as Parameters<TerminalControl["open"]>[0],
              context,
            );
          case "pal.terminal.send":
            return control.send(
              value as Parameters<TerminalControl["send"]>[0],
              context,
            );
          case "pal.terminal.read":
            return control.read(
              value as Parameters<TerminalControl["read"]>[0],
              context,
            );
          case "pal.terminal.resize":
            return control.resize(value as never, context);
          case "pal.terminal.wait":
            return control.wait(
              value as Parameters<TerminalControl["wait"]>[0],
              context,
            );
          case "pal.terminal.close":
            return control.close(
              value as Parameters<TerminalControl["close"]>[0],
              context,
            );
          case "pal.terminal.focus":
            return control.focus(value as never, context);
          case "pal.terminal.list":
            return control.list(context);
          case "pal.terminal.input":
            control.writeRaw(String(value.tabId), String(value.data), context);
            return { ok: true };
          default:
            throw new Error("Unknown terminal command");
        }
      },
    });
  }
  if (!pal.context.resourcePath) return;
  const tabs = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  const resourceTab = (request: PluginUiRequest) => {
    try {
      return String(JSON.parse(request.resource || "{}").tabId || "");
    } catch {
      return "";
    }
  };
  const key = (request: PluginUiRequest, context: ToolContext) =>
    JSON.stringify([
      context.projectId,
      context.sessionId,
      context.workspacePath,
      request.resource ?? "",
    ]);
  const ensureTab = async (request: PluginUiRequest, context: ToolContext) => {
    const explicit = resourceTab(request);
    if (explicit) {
      control.read({ tabId: explicit }, context);
      return explicit;
    }
    const scope = key(request, context);
    const existing = tabs.get(scope);
    if (
      existing &&
      control.list(context).terminals.some((tab) => tab.tabId === existing)
    )
      return existing;
    const started = pending.get(scope);
    if (started) return started;
    const opening = control
      .open({}, context, false, request.resource)
      .then((tab) => {
        tabs.set(scope, tab.tabId);
        return tab.tabId;
      });
    pending.set(scope, opening);
    try {
      return await opening;
    } finally {
      if (pending.get(scope) === opening) pending.delete(scope);
    }
  };
  pal.context.signal.addEventListener(
    "abort",
    () => {
      tabs.clear();
      pending.clear();
    },
    { once: true },
  );
  pal.ui.register({
    id: "pal.terminal.panel",
    slot: "ui.panel",
    scope: "conversation",
    frontend: "terminal",
    nativeCapabilities: ["terminal"],
    requiredPermissions: ["process.spawn"],
    commands: ["input", "resize", "close", "read", "list"].map(
      (name) => `pal.terminal.${name}`,
    ),
    launcher: {
      multiple: true,
      title: "Terminal",
      description:
        "Keep this terminal bound to its opening conversation and directory",
      icon: "terminal",
      locales: {
        "zh-CN": {
          title: "终端",
          description: "保留打开时会话和目录的交互终端",
        },
      },
    },
    bindTerminal(request, context) {
      const tabId = resourceTab(request) || tabs.get(key(request, context));
      if (!tabId) throw new Error("Terminal tab unavailable");
      return control.port(tabId, context);
    },
    async render(request, context) {
      const title = `${request.locale.startsWith("zh") ? "终端" : "Terminal"} · ${context.projectId ?? "independent"} / ${context.sessionId.slice(0, 8)}`;
      const binding = {
        projectId: context.projectId,
        sessionId: context.sessionId,
        root: context.workspacePath,
      };
      try {
        const tabId = await ensureTab(request, context);
        return {
          title,
          data: {
            tabId,
            binding,
            cwd: control.read({ tabId }, context).cwd,
            config:
              (await pal.context.config?.read(context.projectId))?.values ?? {},
          },
          children: [],
        };
      } catch (error) {
        return {
          title,
          data: {
            binding,
            startupError: operationErrorDetail(error),
            cwd: context.workspacePath,
            config: {},
          },
          children: [],
        };
      }
    },
  });
}
