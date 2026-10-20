export const TERMINAL_KEY_MAP: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  backspace: "\x7f",
  delete: "\x1b[3~",
  insert: "\x1b[2~",
  esc: "\x1b",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  "ctrl+a": "\x01",
  "ctrl+b": "\x02",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+e": "\x05",
  "ctrl+f": "\x06",
  "ctrl+g": "\x07",
  "ctrl+h": "\x08",
  "ctrl+i": "\t",
  "ctrl+j": "\n",
  "ctrl+k": "\x0b",
  "ctrl+l": "\x0c",
  "ctrl+m": "\r",
  "ctrl+n": "\x0e",
  "ctrl+o": "\x0f",
  "ctrl+p": "\x10",
  "ctrl+q": "\x11",
  "ctrl+r": "\x12",
  "ctrl+s": "\x13",
  "ctrl+t": "\x14",
  "ctrl+u": "\x15",
  "ctrl+v": "\x16",
  "ctrl+w": "\x17",
  "ctrl+x": "\x18",
  "ctrl+y": "\x19",
  "ctrl+z": "\x1a",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
};

/**
 * 将 keys 数组解析为要写入 PTY 的字节串：
 * 每个元素先查命名映射，未命中的原样发送（支持直接传转义序列，
 * 例如 "\u001b[A" 表示上箭头）。返回结果与元素个数一致。
 */
export const resolveTerminalKeys = (keys: string[]): string => {
  let payload = "";
  for (const key of keys) {
    const named =
      TERMINAL_KEY_MAP[
        key
          .trim()
          .toLowerCase()
          .replace(/^control\+/, "ctrl+")
      ];
    payload += named ?? key;
  }
  return payload;
};
