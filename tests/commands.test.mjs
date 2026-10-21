import { test } from "node:test";
import { processHost } from "./helpers/process-host.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { installRemoteWorkspaceTransport } from "@pal/plugin-sdk/workspace-transport";
const require = createRequire(import.meta.url);
const activate = (...args) => {
  const entry = require.resolve("../dist/index.cjs");
  delete require.cache[entry];
  return require(entry).activate(...args);
};
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
  const createPty = async () => {
    const p = new FakePty();
    ptys.push(p);
    return create ? create(p) : p;
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
    ...processHost(
      (id) => AbortSignal.any([lifetime.signal, scope(id).signal]),
      createPty,
    ),
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
      host,
    });
  } finally {
    lifetime.abort();
    uninstall();
  }
}
test("PAL command declarations match registration; panel is conversation-bound without act", () =>
  fixture(async (f) => {
    const manifest = JSON.parse(
      await readFile(new URL("../pal-manifest.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(
      f.contributions.commands.map(({ run, ...metadata }) => metadata),
      manifest.declarations.provides.commands,
    );
    assert.equal(f.panel.scope, "conversation");
    assert.equal(f.panel.act, undefined);
    assert.equal(f.contributions.commands.length, 12);
  }));

test("wait delivers consecutive output after buffer rotation without repeats", () =>
  fixture(async (f) => {
    const tab = await f.run("open");
    f.ptys[0].emit("x".repeat(1_000_000));
    assert.equal(
      (await f.run("wait", { tabId: tab.tabId, idleMs: 100 })).text.length,
      1_000_000,
    );
    for (let i = 0; i < 3; i++) {
      f.ptys[0].emit(`\x1b[31m界🌏 round ${i}\x1b[0m\r\n`);
      const next = await f.run("wait", { tabId: tab.tabId, idleMs: 100 });
      assert.equal(next.text, `界🌏 round ${i}\r\n`);
      assert.equal(next.lostOutput, false);
    }
    assert.equal(
      (await f.run("wait", { tabId: tab.tabId, idleMs: 100 })).text,
      "",
    );
  }));

test("wait reports evicted output then resumes its absolute cursor", () =>
  fixture(async (f) => {
    const tab = await f.run("open");
    f.ptys[0].emit("x".repeat(1_000_020));
    const first = await f.run("wait", { tabId: tab.tabId, idleMs: 100 });
    assert.equal(first.lostOutput, true);
    assert.equal(first.text.length, 1_000_000);
    f.ptys[0].emit("y".repeat(1_000_001));
    assert.equal(
      (await f.run("wait", { tabId: tab.tabId, idleMs: 100 })).lostOutput,
      true,
    );
    f.ptys[0].emit("AFTER_EVICTION");
    const next = await f.run("wait", { tabId: tab.tabId, idleMs: 100 });
    assert.equal(next.text, "AFTER_EVICTION");
    assert.equal(next.lostOutput, false);
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
    assert.equal(one.title, "终端");
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

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const requestFor = (f) => ({
  id: f.panel.id,
  sessionId: "session-a",
  locale: "en",
  resource: "manual-review",
});

test("focus and close use the original manual panel resource", () =>
  fixture(async (f) => {
    const opened = [],
      closed = [];
    f.host.panels.open = async (id, resource) => opened.push({ id, resource });
    f.host.panels.close = async (id, resource) => closed.push({ id, resource });
    const request = requestFor(f);
    const view = await f.panel.render(request, f.context());
    await f.run("focus", { tabId: view.data.tabId });
    assert.equal(opened.at(-1).resource, request.resource);
    const focused = await f.panel.render(
      { ...request, resource: opened.at(-1).resource },
      f.context(),
    );
    assert.equal(focused.data.tabId, view.data.tabId);
    assert.equal(f.ptys.length, 1);
    await f.run("close", { tabId: view.data.tabId });
    assert.equal(closed.at(-1).resource, request.resource);
    assert.equal(f.ptys[0].killed, 1);
  }));

test("wait rejects when its terminal closes, without returning old output", () =>
  fixture(async (f) => {
    const tab = await f.run("open");
    f.ptys[0].emit("OLD OUTPUT");
    const waiting = f.run("wait", { tabId: tab.tabId, idleMs: 100 });
    const rejected = assert.rejects(waiting, /unavailable/);
    await f.run("close", { tabId: tab.tabId });
    await rejected;
    assert.equal(f.ptys[0].killed, 1);
  }));

test("re-enable starts a fresh panel before revoked startup returns; late old PTY is killed", async () => {
  const entered = deferred(),
    release = deferred();
  let starts = 0;
  await fixture(
    async (f) => {
      const request = requestFor(f);
      const oldRender = f.panel.render(request, f.context());
      await entered.promise;
      f.scope("a").abort();
      f.scopes.set("a", new AbortController());
      const next = await f.panel.render(request, f.context());
      assert.equal(f.ptys.length, 2);
      assert.ok(next.data.tabId);
      f.ptys[1].emit("NEW OUTPUT");
      release.resolve();
      const old = await oldRender;
      assert.ok(old.data.startupError);
      assert.equal(old.data.tabId, undefined);
      assert.equal(f.ptys[0].killed, 1);
      assert.equal(f.ptys[1].killed, 0);
      assert.equal(
        (await f.run("read", { tabId: next.data.tabId })).raw,
        "NEW OUTPUT",
      );
      assert.equal(
        (await f.panel.render(request, f.context())).data.tabId,
        next.data.tabId,
      );
    },
    async (p) => {
      if (++starts === 1) {
        entered.resolve();
        await release.promise;
      }
      return p;
    },
  );
});

test("scope revocation rejects a pending wait even after re-enable", () =>
  fixture(async (f) => {
    const old = await f.run("open");
    f.ptys[0].emit("OLD OUTPUT");
    const waiting = f.run("wait", { tabId: old.tabId, idleMs: 100 });
    const rejected = assert.rejects(waiting, /unavailable/);
    f.scope("a").abort();
    f.scopes.set("a", new AbortController());
    const next = await f.run("open");
    await rejected;
    assert.equal((await f.run("read", { tabId: next.tabId })).raw, "");
    assert.equal(f.ptys[0].killed, 1);
  }));

test("render cannot return an old terminal after configuration I/O spans disable/re-enable", () =>
  fixture(async (f) => {
    const entered = deferred(),
      release = deferred();
    f.host.config.read = async () => {
      entered.resolve();
      await release.promise;
      return { values: {} };
    };
    const rendering = f.panel.render(requestFor(f), f.context());
    await entered.promise;
    f.scope("a").abort();
    f.scopes.set("a", new AbortController());
    release.resolve();
    const old = await rendering;
    assert.ok(old.data.startupError);
    assert.equal(old.data.tabId, undefined);
    assert.equal(f.ptys[0].killed, 1);
  }));

test("tool slots replace legacy approval/result UI and use private presentation commands", () =>
  fixture(async (f) => {
    const manifest = JSON.parse(
      await readFile(new URL("../pal-manifest.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(
      f.contributions.slotContributions,
      manifest.declarations.consumes.slots,
    );
    assert.deepEqual(
      f.contributions.ui.map((item) => item.id),
      ["pal.terminal.panel"],
    );
    const read = f.contributions.commands.find(
      (c) => c.id === "pal.terminal.presentation.read",
    );
    assert.equal(read.visibility, "private");
    assert.equal(read.readOnly, true);
    const preview = {
      command: "echo approved",
      description: "检查",
      cwd: "ssh://test/a",
      shell: "/bin/sh",
    };
    const request = {
      id: "pal.host.ui.tool.approval",
      locale: "zh-CN",
      sessionId: "session-a",
      approvalId: "approval-a",
      toolCallId: "call-a",
      tool: {
        name: "terminal_execute",
        input: { command: "do not use me" },
        result: JSON.stringify(preview),
      },
    };
    const view = await read.run({}, { request, context: f.context() });
    assert.equal(view.data.command, preview.command);
    assert.equal(view.data.approval, true);
    const act = f.contributions.commands.find(
      (c) => c.id === "pal.terminal.presentation.act",
    );
    await assert.rejects(
      act.run({ action: "stop" }, { request, context: f.context() }),
      /Read-only/,
    );
    const pending = await read.run(
      {},
      {
        request: {
          ...request,
          approvalId: undefined,
          tool: {
            name: "terminal_execute",
            input: { command: "pending", interactive: true },
          },
        },
        context: f.context(),
      },
    );
    assert.equal(pending.data.inputReady, false);
    assert.equal(pending.live, true);
    const done = await read.run(
      {},
      {
        request: {
          ...request,
          approvalId: undefined,
          tool: {
            name: "terminal_session",
            input: {},
            result: JSON.stringify({ sessions: [] }),
          },
        },
        context: f.context(),
      },
    );
    assert.deepEqual(done.data.sessions, []);
    await assert.rejects(
      read.run(
        {},
        {
          request: { ...request, tool: { name: "unrelated", input: {} } },
          context: f.context(),
        },
      ),
      /binding/,
    );
  }));
