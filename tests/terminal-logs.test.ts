import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TerminalLogs } from "../src/logs";

const context = {
  sessionId: "session",
  projectId: "project",
  runId: "run",
  signal: new AbortController().signal,
};
it("logs persist across instances with UTF-8 pagination and scope-bound IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-log-"));
  try {
    const logs = new TerminalLogs(root);
    const id = randomUUID();
    const writer = await logs.create(id, context);
    const output = "界🙂test".repeat(2500);
    writer.append(output.slice(0, 16000));
    writer.append(output.slice(16000));
    await writer.close();
    const reopened = new TerminalLogs(root);
    expect((await reopened.list(context)).logs[0]?.id).toBe(id);
    expect(
      (await reopened.list({ ...context, sessionId: "other" })).logs,
    ).toHaveLength(0);
    await expect(
      reopened.read(id, 0, { ...context, projectId: "other" }),
    ).rejects.toThrow();
    await expect(reopened.read("../../secret", 0, context)).rejects.toThrow(
      "Invalid log ID",
    );
    let cursor = 0,
      text = "";
    while (true) {
      const page = await reopened.read(id, cursor, context);
      expect(page.output).not.toContain("�");
      text += page.output;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(text).toBe(output);
    await expect(reopened.read(id, -1, context)).rejects.toThrow();
    await expect(reopened.read(id, 1, context)).rejects.toThrow();
    await expect(reopened.create(id, context)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("caps each log and refuses storage-directory conflicts before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-log-cap-"));
  try {
    const writer = await new TerminalLogs(root).create(randomUUID(), context);
    writer.append("x".repeat(5 * 1024 * 1024));
    expect(writer.truncated).toBe(true);
    await writer.close();
    expect((await stat(writer.path)).size).toBe(4 * 1024 * 1024);
    const bad = join(root, "bad");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(bad);
    await writeFile(join(bad, "logs"), "not a directory");
    await expect(
      new TerminalLogs(bad).create(randomUUID(), context),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rotates closed logs under concurrent creates and protects active writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-log-quota-"));
  try {
    const logs = new TerminalLogs(root);
    for (let i = 0; i < 63; i++)
      await (await logs.create(randomUUID(), context)).close();
    const active = await logs.create(randomUUID(), context);
    await utimes(active.path, 0, 0);
    const results = await Promise.allSettled([
      logs.create(randomUUID(), context),
      logs.create(randomUUID(), context),
    ]);
    for (const result of results)
      if (result.status === "fulfilled") await result.value.close();
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    expect((await logs.list(context)).logs).toHaveLength(64);
    active.append("still active");
    await active.close();
    expect(
      (await logs.read(active.path.slice(-40, -4), 0, context)).output,
    ).toBe("still active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("removes expired closed logs when a background log is created", async () => {
  const root = await mkdtemp(join(tmpdir(), "df-log-expiry-"));
  try {
    const logs = new TerminalLogs(root);
    const expired = await logs.create(randomUUID(), context);
    await expired.close();
    await utimes(expired.path, 0, 0);
    await (await logs.create(randomUUID(), context)).close();
    await expect(stat(expired.path)).rejects.toThrow();
    expect((await logs.list(context)).logs).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
