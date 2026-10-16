import { usableTerminalLayout } from "./terminal-layout";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { frontend, usePluginSnapshot } from "@pal/plugin-sdk/react";
import type { TerminalOutputEvent, TerminalExitEvent } from "@pal/plugin-sdk";
import { operationErrorDetail } from "@pal/contracts";

function TerminalPanel() {
  const element = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState("");
  const { snapshot } = usePluginSnapshot();
  const startupError = (
    snapshot?.view.data as { startupError?: string } | undefined
  )?.startupError;
  const values =
    (snapshot?.view.data as { config?: Record<string, unknown> } | undefined)
      ?.config ?? {};
  useEffect(() => {
    if (!element.current || !snapshot) return;
    const readTheme = () => {
      const css = getComputedStyle(document.documentElement);
      return {
        background: css.getPropertyValue("--mu-page").trim() || "#101318",
        foreground: css.getPropertyValue("--mu-ink").trim() || "#e6e9ef",
        cursor: css.getPropertyValue("--mu-accent").trim() || "#e6e9ef",
        selectionBackground:
          css.getPropertyValue("--mu-soft").trim() || "#ffffff33",
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
      new WebLinksAddon(
        (_event, uri) =>
          void frontend()
            .webPreview.command({ type: "navigate", url: uri })
            .catch(() => {}),
      ),
    );
    const api = frontend().terminal;
    const commands = frontend().commands;
    const stopTheme = frontend().onThemeChanged(() => {
      terminal.options.theme = readTheme();
    });
    let id = "";
    let cursor = 0;
    let stopped = false;
    let exited = false;
    let fitFrame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let sentSize = "";
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
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        const host = element.current;
        if (
          stopped ||
          exited ||
          !host ||
          !usableTerminalLayout(host.clientWidth, host.clientHeight, terminal)
        )
          return;
        const size = `${terminal.cols}:${terminal.rows}`;
        if (size === sentSize) return;
        sentSize = size;
        void commands
          .execute("pal.terminal.resize", {
            tabId: id,
            cols: terminal.cols,
            rows: terminal.rows,
          })
          .catch((e) => {
            if (!stopped) {
              sentSize = "";
              setError(String(e));
            }
          });
      }, 120);
    };
    const fitVisible = () => {
      const host = element.current;
      if (
        !host ||
        !usableTerminalLayout(
          host.clientWidth,
          host.clientHeight,
          fit.proposeDimensions(),
        )
      )
        return;
      fit.fit();
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
    const stopOutput = api.onOutput(apply);
    const stopExit = api.onExit(exit);
    // Subscribe before replay to avoid losing output while attach is resolving.
    void (startupError ? Promise.reject(new Error(startupError)) : api.attach())
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
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        try {
          fitVisible();
        } catch {
          // Ignore transient layout states while the panel is moving.
        }
      });
    });
    const terminalResize = terminal.onResize(resizePty);
    observer.observe(element.current);
    terminal.focus();
    return () => {
      stopped = true;
      stopTheme();
      stopOutput();
      stopExit();
      // Surface disposal closes the PTY; navigation and renderer cleanup do not.
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalResize.dispose();
      input.dispose();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [Boolean(snapshot), startupError]);
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
    <main className="terminal-shell">
      <div ref={element} className="terminal-host" />
      {error && (
        <button
          className="terminal-retry"
          onClick={() => window.location.reload()}
        >
          {snapshot?.locale.startsWith("zh") ? "重试" : "Retry"}
        </button>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<TerminalPanel />);
