import { localizeMetadata, type ToolDefinition } from "@pal/contracts";
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

for (const locale of ["zh", "zh-CN", "zh_CN", "en", "en-US"]) {
  it(`localizes every terminal tool title for ${locale}`, () => {
    for (const tool of manifest.tools) {
      const title = localizeMetadata(tool as ToolDefinition, locale).title;
      if (locale.startsWith("zh")) expect(title).toBe(tool.title);
      else expect(title).toBe(tool.locales.en.title);
    }
  });
}
