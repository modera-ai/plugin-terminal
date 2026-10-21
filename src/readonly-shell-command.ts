// Adapted from Snow native/src/mcp/tools/mod.rs::is_readonly_bash_command.
// This controls optional change snapshots, never tool approval or permissions.
// Analyse every command in a chain; unknown syntax retains the snapshot.
const reads = new Set([
  "echo",
  "ls",
  "pwd",
  "grep",
  "rg",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "find",
  "which",
  "type",
  "date",
  "printf",
  "dirname",
  "basename",
  "readlink",
  "realpath",
  "stat",
  "file",
  "tree",
  "du",
  "df",
  "nproc",
  "uname",
  "ps",
  "true",
  "false",
  "sleep",
  "test",
  "[",
  "exit",
  "cd",
]);

/** A small lexer, not a shell evaluator. No expansions or executable substitutions. */
function commands(source: string): string[][] | undefined {
  const result: string[][] = [];
  let words: string[] = [],
    word = "",
    active = false,
    quote = "";
  const flush = () => {
    if (active) words.push(word);
    word = "";
    active = false;
  };
  const finish = () => {
    flush();
    if (words.length) result.push(words);
    words = [];
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quote === "'") {
      if (ch === "'") quote = "";
      else word += ch;
      continue;
    }
    if (ch === "\\") {
      const next = source[++i];
      if (next === undefined) return;
      if (next === "\n") continue;
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      active = true;
      continue;
    }
    if (ch === "`" || ch === "$") return;
    if (quote === '"') {
      if (ch === '"') quote = "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      active = true;
      continue;
    }
    if (ch === "#" && !active) {
      while (i < source.length && source[i] !== "\n") i++;
      finish();
      continue;
    }
    if ("<(){}".includes(ch)) return;
    if (ch === ">") {
      // Only discard output or duplicate an existing descriptor. Exact targets,
      // unlike prefix matching which would also accept /dev/null-other-file.
      if (active && /^\d+$/.test(word)) {
        word = "";
        active = false;
      } else flush();
      const match = /^(?:>>?|>\|)\s*(?:\/dev\/null|&\d+)(?=\s|[;&|]|$)/.exec(
        source.slice(i),
      );
      if (!match) return;
      i += match[0].length - 1;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
      finish();
      if ((ch === "&" || ch === "|") && source[i + 1] === ch) i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    word += ch;
    active = true;
  }
  if (quote) return;
  finish();
  return result;
}

function readonlyGit(args: string[]): boolean {
  // Only -C before the subcommand; -c/--config-env can install executable helpers.
  while (args[0] === "-C" && args.length > 2) args = args.slice(2);
  const [sub, ...rest] = args;
  if (
    rest.some((arg) =>
      /^(?:--output|--ext-diff|--textconv|--exec|--open-files-in-pager)(?:=|$)/.test(
        arg,
      ),
    )
  )
    return false;
  if (
    [
      "status",
      "log",
      "diff",
      "show",
      "rev-parse",
      "ls-files",
      "ls-tree",
      "blame",
      "describe",
      "shortlog",
    ].includes(sub ?? "")
  )
    return true;
  if (sub === "config")
    return (
      rest.length === 2 &&
      ["--get", "--get-all", "--get-regexp"].includes(rest[0]!)
    );
  if (sub === "branch" || sub === "tag")
    return (
      !rest.length ||
      (rest[0] === "--list" &&
        rest.slice(1).every((arg) => !arg.startsWith("-")))
    );
  if (sub === "remote")
    return !rest.length || (rest.length === 1 && rest[0] === "-v");
  if (sub === "reflog") return !rest.length;
  return false;
}

function readonlySed(args: string[]): boolean {
  const scripts: string[] = [];
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (operands) {
      if (arg.startsWith("-")) return false;
      continue;
    }
    if (["-n", "--quiet", "--silent", "--posix", "-E", "-r"].includes(arg))
      continue;
    if (arg === "-e") {
      const script = args[++i];
      if (!script) return false;
      scripts.push(script);
      continue;
    }
    if (arg.startsWith("-")) return false;
    if (!scripts.length) scripts.push(arg);
    else operands = true;
  }
  return (
    !!scripts.length &&
    scripts.every((script) =>
      script
        .split(";")
        .every((part) =>
          /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?)?\s*p\s*$/.test(part),
        ),
    )
  );
}

function readonlyCommand([name, ...args]: string[]): boolean {
  if (!name || name.includes("$")) return false;
  // Preserve Snow's shell-state prefix support without permitting arbitrary code.
  if (name === "set")
    return (
      args.length > 0 &&
      args.every((arg) => /^[-+][euxvo]+$/.test(arg) || arg === "pipefail")
    );
  if (name === "git") return readonlyGit(args);
  if (name === "sed") return readonlySed(args);
  if (!reads.has(name)) return false;
  if (
    args.some(
      (arg) =>
        /^--output(?:=|$)/.test(arg) ||
        (/^-[^-]*[oO]/.test(arg) && ["sort", "tree"].includes(name)),
    )
  )
    return false;
  // Snow's broad name whitelist needs option checks: these options can write or
  // execute another program, despite the command usually being used for reading.
  if (
    name === "find" &&
    args.some((arg) =>
      /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(
        arg,
      ),
    )
  )
    return false;
  if (
    name === "rg" &&
    args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))
  )
    return false;
  if (
    name === "sort" &&
    args.some((arg) => /^--(?:compress-program|files0-from)(?:=|$)/.test(arg))
  )
    return false;
  if (name === "date" && args.some((arg) => /^-s|^--set(?:=|$)/.test(arg)))
    return false;
  if (name === "file" && args.some((arg) => /^-[^-]*C|^--compile$/.test(arg)))
    return false;
  if (name === "uniq" && args.filter((arg) => !arg.startsWith("-")).length > 1)
    return false;
  return true;
}

export function isReadonlyShellCommand(command: unknown): boolean {
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 100_000 ||
    command.includes("\0")
  )
    return false;
  const parsed = commands(command);
  return !!parsed && parsed.every(readonlyCommand);
}
