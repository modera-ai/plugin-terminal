import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";
import type { TerminalOutputEvent, TerminalExitEvent } from "@modera/plugin-sdk";

function TerminalPanel() {
  const element = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState("");
  const { snapshot } = usePluginSnapshot();
  const values =
    (snapshot?.view.data as { config?: Record<string, unknown> } | undefined)
      ?.config ?? {};
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
    const api = frontend().terminal;
    const stopTheme = frontend().onThemeChanged(() => { terminal.options.theme = readTheme(); });
    fit.fit();
    let id = "";
    let cursor = 0;
    let stopped = false;
    let exited = false;
    const buffered: TerminalOutputEvent[] = [];
    let pendingExit: TerminalExitEvent | undefined;
    const apply = (event: TerminalOutputEvent) => {
      if (stopped) return;
      if (!id) {buffered.push(event);return;}
      if (event.id !== id) return;
      const offset = event.offset ?? cursor;
      const skip = Math.max(0,cursor-offset);
      if (skip < event.data.length) terminal.write(event.data.slice(skip));
      cursor = Math.max(cursor,offset+event.data.length);
    };
    const exit = (event: TerminalExitEvent) => {
      if (stopped) return;
      if (!id) {pendingExit=event;return;}
      if (event.id !== id || exited) return;
      exited = true;
      terminal.writeln(`\r\n[process exited with code ${event.exitCode}]`);
    };
    const stopOutput = api.onOutput(apply);
    const stopExit = api.onExit(exit);
    // Subscribe before replay to avoid losing output while attach is resolving.
    void api.attach().then(info => {
      if (stopped) {void api.close(info.id).catch(()=>{});return;}
      id = info.id;
      terminal.write(info.raw);
      cursor = info.nextCursor;
      for (const event of buffered.splice(0)) apply(event);
      if (pendingExit) exit(pendingExit);
      if (!info.alive) exit({id,exitCode:info.exitCode ?? -1});
      if (info.alive) void api.resize(id,terminal.cols,terminal.rows).catch(e=>setError(String(e)));
    }).catch(e => {if (!stopped) {buffered.length=0;setError(String(e));}});
    const input = terminal.onData((data) => {
      if (id && !exited) void api.write(id,data).catch(e=>{if(!stopped)setError(String(e));});
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
          void api.resize(id,cols,rows)
            .catch(() => {});
      }, 120);
    });
    observer.observe(element.current);
    terminal.focus();
    return () => {
      stopped = true;
      stopTheme();
      stopOutput();
      stopExit();
      if (id) void api.close(id).catch(()=>{});
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      if (resizeTimer) clearTimeout(resizeTimer);
      terminalResize.dispose();
      input.dispose();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [Boolean(snapshot)]);
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
