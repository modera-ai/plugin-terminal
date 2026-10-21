import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Contract fake for plugin business tests. Host policy is tested in the host repository. */
export function processHost(scope, createPty) {
  const items = new Map();
  const stop = (item) => {
    if (item.closed) return;
    item.closed = true;
    if (item.pty) item.pty.kill();
    else if (process.platform === "win32")
      spawn("taskkill.exe", ["/PID", String(item.child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    else {
      try {
        process.kill(-item.child.pid, "SIGKILL");
      } catch {}
    }
  };
  const snapshot = (item) => ({
    processId: item.id,
    mode: item.mode,
    pid: item.pty?.pid ?? item.child?.pid,
    cwd: item.cwd,
    status: item.status,
    baseCursor: 0,
    nextCursor: item.text.length,
    exit: item.exit,
  });
  const execute = async (context, id, input) => {
    if (id === "pal.process.start") {
      const signal = scope(context.projectId);
      signal.throwIfAborted();
      const item = {
        id: randomUUID(),
        mode: input.mode,
        cwd: input.cwd,
        text: "",
        status: "running",
        signal,
        closed: false,
        listeners: new Set(),
        exits: new Set(),
      };
      items.set(item.id, item);
      signal.addEventListener(
        "abort",
        () => {
          if (item.pty || item.child) stop(item);
          items.delete(item.id);
        },
        { once: true },
      );
      if (input.mode === "pty") {
        item.pty = await createPty(input);
        if (signal.aborted || context.signal.aborted) {
          stop(item);
          throw new Error("Process revoked");
        }
        item.pty.onData((data) => {
          const offset = item.text.length;
          item.text += data;
          for (const listener of item.listeners)
            listener({ id: item.id, data, offset });
        });
        item.pty.onExit(({ exitCode }) => {
          item.status = "exited";
          item.exit = { code: exitCode };
          for (const listener of item.exits)
            listener({ id: item.id, exitCode });
        });
      } else {
        const env = { ...process.env };
        delete env.NODE_ENV;
        delete env.NODE_OPTIONS;
        delete env.ELECTRON_RUN_AS_NODE;
        item.child = spawn(input.executable, input.args, {
          cwd: input.cwd,
          env,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
        item.child.stdout.setEncoding("utf8").on("data", (data) => {
          item.text += data;
        });
        item.child.stderr.setEncoding("utf8").on("data", (data) => {
          item.text += data;
        });
        item.child.stdin?.on("error", () => {});
        item.child.on("close", (code, signal) => {
          clearTimeout(item.timer);
          item.status = "exited";
          item.exit = { ...item.exit, code, signal };
        });
        await new Promise((resolve, reject) => {
          item.child.once("spawn", resolve);
          item.child.once("error", reject);
        });
        context.signal.addEventListener("abort", () => stop(item), {
          once: true,
        });
        if (input.timeoutMs)
          item.timer = setTimeout(() => {
            item.exit = { reason: "timeout" };
            stop(item);
          }, input.timeoutMs);
      }
      return snapshot(item);
    }
    const item = items.get(input.processId);
    if (!item) throw new Error("Process unavailable");
    item.signal.throwIfAborted();
    if (id === "pal.process.stop") {
      stop(item);
      return snapshot(item);
    }
    if (id === "pal.process.write") {
      (item.pty ?? item.child.stdin).write(input.data);
      return { accepted: true };
    }
    if (id === "pal.process.resize") {
      item.pty.resize(input.cols, input.rows);
      return input;
    }
    if (id === "pal.process.read") {
      if (item.status === "running" && input.cursor >= item.text.length)
        await new Promise((r) => setTimeout(r, 10));
      const text = item.text.slice(input.cursor, input.cursor + input.maxChars);
      return {
        ...snapshot(item),
        nextCursor: input.cursor + text.length,
        chunks: [{ stream: "stdout", data: text }],
        lostOutput: false,
        hasMore: input.cursor + text.length < item.text.length,
      };
    }
  };
  return {
    commands: (context) => ({
      execute: (id, input) => execute(context, id, input),
    }),
    processPort: (_context, id) => {
      const item = items.get(id);
      return {
        snapshot: () => ({
          id,
          shell: "fake",
          cwd: item.cwd,
          raw: item.text,
          baseOffset: 0,
          nextCursor: item.text.length,
          alive: item.status === "running",
          exitCode: item.exit?.code ?? null,
        }),
        subscribe: (output, exit) => {
          item.listeners.add(output);
          item.exits.add(exit);
          return () => {
            item.listeners.delete(output);
            item.exits.delete(exit);
          };
        },
        write: (data) => item.pty.write(data),
        resize: (cols, rows) => item.pty.resize(cols, rows),
        close: () => {
          stop(item);
          items.delete(id);
        },
      };
    },
  };
}
