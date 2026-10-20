import React from "react";
import { AgentTerminalControlResult } from "@pal/ui";

/** Share operation receipts with the host fallback and UI previews. */
export function TerminalControlResult({ name, input, result, locale }: {
 name: string; input: unknown; result: unknown; locale: string;
}) {
 return <AgentTerminalControlResult name={name} input={input} value={result} zh={locale.startsWith("zh")} />;
}
