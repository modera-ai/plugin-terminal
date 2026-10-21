import type {
  PluginContext,
  ToolContext,
  ProcessSnapshot,
} from "@pal/plugin-sdk";

export interface HostPty {
  processId: string;
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
}
/** Terminal business state observes the host resource; it never owns a raw PTY. */
export async function createHostPty(
  host: PluginContext,
  context: ToolContext,
  input: {
    executable: string;
    args: string[];
    cwd: string;
    cols: number;
    rows: number;
  },
): Promise<HostPty> {
  const commands = host.commands?.(context);
  if (!commands || !host.processPort)
    throw new Error("Host process commands unavailable");
  const resource = (await commands.execute("pal.process.start", {
    ...input,
    mode: "pty",
    scope: "session",
  })) as ProcessSnapshot;
  let port;
  try {
    port = host.processPort(context, resource.processId);
  } catch (error) {
    await commands
      .execute("pal.process.stop", { processId: resource.processId })
      .catch(() => {});
    throw error;
  }
  const data = new Set<(data: string) => void>();
  const exits = new Set<(event: { exitCode: number }) => void>();
  const dispose = port.subscribe(
    (event) => {
      for (const listener of data) listener(event.data);
    },
    (event) => {
      for (const listener of exits) listener(event);
    },
  );
  // Early output between start and subscription is replayed once after control subscribes.
  const initial = port.snapshot();
  let replay = true;
  return {
    processId: resource.processId,
    pid: resource.pid ?? 0,
    write: (value) => port.write(value),
    resize: (cols, rows) => port.resize(cols, rows),
    kill: () => {
      dispose();
      port.close?.();
      data.clear();
      exits.clear();
    },
    onData: (listener) => {
      data.add(listener);
      if (replay) {
        replay = false;
        queueMicrotask(() => {
          if (data.has(listener) && initial.raw) listener(initial.raw);
        });
      }
      return {
        dispose: () => {
          data.delete(listener);
        },
      };
    },
    onExit: (listener) => {
      exits.add(listener);
      if (!initial.alive)
        queueMicrotask(() => {
          if (exits.has(listener))
            listener({ exitCode: initial.exitCode ?? -1 });
        });
      return {
        dispose: () => {
          exits.delete(listener);
        },
      };
    },
  };
}
