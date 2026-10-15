import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { installRemoteWorkspaceTransport } from "@pal/plugin-sdk/workspace-transport";
const { activate } = createRequire(import.meta.url)("../dist/index.cjs");
class FakePty {
  pid = 1;
  cols = 100;
  rows = 30;
  killed = 0;
  writes = [];
  outputs = new Set();
  exits = new Set();
  write(data) {
    this.writes.push(data);
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }
  kill() {
    this.killed++;
  }
  onData(fn) {
    this.outputs.add(fn);
    return { dispose: () => this.outputs.delete(fn) };
  }
  onExit(fn) {
    this.exits.add(fn);
    return { dispose: () => this.exits.delete(fn) };
  }
  emit(data) {
    for (const fn of this.outputs) fn(data);
  }
}
async function fixture(work, create) {
  const lifetime = new AbortController(),
    scopes = new Map(),
    ptys = [];
  const scope = (id) => {
    if (!scopes.has(id)) scopes.set(id, new AbortController());
    return scopes.get(id);
  };
  const uninstall = installRemoteWorkspaceTransport({
    file: async (name, args) =>
      name === "realpath" ? args[0] : { isDirectory: () => true },
    spawn() {
      throw new Error("unused");
    },
    pty: async () => {
      const p = new FakePty();
      ptys.push(p);
      return create ? create(p) : p;
    },
  });
  const host = {
    pluginId: "pal.terminal",
    resourcePath: "resources",
    storagePath: "storage",
    signal: lifetime.signal,
    scopeSignal: (id) => scope(id).signal,
    config: { read: async () => ({ values: {} }) },
    panels: { open: async () => {}, close: async () => {} },
    invalidateUi() {},
  };
  const contributions = await activate(host);
  const context = (id = "a", signal = new AbortController().signal) => ({
    projectId: id,
    sessionId: "session-" + id,
    workspacePath: "ssh://test/" + id,
    runId: "test",
    signal,
  });
  const run = (name, input = {}, ctx = context()) =>
    contributions.commands
      .find((c) => c.id === "pal.terminal." + name)
      .run(input, { context: ctx });
  const panel = contributions.ui.find((c) => c.id === "pal.terminal.panel");
  try {
    await work({
      run,
      context,
      panel,
      contributions,
      ptys,
      scope,
      scopes,
      lifetime,
    });
  } finally {
    lifetime.abort();
    uninstall();
  }
}
test("PAL command declarations match registration; panel is conversation-bound without act", () =>
  fixture(async (f) => {
    const manifest = JSON.parse(
      await readFile(new URL("../plugin.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(
      f.contributions.commands.map(({ run, ...metadata }) => metadata),
      manifest.declarations.provides.commands,
    );
    assert.equal(f.panel.scope, "conversation");
    assert.equal(f.panel.act, undefined);
    assert.equal(f.contributions.commands.length, 9);
  }));
test("navigation keeps the process; new project and changed directory cannot control it", () =>
  fixture(async (f) => {
    const navigation = new AbortController(),
      a = f.context("a", navigation.signal);
    const opened = await f.run("open", {}, a);
    navigation.abort();
    assert.equal(f.ptys[0].killed, 0);
    assert.equal(
      (await f.run("read", { tabId: opened.tabId })).tabId,
      opened.tabId,
    );
    assert.throws(
      () => f.run("read", { tabId: opened.tabId }, f.context("b")),
      /unavailable/,
    );
    assert.throws(
      () =>
        f.run(
          "read",
          { tabId: opened.tabId },
          { ...f.context(), workspacePath: "ssh://test/other" },
        ),
      /unavailable/,
    );
    await f.run("input", { tabId: opened.tabId, data: "a-only" });
    assert.deepEqual(f.ptys[0].writes, ["a-only"]);
    const b = await f.run("open", {}, f.context("b"));
    assert.notEqual(b.tabId, opened.tabId);
  }));
test("scope disable kills only that project's PTY; re-enable cannot reuse it or old output", () =>
  fixture(async (f) => {
    const a = await f.run("open"),
      b = await f.run("open", {}, f.context("b"));
    const output = [...f.ptys[0].outputs][0];
    f.scope("a").abort();
    assert.equal(f.ptys[0].killed, 1);
    assert.equal(f.ptys[1].killed, 0);
    assert.throws(() => f.run("read", { tabId: a.tabId }), /unavailable/);
    f.scopes.set("a", new AbortController());
    const next = await f.run("open");
    output("late-old-output");
    assert.notEqual(next.tabId, a.tabId);
    assert.equal((await f.run("read", { tabId: next.tabId })).raw, "");
    assert.equal(
      (await f.run("read", { tabId: b.tabId }, f.context("b"))).raw,
      "",
    );
  }));
test("concurrent panel renders share one PTY and actual port close is idempotent", () =>
  fixture(async (f) => {
    const request = {
        id: f.panel.id,
        sessionId: "session-a",
        locale: "zh-CN",
        resource: "manual-1",
      },
      ctx = f.context();
    const [one, two] = await Promise.all([
      f.panel.render(request, ctx),
      f.panel.render(request, ctx),
    ]);
    assert.equal(one.data.tabId, two.data.tabId);
    assert.equal(f.ptys.length, 1);
    assert.match(one.title, /a/);
    assert.equal(one.data.binding.sessionId, "session-a");
    const port = f.panel.bindTerminal(request, ctx);
    port.close();
    port.close();
    assert.equal(f.ptys[0].killed, 1);
  }));
test("a PTY completing startup after scope revocation is killed and never registered", async () => {
  let release, entered;
  const waiting = new Promise((r) => {
    entered = r;
  });
  await fixture(
    async (f) => {
      const opening = f.run("open");
      await waiting;
      f.scope("a").abort();
      release();
      await assert.rejects(opening);
      assert.equal(f.ptys[0].killed, 1);
      f.scopes.set("a", new AbortController());
      assert.deepEqual((await f.run("list")).terminals, []);
    },
    (p) =>
      new Promise((resolve) => {
        release = () => resolve(p);
        entered();
      }),
  );
});
