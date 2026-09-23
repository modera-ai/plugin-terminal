import { it, expect } from "vitest";
import { InteractiveCommands } from "../src/interactive";
import { findShell } from "../src/shell";

it("one pending process reads three user inputs then returns once", async () => {
  const controller = new AbortController();
  const commands = new InteractiveCommands({
    pluginId: "test",
    storagePath: "",
    grantedPermissions: new Set(["process.spawn"]),
    signal: controller.signal,
  });
  const context = {
    sessionId: "s",
    runId: "r",
    toolCallId: "c",
    workspacePath: process.cwd(),
    signal: controller.signal,
  };
  const shell = (await findShell())!;
  let settled = false;
  const execution = commands
    .execute(
      shell,
      process.platform === "win32"
        ? "[Console]::Write('FIRST'); $a=Read-Host 'FIRST'; [Console]::Write('SECOND'); $b=Read-Host 'SECOND'; [Console]::Write('THIRD'); $c=Read-Host 'THIRD'; Write-Output ($a+'|'+$b+'|'+$c)"
        : 'printf FIRST; read a; printf SECOND; read b; printf THIRD; read c; printf \'%s|%s|%s\' "$a" "$b" "$c"',
      "three inputs",
      process.cwd(),
      15000,
      context,
    )
    .then((value) => {
      settled = true;
      return value;
    });
  try {
    for (const [prompt, answer] of [
      ["FIRST", "a"],
      ["SECOND", "b"],
      ["THIRD", "c"],
    ]) {
      await expect
        .poll(() => commands.snapshot("c", context).output, { timeout: 8000 })
        .toContain(prompt);
      expect(settled).toBe(false);
      await commands.act("c", "input", answer, context);
    }
    const result = await execution;
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("a|b|c");
    expect(commands.snapshot("c", context).inputReady).toBe(false);
  } finally {
    controller.abort();
    await execution;
  }
}, 25000);

it.each(["stop", "cancel", "timeout"])(
  "interactive command terminates on %s and rejects another session",
  async (action) => {
    const controller = new AbortController();
    const commands = new InteractiveCommands({
      pluginId: "test",
      storagePath: "",
      grantedPermissions: new Set(["process.spawn"]),
      signal: controller.signal,
    });
    const context = {
      sessionId: "s",
      runId: "r",
      toolCallId: "c",
      workspacePath: process.cwd(),
      signal: controller.signal,
    };
    const execution = commands.execute(
      (await findShell())!,
      process.platform === "win32" ? "Read-Host 'wait'" : "read answer",
      "wait",
      process.cwd(),
      action === "timeout" ? 500 : 5000,
      context,
    );
    try {
      await expect
        .poll(() => commands.snapshot("c", context).inputReady)
        .toBe(true);
      await expect(
        commands.act("c", "input", "bad", { ...context, sessionId: "other" }),
      ).rejects.toThrow("unavailable");
      if (action === "stop")
        await commands.act("c", "stop", undefined, context);
      if (action === "cancel") controller.abort();
      expect((await execution).status).toBe(
        action === "timeout" ? "timed_out" : "cancelled",
      );
    } finally {
      controller.abort();
      await execution;
    }
  },
  10000,
);
