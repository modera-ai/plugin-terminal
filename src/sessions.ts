import manifest from "../plugin.json";
import { declaredTool } from "@pal/plugin-sdk";
import { randomUUID } from "node:crypto";
import type {
  PluginContext,
  ToolContext,
  ToolDefinition,
} from "@pal/plugin-sdk";
import { runCommand, type CommandResult } from "./process";
import { TerminalLogs, type LogWriter } from "./logs";

export const sessionDefinition = declaredTool(manifest, "terminal_session");
interface Job {
  completion: Promise<void>;
  finish: () => void;
  log?: LogWriter;
  logError?: string;
  expiresAt: number | null;
  id: string;
  owner: string;
  callId?: string;
  root?: string;
  project: string | undefined;
  command: string;
  cwd: string;
  pid?: number;
  notifyTimer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
  buffer: string;
  end: number;
  createdAt: number;
  result?: CommandResult;
  error?: string;
  done: boolean;
  stoppedBy?: "user" | "agent";
}
export class TerminalSessions {
  readonly logs: TerminalLogs;
  private jobs = new Map<string, Job>();
  constructor(private host: PluginContext) {
    this.logs = new TerminalLogs(host.storagePath);
    host.signal.addEventListener(
      "abort",
      () => {
        for (const job of this.jobs.values()) job.controller.abort();
      },
      { once: true },
    );
  }
  get active(): number {
    return [...this.jobs.values()].filter((job) => !job.done).length;
  }
  async start(
    shell: string,
    command: string,
    cwd: string,
    timeout: number,
    context: ToolContext,
  ) {
    if (!this.host.runBackground)
      throw new Error("Managed background runtime unavailable");
    if (this.active >= 2) throw new Error("Terminal concurrency limit reached");
    for (const [id, job] of this.jobs)
      if (
        job.done &&
        (Date.now() - job.createdAt > 1800000 || this.jobs.size >= 8)
      )
        this.jobs.delete(id);
    if (this.jobs.size >= 8) throw new Error("Terminal session limit reached");
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      completion,
      finish,
      expiresAt: Number.isFinite(timeout) ? Date.now() + timeout : null,
      id: randomUUID(),
      owner: context.sessionId,
      ...(context.toolCallId ? { callId: context.toolCallId } : {}),
      ...(context.workspacePath ? { root: context.workspacePath } : {}),
      project: context.projectId,
      command,
      cwd,
      controller: new AbortController(),
      buffer: "",
      end: 0,
      createdAt: Date.now(),
      done: false,
    };
    this.jobs.set(job.id, job);
    try {
      try {
        job.log = await this.logs.create(job.id, context);
      } catch (error) {
        job.logError = String(error);
      }
      context.signal.throwIfAborted();
      this.host.runBackground(
        { ...context, label: command },
        async (signal) => {
          try {
            const processCommands = this.host.commands?.({
              ...context,
              signal: AbortSignal.any([signal, job.controller.signal]),
            });
            job.result = await runCommand(
              shell,
              command,
              cwd,
              timeout,
              AbortSignal.any([signal, job.controller.signal]),
              (text) => {
                job.end += text.length;
                job.buffer = (job.buffer + text).slice(-32768);
                job.log?.append(text);
                this.changed(job);
              },
              (pid) => {
                job.pid = pid;
                this.changed(job);
              },
              undefined,
              Infinity, // Log capacity is not a process execution budget.
              processCommands,
            );
            if (job.stoppedBy && job.result.status === "cancelled")
              job.result = {
                ...job.result,
                reason: job.stoppedBy,
                stoppedBy: job.stoppedBy,
                message:
                  job.stoppedBy === "user"
                    ? "The user manually stopped this command. Do not automatically retry it."
                    : "The agent stopped this command.",
              };
          } catch (error) {
            job.error = String(error);
          } finally {
            try {
              await job.log?.close();
            } catch (error) {
              job.logError = String(error);
            }
            job.done = true;
            job.finish();
            this.changed(job);
          }
        },
      );
    } catch (error) {
      this.jobs.delete(job.id);
      await job.log?.close();
      throw error;
    }
    return {
      sessionId: job.id,
      logPath: job.log?.path,
      logError: job.logError,
      expiresAt: job.expiresAt,
      status: "running",
      command,
      cwd,
      shell,
      nextCursor: 0,
      output: "",
      outputBytes: 0,
      durationMs: 0,
      exitCode: null,
    };
  }
  /** Foreground calls await once and return the final bounded result, never a polling handle. */
  async complete(id: string, context: ToolContext) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== context.sessionId ||
      job.project !== context.projectId ||
      job.root !== context.workspacePath
    )
      throw new Error("Terminal session unavailable");
    let wake!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const abort = () => {
      job.controller.abort();
      wake();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      if (context.signal.aborted) abort();
      await Promise.race([job.completion, cancelled]);
      context.signal.throwIfAborted();
      return {
        ...(job.result ?? {
          status: "failed",
          error: job.error ?? "Command did not return a result",
        }),
        logPath: job.log?.path,
        logError: job.logError,
        logTruncated: job.log?.truncated,
      };
    } finally {
      context.signal.removeEventListener("abort", abort);
    }
  }
  private forCall(callId: string, context: ToolContext) {
    this.host.signal.throwIfAborted();
    context.signal.throwIfAborted();
    return [...this.jobs.values()].find(
      (job) =>
        job.callId === callId &&
        job.owner === context.sessionId &&
        job.project === context.projectId &&
        job.root === context.workspacePath,
    );
  }
  snapshotForCall(callId: string, context: ToolContext) {
    const job = this.forCall(callId, context);
    return job ? this.snapshot(job.id, context) : undefined;
  }
  stopForCall(callId: string, context: ToolContext) {
    const job = this.forCall(callId, context);
    if (!job) throw new Error("Terminal command unavailable");
    return this.execute({ action: "stop", sessionId: job.id }, context, "user");
  }
  execute(
    raw: unknown,
    context: ToolContext,
    stopSource: "user" | "agent" = "agent",
  ) {
    this.host.signal.throwIfAborted();
    const input = raw as {
      action: string;
      sessionId?: string;
      cursor?: number;
    };
    if (input.action === "logs") return this.logs.list(context);
    if (input.action === "read_log")
      return this.logs.read(input.sessionId ?? "", input.cursor ?? 0, context);
    const visible = (job: Job) =>
      job.owner === context.sessionId && job.project === context.projectId;
    const summary = (job: Job) => ({
      sessionId: job.id,
      logPath: job.log?.path,
      logError: job.logError ?? job.log?.error,
      logTruncated: job.log?.truncated,
      expiresAt: job.expiresAt,
      command: job.command,
      status: job.error ? "failed" : (job.result?.status ?? "running"),
      exitCode: job.result?.exitCode ?? null,
      stoppedBy: job.result?.stoppedBy ?? job.stoppedBy,
      reason: job.result?.reason ?? job.stoppedBy,
      message: job.result?.message,
    });
    if (input.action === "list")
      return { sessions: [...this.jobs.values()].filter(visible).map(summary) };
    const job = this.jobs.get(input.sessionId ?? "");
    if (!job || !visible(job)) throw new Error("Terminal session unavailable");
    if (input.action === "stop") {
      if (!job.done && !job.controller.signal.aborted)
        job.stoppedBy = stopSource;
      job.controller.abort();
      return {
        ...summary(job),
        status: job.done ? summary(job).status : "stopping",
      };
    }
    if (input.action !== "read") throw new Error("Invalid terminal action");
    const cursor = input.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.end)
      throw new Error("Invalid output cursor");
    const base = job.end - job.buffer.length;
    const start = Math.max(cursor, base);
    const output = job.buffer.slice(start - base, start - base + 3000);
    return {
      ...summary(job),
      output,
      outputBytes: job.result?.outputBytes ?? Buffer.byteLength(job.buffer),
      durationMs: job.result?.durationMs ?? Date.now() - job.createdAt,
      nextCursor: start + output.length,
      lostOutput: cursor < base,
      hasMore: start + output.length < job.end,
      done: job.done,
      ...(job.error ? { error: job.error } : {}),
    };
  }
  private changed(job: Job) {
    if (job.notifyTimer) return;
    job.notifyTimer = setTimeout(() => {
      delete job.notifyTimer;
      this.host.invalidateUi?.(job.owner);
    }, 500);
    job.notifyTimer.unref();
  }
  snapshot(id: string, context: ToolContext) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== context.sessionId ||
      job.project !== context.projectId
    )
      return undefined;
    return {
      sessionId: job.id,
      logPath: job.log?.path,
      logError: job.logError ?? job.log?.error,
      logTruncated: job.log?.truncated,
      expiresAt: job.expiresAt,
      command: job.command,
      cwd: job.cwd,
      pid: job.pid,
      status: job.error ? "failed" : (job.result?.status ?? "running"),
      done: job.done,
      output: job.error ?? job.buffer.slice(-6000),
      exitCode: job.result?.exitCode ?? null,
      stoppedBy: job.result?.stoppedBy ?? job.stoppedBy,
      reason: job.result?.reason ?? job.stoppedBy,
      message: job.result?.message,
    };
  }
}
