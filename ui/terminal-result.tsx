import React from "react";
import { AgentTerminal, ToolExecution, parseToolOutput, type AgentTerminalData } from "@modera/ui";
import type { PluginToolRendererProps } from "@modera/plugin-sdk";
export default function TerminalResult({ call, result, state, title, locale, open, onOpenChange, data, busy, error, act }: PluginToolRendererProps) {
  const snapshot = data as AgentTerminalData | undefined;
  const value = snapshot ?? (result ? parseToolOutput(result) as AgentTerminalData : undefined);
  if (value?.approval) return <AgentTerminal data={value} locale={locale} />;
  return <ToolExecution kind="terminal" name={call.name} title={title} state={state} input={call.input} output={result ? parseToolOutput(result) : undefined} tone="slate" locale={locale} open={open} onOpenChange={onOpenChange} awaitingInput={state !== "failed" && state !== "interrupted" && !!value?.inputReady && !!act}>
    {value ? <AgentTerminal data={value} busy={busy || state === "failed" || state === "interrupted"} error={error} locale={locale} onAction={act} /> : error ? <p role="alert">{error}</p> : null}
  </ToolExecution>;
}
