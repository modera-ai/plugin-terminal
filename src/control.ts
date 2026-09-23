import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { PluginContext, ToolContext } from "@modera/plugin-sdk";
import {
  childEnvironment,
  terminalConfiguration,
  workingDirectory,
} from "./shell";
import { detectTerminalOptions } from "./terminal-detection";

const MAX_BUFFER = 1_000_000;
const PANEL_ID = "modera.terminal.panel";
const keys: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  backspace: "\x7f",
  esc: "\x1b",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+z": "\x1a",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

interface ControlledTerminal {
  id: string;
  ownerSession: string;
  projectId: string | undefined;
  process: pty.IPty;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  raw: string;
  plain: string;
  baseOffset: number;
  revision: number;
  delivered: number;
  updatedAt: number;
  alive: boolean;
  exitCode: number | null;
}

export interface OpenTerminalInput {
  cwd?: string;
  shellPath?: string;
  cols?: number;
  rows?: number;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\r(?!\n)/g, "");
}

export class TerminalControl {
  private sessions = new Map<string, ControlledTerminal>();
  private focused = new Map<string, string>();
  constructor(private host: PluginContext) {
    host.signal.addEventListener("abort", () => this.dispose(), { once: true });
  }
  private scope(context: ToolContext) {
    return `${context.sessionId}:${context.projectId ?? ""}`;
  }
  private owned(context: ToolContext, requested?: string): ControlledTerminal {
    const id =
      !requested || requested === "current"
        ? this.focused.get(this.scope(context))
        : requested;
    const terminal = id ? this.sessions.get(id) : undefined;
    if (
      !terminal ||
      terminal.ownerSession !== context.sessionId ||
      terminal.projectId !== context.projectId
    )
      throw new Error("Terminal tab unavailable; call terminal_open first");
    return terminal;
  }
  private metadata(item: ControlledTerminal, context: ToolContext) {
    return {
      tabId: item.id,
      title: item.title,
      cwd: item.cwd,
      shellPath: item.shell,
      cols: item.cols,
      rows: item.rows,
      active: this.focused.get(this.scope(context)) === item.id,
      alive: item.alive,
      exitCode: item.exitCode,
    };
  }
  private async shell(input: OpenTerminalInput, context: ToolContext) {
    const config = terminalConfiguration(
      (await this.host.config?.read(context.projectId))?.values,
    );
    let shell = input.shellPath?.trim() || config.integratedShell;
    if (!shell || shell === "auto")
      shell = (await detectTerminalOptions())[0]?.path ?? "";
    if (!shell) throw new Error("No terminal shell was detected");
    if (shell.includes("/") || shell.includes("\\"))
      await access(shell, constants.X_OK);
    return { shell, config };
  }
  async open(input: OpenTerminalInput, context: ToolContext, show = true) {
    if (!context.workspacePath)
      throw new Error("Terminal requires a project workspace");
    const scoped = [...this.sessions.values()].filter(
      (item) =>
        item.ownerSession === context.sessionId &&
        item.projectId === context.projectId,
    );
    if (scoped.length >= 8)
      throw new Error("At most 8 terminal tabs may be open");
    const cwd = await workingDirectory(context.workspacePath, input.cwd || ".");
    const { shell, config } = await this.shell(input, context);
    const cols = Math.max(2, Math.min(500, Math.floor(input.cols ?? 100)));
    const rows = Math.max(1, Math.min(300, Math.floor(input.rows ?? 30)));
    const name = basename(shell).toLowerCase();
    const isWsl = name === "wsl.exe" || name === "wsl";
    const args = isWsl
      ? [
          ...(config.wslDistribution
            ? ["--distribution", config.wslDistribution]
            : []),
          "--cd",
          cwd,
        ]
      : process.platform === "win32"
        ? name.includes("bash")
          ? ["--login"]
          : []
        : ["-l"];
    const env = Object.fromEntries(
      Object.entries(childEnvironment()).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const processHandle = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      ...(!isWsl ? { cwd } : {}),
      env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      useConpty: process.platform === "win32",
    });
    const item: ControlledTerminal = {
      id: randomUUID(),
      ownerSession: context.sessionId,
      projectId: context.projectId,
      process: processHandle,
      title: basename(shell),
      shell,
      cwd,
      cols,
      rows,
      raw: "",
      plain: "",
      baseOffset: 0,
      revision: 0,
      delivered: 0,
      updatedAt: Date.now(),
      alive: true,
      exitCode: null,
    };
    this.sessions.set(item.id, item);
    this.focused.set(this.scope(context), item.id);
    processHandle.onData((data) => {
      const combined = item.raw + data;
      const removed = Math.max(0, combined.length - MAX_BUFFER);
      item.raw = combined.slice(-MAX_BUFFER);
      item.baseOffset += removed;
      item.plain = stripAnsi(item.raw);
      item.revision++;
      item.updatedAt = Date.now();
      this.host.invalidateUi?.(item.ownerSession);
    });
    processHandle.onExit(({ exitCode }) => {
      item.alive = false;
      item.exitCode = exitCode;
      item.revision++;
      item.updatedAt = Date.now();
      this.host.invalidateUi?.(item.ownerSession);
    });
    if (show) await this.show(item, context);
    return this.metadata(item, context);
  }
  async show(item: ControlledTerminal, context: ToolContext) {
    if (!this.host.panels) throw new Error("Terminal panel host unavailable");
    this.focused.set(this.scope(context), item.id);
    await this.host.panels.open(
      PANEL_ID,
      JSON.stringify({ tabId: item.id }),
      context,
    );
  }
  send(
    input: { tabId?: string; input?: string; keys?: string[] },
    context: ToolContext,
  ) {
    const item = this.owned(context, input.tabId);
    const textMode = typeof input.input === "string" && input.input.length > 0;
    const keyMode = Array.isArray(input.keys) && input.keys.length > 0;
    if (textMode === keyMode)
      throw new Error("Provide exactly one of input or keys");
    if (!item.alive) throw new Error("Terminal process has exited");
    let data = textMode
      ? input.input!
      : input.keys!.map((key) => keys[key.toLowerCase()] ?? key).join("");
    if (keyMode && input.keys!.length > 64)
      throw new Error("keys accepts at most 64 entries");
    if (textMode && !/[\r\n]$/.test(data)) data += "\r";
    item.process.write(data);
    this.focused.set(this.scope(context), item.id);
    return { ok: true, tabId: item.id };
  }
  read(input: { tabId?: string; cursor?: number }, context: ToolContext) {
    const item = this.owned(context, input.tabId);
    const requested = Math.max(0, Math.floor(input.cursor ?? item.baseOffset));
    const start = Math.max(0, requested - item.baseOffset);
    const raw = item.raw.slice(start);
    const nextCursor = item.baseOffset + item.raw.length;
    return {
      ...this.metadata(item, context),
      text: stripAnsi(raw),
      raw,
      baseOffset: item.baseOffset,
      cursor: requested,
      nextCursor,
      lostOutput: requested < item.baseOffset,
      revision: item.revision,
    };
  }
  writeRaw(tabId: string, data: string, context: ToolContext) {
    const item = this.owned(context, tabId);
    if (!item.alive) throw new Error("Terminal process has exited");
    item.process.write(data);
  }
  resize(
    input: { tabId?: string; cols: number; rows: number },
    context: ToolContext,
  ) {
    const item = this.owned(context, input.tabId);
    const cols = Math.max(2, Math.min(500, Math.floor(input.cols)));
    const rows = Math.max(1, Math.min(300, Math.floor(input.rows)));
    if (!Number.isFinite(cols) || !Number.isFinite(rows))
      throw new Error("Invalid terminal dimensions");
    item.process.resize(cols, rows);
    item.cols = cols;
    item.rows = rows;
    return this.metadata(item, context);
  }
  async wait(
    input: { tabId?: string; timeoutMs?: number; idleMs?: number },
    context: ToolContext,
  ) {
    const item = this.owned(context, input.tabId);
    const timeoutMs = Math.max(1000, Math.floor(input.timeoutMs ?? 30000));
    const idleMs = Math.max(
      100,
      Math.min(5000, Math.floor(input.idleMs ?? 500)),
    );
    const started = Date.now();
    let revision = item.revision;
    let quiet = Date.now();
    while (item.alive && Date.now() - started < timeoutMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, idleMs)),
      );
      context.signal.throwIfAborted();
      if (revision !== item.revision) {
        revision = item.revision;
        quiet = Date.now();
      }
      if (Date.now() - quiet >= idleMs) break;
    }
    const text = item.plain.slice(item.delivered);
    item.delivered = item.plain.length;
    return {
      ...this.metadata(item, context),
      text,
      timedOut: item.alive && Date.now() - started >= timeoutMs,
    };
  }
  async close(input: { tabId?: string }, context: ToolContext, hide = true) {
    const item = this.owned(context, input.tabId);
    this.kill(item);
    const remaining = [...this.sessions.values()].filter(
      (value) =>
        value.ownerSession === context.sessionId &&
        value.projectId === context.projectId,
    );
    const next = remaining.at(-1)?.id;
    if (next) this.focused.set(this.scope(context), next);
    else this.focused.delete(this.scope(context));
    if (hide)
      await this.host.panels?.close(
        PANEL_ID,
        JSON.stringify({ tabId: item.id }),
        context,
      );
    return { ok: true, tabId: item.id, activeTabId: next ?? null };
  }
  async focus(input: { tabId: string }, context: ToolContext) {
    const item = this.owned(context, input.tabId);
    await this.show(item, context);
    return this.metadata(item, context);
  }
  list(context: ToolContext) {
    const scope = this.scope(context);
    return {
      activeTabId: this.focused.get(scope) ?? null,
      terminals: [...this.sessions.values()]
        .filter(
          (item) =>
            item.ownerSession === context.sessionId &&
            item.projectId === context.projectId,
        )
        .map((item) => this.metadata(item, context)),
    };
  }
  output(tabId: string, cursor: number, context: ToolContext) {
    return this.read({ tabId, cursor }, context);
  }
  private kill(item: ControlledTerminal) {
    this.sessions.delete(item.id);
    if (item.alive)
      try {
        item.process.kill();
      } catch {
        /* exited */
      }
  }
  dispose() {
    for (const item of [...this.sessions.values()]) this.kill(item);
    this.focused.clear();
  }
}
