import { access } from "@pal/plugin-sdk/workspace-fs";
import { constants } from "node:fs";
import { basename, dirname, join } from "@pal/plugin-sdk/workspace-path";
import { execFile } from "@pal/plugin-sdk/workspace-process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface DetectedTerminalOption {
  id: string;
  label: string;
  path: string;
}

export async function detectTerminalOptions(): Promise<
  DetectedTerminalOption[]
> {
  if (process.platform !== "win32") {
    const candidates = ["/bin/zsh", "/bin/bash", "/bin/fish", "/bin/sh"];
    const found: DetectedTerminalOption[] = [];
    for (const path of candidates) {
      try {
        await access(path, constants.X_OK);
        found.push({ id: path, label: path.split("/").pop()!, path });
      } catch {
        /* unavailable */
      }
    }
    return found;
  }
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const candidates: DetectedTerminalOption[] = [
    {
      id: "powershell",
      label: "Windows PowerShell",
      path: join(
        root,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
    },
    {
      id: "cmd",
      label: "Command Prompt",
      path: join(root, "System32", "cmd.exe"),
    },
    {
      id: "wsl",
      label: "WSL Bash",
      path: join(root, "System32", "wsl.exe"),
    },
  ];
  const programFiles = process.env.ProgramFiles;
  if (programFiles) {
    candidates.unshift({
      id: "pwsh",
      label: "PowerShell 7",
      path: join(programFiles, "PowerShell", "7", "pwsh.exe"),
    });
    candidates.push({
      id: "git-bash",
      label: "Git Bash",
      path: join(programFiles, "Git", "bin", "bash.exe"),
    });
  }
  // Git for Windows normally puts <install>\cmd on PATH, while bash.exe lives
  // in <install>\bin. Derive it from git.exe so custom
  // locations such as D:\DevWare\Git are detected too.
  const where = join(root, "System32", "where.exe");
  try {
    const { stdout } = await execute(where, ["git.exe"], {
      windowsHide: true,
      encoding: "utf8",
    });
    for (const gitPath of stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      const parent = dirname(gitPath);
      const installRoot = ["cmd", "bin", "mingw64"].includes(
        basename(parent).toLowerCase(),
      )
        ? dirname(parent)
        : parent;
      candidates.push({
        id: "git-bash",
        label: "Git Bash",
        path: join(installRoot, "bin", "bash.exe"),
      });
    }
  } catch {
    // Git may not be on PATH; fixed-drive fallbacks below still apply.
  }
  for (const drive of ["C:", "D:"]) {
    for (const folder of ["Program Files", "Program Files (x86)"])
      candidates.push({
        id: "git-bash",
        label: "Git Bash",
        path: join(`${drive}\\`, folder, "Git", "bin", "bash.exe"),
      });
  }
  const labels: Record<string, string> = {
    "pwsh.exe": "PowerShell 7",
    "powershell.exe": "Windows PowerShell",
    "cmd.exe": "Command Prompt",
    "git-bash.exe": "Git Bash",
    "bash.exe": "Bash",
    "nu.exe": "Nushell",
    "wsl.exe": "WSL Bash",
  };
  for (const executable of Object.keys(labels)) {
    try {
      const { stdout } = await execute(where, [executable], {
        windowsHide: true,
        encoding: "utf8",
      });
      for (const path of stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean))
        candidates.push({
          id: executable.replace(/\.exe$/, ""),
          label: labels[executable]!,
          path,
        });
    } catch {
      // Continue detecting the remaining terminal types.
    }
  }
  const found: DetectedTerminalOption[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    try {
      await access(item.path, constants.X_OK);
      const key = item.path.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(item);
      }
    } catch {
      /* unavailable */
    }
  }
  return found;
}

export async function detectWslDistributions(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const wsl = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "wsl.exe",
    );
    const { stdout } = await execute(wsl, ["--list", "--quiet"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return stdout
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
