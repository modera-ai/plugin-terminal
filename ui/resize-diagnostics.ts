// Installed by the development host only; absent in normal product rendering.
const key = Symbol.for("pal.terminal.resize-diagnostics");
export function traceResize(stage: string, fields: Record<string, number>) {
  (
    globalThis as typeof globalThis & {
      [key]?: (stage: string, fields: Record<string, number>) => void;
    }
  )[key]?.(stage, fields);
}
