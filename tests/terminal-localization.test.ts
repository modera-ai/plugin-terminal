import { describe, expect, it } from "vitest";
import manifest from "../plugin.json";

describe("terminal control titles", () => {
  it("provides English metadata for every terminal control operation", () => {
    for (const id of [
      "open",
      "send",
      "read",
      "resize",
      "wait",
      "close",
      "focus",
      "list",
    ]) {
      const tool = manifest.tools.find((tool) => tool.id === `terminal_${id}`);
      expect(tool).toBeDefined();
      expect(
        (tool?.locales as Record<string, { title: string }> | undefined)?.en
          ?.title,
      ).toMatch(/[A-Za-z]/);
    }
  });
});
