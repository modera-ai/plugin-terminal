import { expect, it } from "vitest";
import { usableTerminalLayout } from "../ui/terminal-layout";
it("rejects hidden views and FitAddon minimum placeholders without shrinking the existing terminal", () => {
  for (const [width, height, size] of [
    [0, 400, { cols: 80, rows: 24 }],
    [600, 0, { cols: 80, rows: 24 }],
    [1, 1, { cols: 2, rows: 1 }],
    [600, 400, { cols: 2, rows: 24 }],
    [600, 400, { cols: 80, rows: 1 }],
    [600, 400, undefined],
  ] as const)
    expect(usableTerminalLayout(width, height, size)).toBe(false);
});
it("allows real layout and subsequent visible resizes", () => {
  expect(usableTerminalLayout(640, 400, { cols: 80, rows: 24 })).toBe(true);
  expect(usableTerminalLayout(1000, 600, { cols: 120, rows: 35 })).toBe(true);
});
