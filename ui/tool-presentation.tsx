import { TerminalControlResult } from "./control-result";
import { terminalToolTarget } from "./tool-target";
import React, { useEffect, useState } from "react";
import { AgentTerminal, ToolExecution, type AgentTerminalData } from "@pal/ui";
interface Props {
  context: {
    locale: string;
    tool: {
      name: string;
      input: unknown;
      result?: string;
      phase: "approval" | "result";
    };
  };
  presentation: {
    state: "running" | "done" | "failed" | "interrupted";
    open: boolean;
    onOpenChange(open: boolean): void;
    fallback: React.ReactNode;
  };
  api: {
    signal: AbortSignal;
    command: { execute<T>(id: string, input: unknown): Promise<T> };
    onInvalidate(listener: () => void): () => void;
  };
}
export default function TerminalPresentation({
  context,
  presentation,
  api,
}: Props) {
  const [view, setView] = useState<{
    title: string;
    kind?: "command" | "control";
    data: AgentTerminalData;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true,
      sequence = 0;
    const refresh = async () => {
      const selected = ++sequence;
      try {
        const value = await api.command.execute<{
          title: string;
          kind?: "command" | "control";
          data: AgentTerminalData;
        }>("pal.terminal.presentation.read", {});
        if (alive && selected === sequence && !api.signal.aborted) {
          setView(value);
          setError("");
        }
      } catch (error) {
        if (alive && !api.signal.aborted) setError(String(error));
      }
    };
    void refresh();
    const stop = api.onInvalidate(() => {
      void refresh();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [api]);
  if (error && !view) throw new Error(error);
  if (!view) return <>{presentation.fallback}</>;
  const locale = context.locale.startsWith("zh") ? "zh" : "en";
  if (context.tool.phase === "approval")
    return <AgentTerminal data={view.data} locale={locale} />;
  const act = async (action: string, value?: string) => {
    setBusy(true);
    setError("");
    try {
      await api.command.execute("pal.terminal.presentation.act", {
        action,
        ...(value === undefined ? {} : { value }),
      });
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      if (!api.signal.aborted) setBusy(false);
    }
  };
  return (
    <ToolExecution
      className="terminal-tool-presentation"
      kind="terminal"
      name={context.tool.name}
      title={view.title}
      target={terminalToolTarget(
        context.tool.name,
        context.tool.input,
        view.data,
        locale,
      )}
      state={presentation.state}
      input={context.tool.input}
      output={view.data}
      tone="slate"
      locale={locale}
      open={presentation.open}
      onOpenChange={presentation.onOpenChange}
      awaitingInput={!!view.data.inputReady}
    >
      {view.kind === "control" ? (
        <TerminalControlResult
          name={context.tool.name}
          input={context.tool.input}
          result={view.data}
          locale={locale}
        />
      ) : (
        <AgentTerminal
          data={view.data}
          busy={busy}
          error={error}
          locale={locale}
          onAction={act}
        />
      )}
    </ToolExecution>
  );
}
