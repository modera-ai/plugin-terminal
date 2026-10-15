import { isRemotePath } from "@pal/plugin-sdk/workspace-path";
import { access, realpath, stat } from "@pal/plugin-sdk/workspace-fs";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve } from "@pal/plugin-sdk/workspace-path";

export type AgentEnvironment = "windows-native" | "wsl";

export interface TerminalConfiguration {
  agentEnvironment: AgentEnvironment;
  wslDistribution: string;
  integratedShell: string;
}

export const defaultTerminalConfiguration: TerminalConfiguration = {
  agentEnvironment: "windows-native",
  wslDistribution: "",
  integratedShell: "auto",
};

export function terminalConfiguration(
  values: Record<string, string | boolean | number> | undefined,
): TerminalConfiguration {
  return {
    agentEnvironment:
      values?.agentEnvironment === "wsl" ? "wsl" : "windows-native",
    wslDistribution:
      typeof values?.wslDistribution === "string"
        ? values.wslDistribution.trim()
        : "",
    integratedShell:
      typeof values?.integratedShell === "string" &&
      values.integratedShell.trim()
        ? values.integratedShell.trim()
        : "auto",
  };
}

export async function findShell(): Promise<string | undefined> {
  const candidates =
    process.platform === "win32"
      ? [
          join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
        ]
      : ["/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try next supported shell. */
    }
  }
  return undefined;
}

export async function findAgentShell(
  configuration: TerminalConfiguration,
): Promise<string | undefined> {
  if (
    process.platform === "win32" &&
    configuration.agentEnvironment === "wsl"
  ) {
    const wsl = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "wsl.exe",
    );
    try {
      await access(wsl, constants.X_OK);
      return `wsl:${configuration.wslDistribution}`;
    } catch {
      return undefined;
    }
  }
  return findShell();
}

export function isWslShell(shell: string): boolean {
  return shell.startsWith("wsl:");
}

export function spawnCommand(
  shell: string,
  command: string,
  cwd: string,
  interactive = false,
): { executable: string; args: string[]; cwd?: string } {
  if (isRemotePath(cwd)) return { executable: "/bin/sh", args: ["-lc", command], cwd };
  if (process.platform === "win32" && isWslShell(shell)) {
    const distribution = shell.slice(4).trim();
    return {
      executable: join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "wsl.exe",
      ),
      args: [
        ...(distribution ? ["--distribution", distribution] : []),
        "--cd",
        cwd,
        "--exec",
        "bash",
        "-lc",
        command,
      ],
    };
  }
  return { executable: shell, args: shellArguments(command, interactive), cwd };
}

export async function workingDirectory(
  rootPath: string,
  input = ".",
): Promise<string> {
  const root = await realpath(rootPath);
  const target = await realpath(resolve(root, input));
  const delta = relative(root, target);
  if (
    delta === ".." ||
    (delta.startsWith("../") || delta.startsWith("..\\")) ||
    isAbsolute(delta)
  )
    throw new Error("Working directory must be within the project");
  if (!(await stat(target)).isDirectory())
    throw new Error("Working directory must be a directory");
  return target;
}

export function shellArguments(command: string, interactive = false): string[] {
  if (process.platform !== "win32") return ["-c", command];
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $LASTEXITCODE=0; try { & {\n${command}\n}; if (-not $?) { exit 1 }; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`;
  if (interactive)
    return [
      "-NoLogo",
      "-NoProfile",
      "-OutputFormat",
      "Text",
      "-Command",
      "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); " +
        script,
    ];
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // App launch flags must not change npm dependency installation or child Node behavior.
  for (const key of Object.keys(env))
    if (
      ["NODE_ENV", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(
        key.toUpperCase(),
      )
    )
      delete env[key];
  return env;
}
