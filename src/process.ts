import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { childEnvironment, spawnCommand } from "./shell";

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

/** Best-effort tree cleanup. Detached grandchildren/WSL are not an OS sandbox. */
function stopTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      killer.kill();
      child.kill();
    }, 2000);
    timer.unref();
    killer.once("error", () => {
      clearTimeout(timer);
      child.kill();
    });
    killer.once("close", () => clearTimeout(timer));
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
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
): Promise<CommandResult> {
  signal.throwIfAborted();
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const target = spawnCommand(shell, command, cwd, !!onInput);
    const child = spawn(target.executable, target.args, {
      cwd: target.cwd,
      env: childEnvironment(),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [onInput ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let status: CommandResult["status"] = "completed";
    let prefix = "",
      tail = "",
      chars = 0,
      bytes = 0,
      settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      code: number | null,
      exitSignal: string | null,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
      child.stdout?.destroy();
      child.stdin?.destroy();
      child.stderr?.destroy();
      if (error) {
        reject(error);
        return;
      }
      const truncated = chars > 3000;
      resolve({
        command,
        cwd,
        shell,
        exitCode: code,
        signal: exitSignal,
        status,
        output: truncated
          ? `${prefix}\n… [output truncated] …\n${tail}`
          : prefix + tail,
        outputBytes: bytes,
        truncated,
        durationMs: Math.round(performance.now() - started),
      });
    };
    const stop = (reason: CommandResult["status"]) => {
      if (status !== "completed" || settled) return;
      status = reason;
      stopTree(child);
      deadline = setTimeout(() => finish(null, null), 3000);
    };
    const cancel = () => stop("cancelled");
    const timer = Number.isFinite(timeout)
      ? setTimeout(() => stop("timed_out"), timeout)
      : undefined;
    const receive = (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      const clean = stripVTControlCharacters(chunk).replace(
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
        "",
      );
      chars += clean.length;
      onOutput?.(clean);
      const needed = Math.max(0, 1500 - prefix.length);
      prefix += clean.slice(0, needed);
      tail = (tail + clean.slice(needed)).slice(-1500);
      if (bytes > outputLimit) stop("output_limit");
    };
    child.stdout?.setEncoding("utf8").on("data", receive);
    child.stderr?.setEncoding("utf8").on("data", receive);
    child.once("error", (error) => finish(null, null, error));
    child.once("spawn", () => {
      if (child.pid) onSpawn?.(child.pid);
      onInput?.(
        (text) =>
          new Promise<void>((resolve, reject) => {
            if (settled || !child.stdin?.writable) {
              reject(new Error("Terminal input closed"));
              return;
            }
            child.stdin.write(text, "utf8", (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
    });
    child.stdin?.on("error", () => {
      /* Individual writes report errors via their callback. */
    });
    child.once("close", (code, exitSignal) => finish(code, exitSignal));
    // Parent exit with inherited pipes must not leave this foreground call waiting forever.
    child.once("exit", () => {
      if (!settled && !deadline)
        deadline = setTimeout(() => {
          stopTree(child);
          finish(child.exitCode, child.signalCode);
        }, 1000);
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
