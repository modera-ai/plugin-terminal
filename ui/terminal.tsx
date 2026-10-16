import { usableTerminalLayout } from "./terminal-layout";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import React from "react";
// @ts-expect-error Host renderer bundles CSS as text.
import css from "./terminal.css";
// @ts-expect-error Host renderer bundles CSS as text.
import xtermCss from "@xterm/xterm/css/xterm.css";
import type { PluginFrontendApi, PluginSurfaceSnapshot } from "@pal/contracts";
import type { TerminalOutputEvent, TerminalExitEvent } from "@pal/plugin-sdk";
import { operationErrorDetail } from "@pal/contracts";

export default function TerminalPanel({
  api,
  snapshot,
}: {
  api: Pick<PluginFrontendApi, "commands"> & {
    terminal: Pick<
      PluginFrontendApi["terminal"],
      "attach" | "onOutput" | "onExit"
    >;
  };
  snapshot: PluginSurfaceSnapshot;
}) {
  const element = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const themeRef = useRef(snapshot.theme);
  themeRef.current = snapshot.theme;
  const startupError = (
    snapshot?.view.data as { startupError?: string } | undefined
  )?.startupError;
  const values =
    (snapshot?.view.data as { config?: Record<string, unknown> } | undefined)
      ?.config ?? {};
  useEffect(() => {
    if (!element.current || !snapshot) return;
    const readTheme = () => {
      const theme = themeRef.current;
      return {
        background: theme?.colors?.page || "#101318",
        foreground: theme?.colors?.ink || "#e6e9ef",
        cursor: theme?.accent || "#e6e9ef",
        selectionBackground: theme?.colors?.soft || "#ffffff33",
      };
    };
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: String(
        values.fontFamily ?? "Cascadia Mono, Consolas, monospace",
      ),
      fontSize: Number(values.fontSize ?? 13),
      lineHeight: Number(values.lineHeight ?? 1.2),
      scrollback: Number(values.scrollback ?? 5000),
      theme: readTheme(),
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    if (values.gpuRendering !== false) {
      try {
        terminal.loadAddon(new WebglAddon());
      } catch {
        // Canvas rendering remains available when WebGL cannot initialize.
      }
    }
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    const stream = api.terminal;
    const commands = api.commands;
    setError("");
    let id = "";
    let cursor = 0;
    let stopped = false;
    let exited = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let sentSize = "";
    let resizingPty = false;
    let desiredSize: { cols: number; rows: number } | undefined;
    const flushPtySize = () => {
      const host = element.current;
      if (
        stopped ||
        exited ||
        !id ||
        !host ||
        resizingPty ||
        resizeTimer ||
        !desiredSize ||
        !usableTerminalLayout(host.clientWidth, host.clientHeight, desiredSize)
      )
        return;
      const { cols, rows } = desiredSize;
      const size = `${cols}:${rows}`;
      if (size === sentSize) return;
      resizingPty = true;
      let succeeded = false;
      void commands
        .execute("pal.terminal.resize", { tabId: id, cols, rows })
        .then(() => {
          sentSize = size;
          succeeded = true;
        })
        .catch((e) => {
          if (!stopped) setError(String(e));
        })
        .finally(() => {
          resizingPty = false;
          // A newer size is eligible only after its own quiet period ends.
          if (succeeded) flushPtySize();
        });
    };
    const resizePty = () => {
      const host = element.current;
      if (
        stopped ||
        exited ||
        !id ||
        !host ||
        !usableTerminalLayout(host.clientWidth, host.clientHeight, terminal)
      )
        return;
      if (
        desiredSize?.cols === terminal.cols &&
        desiredSize.rows === terminal.rows
      )
        return;
      desiredSize = { cols: terminal.cols, rows: terminal.rows };
      if (resizeTimer) clearTimeout(resizeTimer);
      // ConPTY can repaint the entire screen on resize. Like Snow, update the
      // local terminal immediately but notify the shell only after dragging settles.
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        flushPtySize();
      }, 120);
    };
    const fitVisible = () => {
      const host = element.current;
      const dimensions = fit.proposeDimensions();
      if (
        !host ||
        !usableTerminalLayout(
          host.clientWidth,
          host.clientHeight,
          dimensions,
        ) ||
        !dimensions
      )
        return;
      if (
        terminal.cols !== dimensions.cols ||
        terminal.rows !== dimensions.rows
      )
        // FitAddon.fit clears the render layer before resizing; the public API
        // already handles resize/reflow without that additional blank frame.
        terminal.resize(dimensions.cols, dimensions.rows);
      // Also synchronize when xterm's default size already equals the measured size.
      resizePty();
    };
    fitVisible();
    const buffered: TerminalOutputEvent[] = [];
    let pendingExit: TerminalExitEvent | undefined;
    const apply = (event: TerminalOutputEvent) => {
      if (stopped) return;
      if (!id) {
        buffered.push(event);
        return;
      }
      if (event.id !== id) return;
      const offset = event.offset ?? cursor;
      const skip = Math.max(0, cursor - offset);
      if (skip < event.data.length) terminal.write(event.data.slice(skip));
      cursor = Math.max(cursor, offset + event.data.length);
    };
    const exit = (event: TerminalExitEvent) => {
      if (stopped) return;
      if (!id) {
        pendingExit = event;
        return;
      }
      if (event.id !== id || exited) return;
      exited = true;
      terminal.writeln(`\r\n[process exited with code ${event.exitCode}]`);
    };
    const stopOutput = stream.onOutput(apply);
    const stopExit = stream.onExit(exit);
    // Subscribe before replay to avoid losing output while attach is resolving.
    void (
      startupError ? Promise.reject(new Error(startupError)) : stream.attach()
    )
      .then((info) => {
        if (stopped) return;
        id = info.id;
        terminal.write(info.raw);
        cursor = info.nextCursor;
        for (const event of buffered.splice(0)) apply(event);
        if (pendingExit) exit(pendingExit);
        if (!info.alive) exit({ id, exitCode: info.exitCode ?? -1 });
        if (info.alive) fitVisible();
      })
      .catch((e) => {
        if (!stopped) {
          buffered.length = 0;
          setError(`[Terminal] failed to start: ${operationErrorDetail(e)}`);
        }
      });
    const input = terminal.onData((data) => {
      if (id && !exited)
        void commands
          .execute("pal.terminal.input", { tabId: id, data })
          .catch((e) => {
            if (!stopped) setError(String(e));
          });
    });
    const observer = new ResizeObserver(() => {
      if (
        !element.current ||
        element.current.clientWidth === 0 ||
        element.current.clientHeight === 0
      )
        return;
      try {
        // ResizeObserver runs before paint. A second animation-frame hop would
        // expose a frame with the old terminal geometry inside the resized panel.
        fitVisible();
      } catch {
        // Ignore transient layout states while the panel is moving.
      }
    });
    const terminalResize = terminal.onResize(resizePty);
    observer.observe(element.current);
    terminal.focus();
    return () => {
      stopped = true;
      stopOutput();
      stopExit();
      // Surface disposal closes the PTY; navigation and renderer cleanup do not.
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalResize.dispose();
      input.dispose();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [api, startupError, retry]);
  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme = {
        background: snapshot.theme?.colors?.page || "#101318",
        foreground: snapshot.theme?.colors?.ink || "#e6e9ef",
        cursor: snapshot.theme?.accent || "#e6e9ef",
        selectionBackground: snapshot.theme?.colors?.soft || "#ffffff33",
      };
  }, [snapshot.theme]);
  useEffect(() => {
    if (error)
      terminalRef.current?.writeln(
        `\r\n\x1b[31m${operationErrorDetail(error).replace(/\n/g, "\r\n")}\x1b[0m`,
      );
  }, [error]);
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options = {
      fontFamily: String(
        values.fontFamily ?? "Cascadia Mono, Consolas, monospace",
      ),
      fontSize: Number(values.fontSize ?? 13),
      lineHeight: Number(values.lineHeight ?? 1.2),
      scrollback: Number(values.scrollback ?? 5000),
    };
  }, [
    values.fontFamily,
    values.fontSize,
    values.lineHeight,
    values.scrollback,
  ]);
  return (
    <main
      className="terminal-shell"
      style={
        {
          "--mu-page": snapshot.theme?.colors?.page,
          "--mu-ink": snapshot.theme?.colors?.ink,
          "--mu-line": snapshot.theme?.colors?.line,
        } as React.CSSProperties
      }
    >
      <style>
        {xtermCss + css.replace(/html,\s*body,\s*#root,/g, ":host,")}
      </style>
      <div ref={element} className="terminal-host" />
      {error && (
        <button
          className="terminal-retry"
          onClick={() => setRetry((value) => value + 1)}
        >
          {snapshot?.locale.startsWith("zh") ? "重试" : "Retry"}
        </button>
      )}
    </main>
  );
}
