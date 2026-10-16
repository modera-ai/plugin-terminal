import type { ProcessSnapshot, ProcessReadResult } from "@pal/plugin-sdk";
import { stripVTControlCharacters } from "node:util";
import { spawnCommand } from "./shell";
export interface CommandResult {
  reason?: "user" | "agent";
  stoppedBy?: "user" | "agent";
  message?: string;
  command: string;
  cwd: string;
  shell: string;
  exitCode: number | null;
  signal: string | null;
  status: "completed" | "timed_out" | "cancelled" | "output_limit";
  output: string;
  outputBytes: number;
  truncated: boolean;
  durationMs: number;
}

export async function runCommand(
  shell: string,
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
  onOutput?: (text: string) => void,
  onSpawn?: (pid: number) => void,
  onInput?: (write: (text: string) => Promise<void>) => void,
  outputLimit = 4 * 1024 * 1024,
  commands?: { execute(id: string, input: unknown): Promise<unknown> },
): Promise<CommandResult> {
  signal.throwIfAborted();
  if (!commands) throw new Error("Host process commands unavailable");
  const started = performance.now();
  const target = spawnCommand(shell, command, cwd, !!onInput);
  const resource = (await commands.execute("process.start", {
    mode: "pipe",
    executable: target.executable,
    args: target.args,
    cwd,
    stdin: !!onInput,
    scope: "session",
    ...(Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
  })) as ProcessSnapshot;
  if (resource.pid) onSpawn?.(resource.pid);
  onInput?.(async (data) => {
    await commands.execute("process.write", {
      processId: resource.processId,
      data,
    });
  });
  let cursor = 0,
    prefix = "",
    tail = "",
    chars = 0,
    bytes = 0,
    lostOutput = false;
  let status: CommandResult["status"] = "completed";
  const stop = () => {
    void commands
      .execute("process.stop", { processId: resource.processId })
      .catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    for (;;) {
      const result = (await commands.execute("process.read", {
        processId: resource.processId,
        cursor,
        maxChars: 65536,
        waitMs: 1000,
      })) as ProcessReadResult;
      cursor = result.nextCursor;
      if (result.lostOutput) {
        lostOutput = true;
        onOutput?.("\n[output omitted: host buffer advanced]\n");
      }
      for (const chunk of result.chunks) {
        bytes += Buffer.byteLength(chunk.data);
        const clean = stripVTControlCharacters(chunk.data).replace(
          /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
          "",
        );
        chars += clean.length;
        onOutput?.(clean);
        const needed = Math.max(0, 1500 - prefix.length);
        prefix += clean.slice(0, needed);
        tail = (tail + clean.slice(needed)).slice(-1500);
      }
      if (bytes > outputLimit && status === "completed") {
        status = "output_limit";
        stop();
      }
      if (signal.aborted) {
        status = "cancelled";
        stop();
      }
      if (result.status !== "exited" || result.hasMore) continue;
      if (result.exit?.reason === "timeout") status = "timed_out";
      else if (signal.aborted) status = "cancelled";
      const truncated = chars > 3000 || lostOutput;
      return {
        command,
        cwd,
        shell,
        exitCode: result.exit?.code ?? null,
        signal: result.exit?.signal ?? null,
        status,
        output: truncated
          ? `${prefix}\n… [output truncated] …\n${tail}`
          : prefix + tail,
        outputBytes: bytes,
        truncated,
        durationMs: Math.round(performance.now() - started),
      };
    }
  } catch (error) {
    if (!signal.aborted) throw error;
    return {
      command,
      cwd,
      shell,
      exitCode: null,
      signal: null,
      status: "cancelled",
      output: prefix + tail,
      outputBytes: bytes,
      truncated: chars > 3000,
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
