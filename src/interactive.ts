import type { PluginContext, ToolContext } from "@pal/plugin-sdk";
import { runCommand, type CommandResult } from "./process";

interface Command {
  owner: string;
  project: string | undefined;
  root: string | undefined;
  command: string;
  description: string;
  cwd: string;
  controller: AbortController;
  output: string;
  pid?: number;
  inputCount: number;
  stoppedByUser?: boolean;
  write?: (text: string) => Promise<void>;
  result?: CommandResult;
  timer?: ReturnType<typeof setTimeout>;
}
/** A foreground operation stays pending; manual input never re-enters the model loop. */
export class InteractiveCommands {
  private commands = new Map<string, Command>();
  private finished = new Map<string, Command>();
  constructor(private host: PluginContext) {
    host.signal.addEventListener("abort", () => this.finished.clear(), {
      once: true,
    });
  }
  private key(context: ToolContext, callId: string) {
    return JSON.stringify([context.sessionId, callId]);
  }
  private get(callId: string, context: ToolContext) {
    this.host.signal.throwIfAborted();
    const key = this.key(context, callId);
    const command = this.commands.get(key) ?? this.finished.get(key);
    if (
      !command ||
      command.project !== context.projectId ||
      command.root !== context.workspacePath
    )
      throw new Error("Interactive command unavailable");
    return command;
  }
  private changed(command: Command) {
    if (command.timer || this.host.signal.aborted) return;
    command.timer = setTimeout(() => {
      delete command.timer;
      this.host.invalidateUi?.(command.owner);
    }, 500);
    command.timer.unref();
  }
  snapshot(callId: string, context: ToolContext) {
    const command = this.get(callId, context);
    if (command.result)
      return {
        ...command.result,
        description: command.description,
        interactive: true,
        inputReady: false,
      };
    return {
      command: command.command,
      description: command.description,
      cwd: command.cwd,
      pid: command.pid,
      output: command.output,
      interactive: true,
      status: "running",
      inputCount: command.inputCount,
      inputReady: !!command.write && !command.controller.signal.aborted,
    };
  }
  /** The UI may render before execute has registered the interactive process. */
  snapshotIfAvailable(callId: string, context: ToolContext) {
    this.host.signal.throwIfAborted();
    const key = this.key(context, callId);
    if (!this.commands.has(key) && !this.finished.has(key)) return undefined;
    // Existing commands still require the normal project/workspace ownership checks.
    return this.snapshot(callId, context);
  }
  async act(
    callId: string,
    action: string,
    value: string | undefined,
    context: ToolContext,
  ) {
    context.signal.throwIfAborted();
    const command = this.get(callId, context);
    if (command.result)
      throw new Error("Interactive command already completed");
    if (action === "stop") {
      command.stoppedByUser = true;
      command.controller.abort();
      this.changed(command);
      return;
    }
    if (
      action !== "input" ||
      !command.write ||
      command.controller.signal.aborted
    )
      throw new Error("Terminal input unavailable");
    if (
      typeof value !== "string" ||
      value.length > 3999 ||
      /[\r\n\0]/.test(value)
    )
      throw new Error("Expected one input line");
    await command.write(value + "\n");
    command.inputCount++;
    this.changed(command);
  }
  async execute(
    shell: string,
    command: string,
    description: string,
    cwd: string,
    timeout: number,
    context: ToolContext,
  ) {
    if (!context.toolCallId)
      throw new Error("Interactive execution requires kernel call identity");
    const key = this.key(context, context.toolCallId);
    if (this.commands.has(key))
      throw new Error("Interactive command already running");
    const entry: Command = {
      owner: context.sessionId,
      project: context.projectId,
      root: context.workspacePath,
      command,
      description,
      cwd,
      controller: new AbortController(),
      output: "",
      inputCount: 0,
    };
    this.commands.set(key, entry);
    this.host.invalidateUi?.(context.sessionId);
    try {
      const processCommands = this.host.commands?.(context);
      const result = await runCommand(
        shell,
        command,
        cwd,
        timeout,
        AbortSignal.any([
          context.signal,
          this.host.signal,
          entry.controller.signal,
        ]),
        (text) => {
          entry.output = (entry.output + text).slice(-16000);
          this.changed(entry);
        },
        (pid) => {
          entry.pid = pid;
          this.changed(entry);
        },
        (write) => {
          entry.write = write;
          this.changed(entry);
        },
        4 * 1024 * 1024,
        processCommands,
      );
      entry.result =
        entry.stoppedByUser && result.status === "cancelled"
          ? {
              ...result,
              reason: "user",
              stoppedBy: "user",
              message:
                "The user manually stopped this command. Do not automatically retry it.",
            }
          : result;
      return { ...entry.result, description, interactive: true };
    } finally {
      clearTimeout(entry.timer);
      this.commands.delete(key);
      delete entry.write;
      if (entry.result && !this.host.signal.aborted) {
        if (this.finished.size >= 8)
          this.finished.delete(this.finished.keys().next().value!);
        this.finished.set(key, entry);
      }
      this.host.invalidateUi?.(context.sessionId);
    }
  }
}
