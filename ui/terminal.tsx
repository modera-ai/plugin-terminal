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
    const readTheme = () => {
      const css = getComputedStyle(document.documentElement);
      return ({
      background: css.getPropertyValue("--mu-page").trim() || "#101318",
      foreground: css.getPropertyValue("--mu-ink").trim() || "#e6e9ef",
      cursor: css.getPropertyValue("--mu-accent").trim() || "#e6e9ef",
      selectionBackground: css.getPropertyValue("--mu-soft").trim() || "#ffffff33",
    }); };
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
    const stopTheme = frontend().onChanged(() => { terminal.options.theme = readTheme(); });
    fit.fit();
    const initial = snapshot.view.data as {
      tabId?: string;
      terminal?: {
        raw?: string;
        baseOffset?: number;
        cursor?: number;
        nextCursor?: number;
        alive?: boolean;
        exitCode?: number | null;
      };
    };
    const id = String(initial.tabId || "");
    let cursor = Number(initial.terminal?.cursor ?? initial.terminal?.baseOffset ?? 0);
    let exited = false;
    const apply = (data: typeof initial) => {
      const value = data.terminal;
      if (!value) return;
      const base = Number(value.baseOffset || 0);
      const raw = String(value.raw || "");
      if (Number(value.nextCursor ?? base + raw.length) < cursor) return;
      if (cursor < base) {
        terminal.reset();
        cursor = base;
      }
      const offset = Math.max(0, cursor - Math.max(base, value.cursor ?? base));
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
      lastInput = performance.now();
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, 16);
      if (id)
        void frontend()
          .action("write", JSON.stringify({ data, cursor }))
          .then(next => { if (!stopped) apply(next.view.data as typeof initial); })
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
    let stopped = false;
    let polling = false;
    let lastInput = 0;
    let pollTimer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      let active = false;
      try {
        const next = await frontend().action("refresh", JSON.stringify({ cursor }));
        active = Boolean((next.view.data as typeof initial).terminal?.raw);
        if (!stopped) apply(next.view.data as typeof initial);
      } catch (e) { if (!stopped) setError(String(e)); }
      polling = false;
      if (!stopped) pollTimer = setTimeout(poll, document.hidden ? 500 : active || performance.now() - lastInput < 500 ? 40 : 250);
    };
    pollTimer = setTimeout(poll, 40);
    return () => {
      stopped = true;
      stopTheme();
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalResize.dispose();
      clearTimeout(pollTimer);
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
