import { describe, expect, it } from "vitest";
import {
  defaultTerminalConfiguration,
  spawnCommand,
  terminalConfiguration,
} from "../src/shell";

describe("terminal environment configuration", () => {
  it("keeps agent and integrated terminal choices independent", () => {
    expect(
      terminalConfiguration({
        agentEnvironment: "wsl",
        wslDistribution: "Ubuntu",
        integratedShell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      }),
    ).toEqual({
      agentEnvironment: "wsl",
      wslDistribution: "Ubuntu",
      integratedShell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });
    expect(terminalConfiguration(undefined)).toEqual(
      defaultTerminalConfiguration,
    );
  });

  it("builds a WSL command without wrapping it in PowerShell", () => {
    if (process.platform !== "win32") return;
    const command = spawnCommand(
      "wsl:Ubuntu",
      "printf ready",
      "D:\\work",
      false,
    );
    expect(command.executable.toLowerCase()).toContain("wsl.exe");
    expect(command.args).toEqual([
      "--distribution",
      "Ubuntu",
      "--cd",
      "D:\\work",
      "--exec",
      "bash",
      "-lc",
      "printf ready",
    ]);
    expect(command.cwd).toBeUndefined();
  });
});
