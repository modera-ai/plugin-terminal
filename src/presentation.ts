import manifest from "../pal-manifest.json";
import type { PluginRegistration } from "@pal/plugin-sdk";
import {
  localizeMetadata,
  type PluginCommandDeclaration,
  type ToolDefinition,
} from "@pal/contracts";
import type { TerminalSessions } from "./sessions";
import type { InteractiveCommands } from "./interactive";

export function registerTerminalPresentation(
  pal: PluginRegistration,
  sessions: TerminalSessions,
  interactive: InteractiveCommands,
) {
  for (const item of manifest.declarations.consumes.slots)
    pal.slots.contribute(item);
  for (const definition of manifest.declarations.provides.commands.filter((c) =>
    c.id.startsWith("pal.terminal.presentation."),
  )) {
    pal.command.register({
      ...(definition as PluginCommandDeclaration),
      inputSchema: definition.inputSchema,
      requiredPermissions: definition.requiredPermissions,
      async run(input, { request, context }) {
        if (
          !request.tool ||
          !manifest.tools.some((tool) => tool.id === request.tool!.name)
        )
          throw new Error("Terminal presentation binding required");
        const approval = !!request.approvalId;
        if (definition.id.endsWith(".act")) {
          if (approval || request.tool.name !== "terminal_execute")
            throw new Error("Read-only presentation");
          const action = input as { action: "stop" | "input"; value?: string };
          if (
            request.toolCallId &&
            (request.tool.input as { interactive?: boolean })?.interactive &&
            request.tool.result === undefined
          ) {
            await interactive.act(
              request.toolCallId,
              action.action,
              action.value,
              context,
            );
          } else {
            if (action.action !== "stop") throw new Error("Action unavailable");
            if (request.tool.result === undefined && request.toolCallId) {
              sessions.stopForCall(request.toolCallId, context);
              return { ok: true };
            }
            const data = JSON.parse(request.tool.result ?? "null");
            sessions.execute(
              { action: "stop", sessionId: data?.sessionId },
              context,
              "user",
            );
          }
          return { ok: true };
        }
        const tool = manifest.tools.find(
          (item) => item.id === request.tool!.name,
        )!;
        const title = localizeMetadata(
          tool as ToolDefinition,
          request.locale ?? "zh-CN",
        ).title;
        if (
          !["terminal_execute", "terminal_session"].includes(request.tool.name)
        ) {
          if (approval)
            throw new Error("Control tool approval uses host arguments");
          return {
            title,
            kind: "control",
            data: JSON.parse(request.tool.result ?? "{}"),
          };
        }
        const value = request.tool.input as {
          description?: string;
          command?: string;
          interactive?: boolean;
        };
        const pending = !approval && request.tool.result === undefined;
        const liveInteractive =
          pending && value?.interactive && request.toolCallId
            ? interactive.snapshotIfAvailable(request.toolCallId, context)
            : undefined;
        const liveForeground =
          pending && !value?.interactive && request.toolCallId
            ? sessions.snapshotForCall(request.toolCallId, context)
            : undefined;
        const data = pending
          ? (liveInteractive ??
            liveForeground ?? {
              description: value?.description,
              command: value?.command,
              cwd: context.workspacePath,
              status: "running",
              output: "",
              interactive: value?.interactive === true,
              inputReady: false,
            })
          : JSON.parse(request.tool.result ?? "null");
        if (!data || data.error)
          throw new Error("Terminal presentation unavailable");
        const current = data.sessionId
          ? sessions.snapshot(data.sessionId, context)
          : undefined;
        return {
          title,
          kind: "command",
          live:
            (!!pending && data.status === "running") ||
            (!!current && !current.done),
          data: {
            ...data,
            ...(current ?? {}),
            approval,
            inputReady: !!pending && !!data.interactive && !!data.inputReady,
            canStop:
              (!!liveInteractive && liveInteractive.status === "running") ||
              (!!current && !current.done),
            unavailable: !!data.sessionId && !current,
          },
        };
      },
    });
  }
}
