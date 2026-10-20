import { expect, it } from "vitest";
import { resolveTerminalKeys } from "../src/terminal-keys";
it("supports all Ctrl letters and Control aliases on any platform", () => {
  for (let i = 1; i <= 26; i++) {
    const letter = String.fromCharCode(96 + i);
    expect(resolveTerminalKeys([`ctrl+${letter}`])).toBe(
      String.fromCharCode(i),
    );
    expect(resolveTerminalKeys([` Control+${letter.toUpperCase()} `])).toBe(
      String.fromCharCode(i),
    );
  }
  expect(resolveTerminalKeys(["command+c", "\x1b[A"])).toBe("command+c\x1b[A");
});
