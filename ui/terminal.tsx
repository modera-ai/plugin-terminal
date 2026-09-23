import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";

function TerminalPanel() {
  const element = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState("");
  const { snapshot } = usePluginSnapshot();
  const values =
    (snapshot?.view.data as { config?: Record<string, unknown> } | undefined)
      ?.config ?? {};
  const integratedShell = String(values.integratedShell ?? "auto");
  useEffect(() => {
    if (!element.current || !snapshot) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: String(
        values.fontFamily ?? "Cascadia Mono, Consolas, monospace",
      ),
      fontSize: Number(values.fontSize ?? 13),
      lineHeight: Number(values.lineHeight ?? 1.2),
      scrollback: Number(values.scrollback ?? 5000),
      theme: {
        background: "#101318",
        foreground: "#e6e9ef",
        cursor: "#e6e9ef",
        selectionBackground: "#ffffff33",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
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
    terminal.open(element.current);
    fit.fit();
    const initial = snapshot.view.data as {
      tabId?: string;
      terminal?: {
        raw?: string;
        baseOffset?: number;
        nextCursor?: number;
        alive?: boolean;
        exitCode?: number | null;
      };
    };
    const id = String(initial.tabId || "");
    let cursor = Number(initial.terminal?.baseOffset || 0);
    let exited = false;
    const apply = (data: typeof initial) => {
      const value = data.terminal;
      if (!value) return;
      const base = Number(value.baseOffset || 0);
      const raw = String(value.raw || "");
      if (cursor < base) {
        terminal.reset();
        cursor = base;
      }
      const offset = Math.max(0, cursor - base);
      if (offset < raw.length) terminal.write(raw.slice(offset));
      cursor = Number(value.nextCursor ?? base + raw.length);
      if (!value.alive && !exited) {
        exited = true;
        terminal.writeln(
          `\r\n[process exited with code ${value.exitCode ?? "?"}]`,
        );
      }
    };
    apply(initial);
    const input = terminal.onData((data) => {
      if (id)
        void frontend()
          .action("write", JSON.stringify({ data }))
          .catch((e) => setError(String(e)));
    });
    let fitFrame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
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
          fit.fit();
        } catch {
          // Ignore transient layout states while the panel is moving.
        }
      });
    });
    const terminalResize = terminal.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        if (id)
          void frontend()
            .action("resize", JSON.stringify({ cols, rows }))
            .catch(() => {});
      }, 120);
    });
    observer.observe(element.current);
    terminal.focus();
    const poll = setInterval(() => {
      void frontend()
        .action("refresh")
        .then((next) => apply(next.view.data as typeof initial))
        .catch((e) => setError(String(e)));
    }, 250);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalResize.dispose();
      clearInterval(poll);
      input.dispose();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [Boolean(snapshot), integratedShell]);
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
      {error && <div className="terminal-error">{error}</div>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<TerminalPanel />);
