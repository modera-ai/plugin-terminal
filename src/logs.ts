import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  mkdir,
  readdir,
  open,
  lstat,
  unlink,
} from "@pal/plugin-sdk/workspace-fs";
import { join } from "@pal/plugin-sdk/workspace-path";
import type { ToolContext } from "@pal/plugin-sdk";

const limit = 4 * 1024 * 1024;
const logName = /^[a-f0-9]{24}-[a-f0-9-]{36}\.log$/;
const prefix = (context: ToolContext) =>
  createHash("sha256")
    .update(JSON.stringify([context.projectId, context.sessionId]))
    .digest("hex")
    .slice(0, 24);
function boundary(buffer: Buffer): Buffer {
  for (let trim = 0; trim < 4; trim++) {
    const part = buffer.subarray(0, buffer.length - trim);
    if (isUtf8(part)) return part;
  }
  throw new Error("Invalid UTF-8 log boundary");
}
export interface LogWriter {
  path: string;
  readonly error: string | undefined;
  readonly truncated: boolean;
  append(text: string): void;
  close(): Promise<void>;
}
/** Background output: 4 MiB per file, 64 files, seven-day retention. */
export class TerminalLogs {
  private readonly active = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  constructor(storagePath: string) {
    this.directory = join(storagePath, "logs");
  }
  private async ready() {
    await mkdir(this.directory, { recursive: true });
    if ((await lstat(this.directory)).isSymbolicLink())
      throw new Error("Log directory must not be a symlink");
  }
  private path(id: string, context: ToolContext) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    )
      throw new Error("Invalid log ID");
    return join(this.directory, `${prefix(context)}-${id}.log`);
  }
  async create(id: string, context: ToolContext): Promise<LogWriter> {
    const operation = this.queue.then(async () => {
      context.signal.throwIfAborted();
      await this.ready();
      const path = this.path(id, context);
      const entries = await Promise.all(
        (await readdir(this.directory))
          .filter((name) => logName.test(name))
          .map(async (name) => {
            const candidate = join(this.directory, name);
            const info = await lstat(candidate);
            return {
              path: candidate,
              modified: info.mtimeMs,
              valid: info.isFile() && !info.isSymbolicLink(),
            };
          }),
      );
      if (entries.some((entry) => entry.path === path))
        throw new Error("Log already exists");
      let count = entries.length;
      for (const entry of entries.sort(
        (a, b) => a.modified - b.modified || a.path.localeCompare(b.path),
      )) {
        if (!entry.valid || this.active.has(entry.path)) continue;
        if (count < 64 && Date.now() - entry.modified < 7 * 24 * 60 * 60 * 1000)
          continue;
        await unlink(entry.path);
        count--;
      }
      if (count >= 64)
        throw new Error(
          "Terminal log quota reached: no inactive logs can be removed",
        );
      const file = await open(path, "wx", 0o600);
      this.active.add(path);
      const active = this.active;
      let bytes = 0,
        closed = false;
      let writes = Promise.resolve();
      let error: unknown;
      let truncated = false;
      return {
        get truncated() {
          return truncated;
        },
        path,
        get error() {
          return error ? String(error) : undefined;
        },
        append(text: string) {
          if (bytes + Buffer.byteLength(text) > limit) truncated = true;
          if (closed || bytes >= limit || error) return;
          const data = boundary(Buffer.from(text).subarray(0, limit - bytes));
          bytes += data.length;
          writes = writes
            .then(async () => {
              if (!error) await file.writeFile(data);
            })
            .catch((cause) => {
              error = cause;
            });
        },
        async close() {
          if (closed) return;
          closed = true;
          try {
            await writes;
            await file.close();
          } finally {
            active.delete(path);
          }
          if (error) throw error;
        },
      };
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async list(context: ToolContext) {
    await this.ready();
    const names = (await readdir(this.directory)).filter(
      (name) => logName.test(name) && name.startsWith(prefix(context) + "-"),
    );
    const logs = await Promise.all(
      names.map(async (name) => {
        const path = join(this.directory, name);
        const info = await lstat(path);
        return {
          id: name.slice(25, -4),
          path,
          modifiedAt: info.mtime.toISOString(),
          valid: info.isFile() && !info.isSymbolicLink(),
        };
      }),
    );
    return {
      logs: logs
        .filter((log) => log.valid)
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        .map(({ valid: _valid, ...log }) => log),
    };
  }
  async read(id: string, cursor: number, context: ToolContext) {
    context.signal.throwIfAborted();
    await this.ready();
    const path = this.path(id, context);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error("Invalid log file");
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > metadata.size ||
      metadata.size > limit
    )
      throw new Error("Invalid log cursor or size");
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(12000, metadata.size - cursor));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor);
      const data = boundary(buffer.subarray(0, bytesRead));
      return {
        logId: id,
        logPath: path,
        output: data.toString("utf8"),
        nextCursor: cursor + data.length,
        hasMore: cursor + data.length < metadata.size,
        sizeBytes: metadata.size,
        limitBytes: limit,
      };
    } finally {
      await file.close();
    }
  }
}
