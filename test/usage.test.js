import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheHit, formatCacheHit, watchSession } from "../usage.js";

const tokens = (input, read, write = 0) => ({ input, output: 100, reasoning: 20, cache: { read, write } });
const session = (id, usage, parentID) => ({ id, tokens: usage, parentID });
const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitForRefresh = () => new Promise((resolve) => setTimeout(resolve, 150));

test("uses cache read divided by all input tokens, not output or reasoning", () => {
  assert.equal(cacheHit([session("ses_root", tokens(100, 9900))]), 99);
  assert.equal(cacheHit([session("ses_root", tokens(100, 800, 100))]), 80);
  assert.equal(cacheHit([session("ses_root", tokens(1000, 0))]), 0);
  assert.equal(cacheHit([session("ses_root", tokens(0, 1000))]), 100);
  assert.equal(cacheHit([session("ses_root", tokens(0, 0, 1000))]), 0);
});

test("weights root and sub-agent usage by input tokens", () => {
  assert.equal(cacheHit([
    session("ses_root", tokens(10, 90)),
    session("ses_child", tokens(900, 0), "ses_root"),
  ]), 9);
});

test("shows no percentage before input usage is available", () => {
  assert.equal(cacheHit([]), undefined);
  assert.equal(cacheHit([{ id: "ses_empty" }]), undefined);
  assert.equal(cacheHit([session("ses_empty", tokens(0, 0))]), undefined);
  for (const invalid of [NaN, Infinity, -1, undefined]) {
    assert.equal(cacheHit([session("ses_invalid", tokens(invalid, 100))]), undefined);
  }
  assert.equal(formatCacheHit(undefined), "— cache hit");
  assert.equal(formatCacheHit(0), "0% cache hit");
  assert.equal(formatCacheHit(99), "99% cache hit");
});

function fixture() {
  const sessions = new Map([
    ["ses_root", session("ses_root", tokens(100, 900))],
    ["ses_child", session("ses_child", tokens(100, 900), "ses_root")],
    ["ses_nested", session("ses_nested", tokens(1000, 0), "ses_child")],
    ["ses_other", session("ses_other", tokens(100000, 0))],
  ]);
  const handlers = new Map();
  const updates = [];
  const calls = [];
  let beforeList;
  let fail = false;
  const context = {
    client: {
      session: {
        async get({ sessionID }, options) {
          calls.push({ type: "get", sessionID, options });
          if (fail) throw new Error("Offline");
          return structuredClone(sessions.get(sessionID));
        },
        async list(input, options) {
          calls.push({ type: "list", input, options });
          const data = [...sessions.values()].filter((info) => info.parentID === input.parentID);
          // Small pages exercise pagination without creating 100 sessions.
          const offset = Number(input.cursor ?? 0);
          const page = {
            data: structuredClone(data.slice(offset, offset + 1)),
            cursor: { next: data.length > offset + 1 ? String(offset + 1) : undefined },
          };
          await beforeList?.(input, page);
          return page;
        },
      },
    },
    data: {
      on(type, handler) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
  };
  return {
    context, sessions, handlers, updates, calls,
    update: (value) => updates.push(value),
    emit: (type, data) => handlers.get(type)?.({ data }),
    beforeList: (handler) => { beforeList = handler; },
    fail: (value) => { fail = value; },
  };
}

test("loads the complete nested sub-agent tree and follows each page", async () => {
  const f = fixture();
  f.sessions.set("ses_second", session("ses_second", tokens(1000, 0), "ses_root"));
  const stop = watchSession(f.context, "ses_root", f.update);
  await flush();
  assert.deepEqual(f.updates, [undefined, 45]);
  assert.ok(f.calls.some((call) => call.input?.cursor === "1"));
  assert.ok(f.calls.some((call) => call.input?.parentID === "ses_nested"));
  assert.ok(!f.calls.some((call) => call.input?.parentID === "ses_other"));
  stop();
  assert.equal(f.handlers.size, 0);
  assert.ok(f.calls.every((call) => call.options.signal.aborted));
});

test("applies cumulative usage events once and ignores unrelated sessions", async () => {
  const f = fixture();
  const stop = watchSession(f.context, "ses_root", f.update);
  await flush();
  assert.equal(f.updates.at(-1), 60);
  f.emit("session.usage.updated", { sessionID: "ses_nested", tokens: tokens(1000, 3000) });
  assert.equal(f.updates.at(-1), 80);
  f.emit("session.usage.updated", { sessionID: "ses_nested", tokens: tokens(1000, 3000) });
  assert.equal(f.updates.at(-1), 80);
  const count = f.updates.length;
  f.emit("session.usage.updated", { sessionID: "ses_other", tokens: tokens(0, 100000) });
  assert.equal(f.updates.length, count);
  stop();
});

test("retains usage events that arrive while a stale snapshot is loading", async () => {
  const f = fixture();
  f.beforeList((input) => {
    if (input.parentID !== "ses_root") return;
    f.emit("session.usage.updated", { sessionID: "ses_child", tokens: tokens(100, 2900) });
  });
  const stop = watchSession(f.context, "ses_root", f.update);
  await flush();
  assert.equal(f.updates.at(-1), 76);
  stop();
});

test("includes new sub-agents and removes deleted sessions", async () => {
  const f = fixture();
  const stop = watchSession(f.context, "ses_root", f.update);
  await flush();
  f.sessions.set("ses_new", session("ses_new", tokens(0, 1000), "ses_nested"));
  f.emit("session.created", { sessionID: "ses_new", parentID: "ses_nested" });
  await waitForRefresh();
  assert.equal(f.updates.at(-1), 70);
  f.sessions.delete("ses_new");
  f.emit("session.deleted", { sessionID: "ses_new" });
  await waitForRefresh();
  assert.equal(f.updates.at(-1), 60);
  stop();
});

test("stops pending refreshes and never publishes after disposal", async () => {
  const f = fixture();
  const hold = Promise.withResolvers();
  f.beforeList(() => hold.promise);
  const stop = watchSession(f.context, "ses_root", f.update);
  await flush();
  f.emit("session.created", { sessionID: "ses_new" });
  stop();
  const calls = f.calls.length;
  hold.resolve();
  await waitForRefresh();
  assert.deepEqual(f.updates, [undefined]);
  assert.equal(f.calls.length, calls);
  assert.equal(f.handlers.size, 0);
});

test("uses an unknown value on failure and recovers after reconnect", async () => {
  const f = fixture();
  f.fail(true);
  const warn = console.warn;
  console.warn = () => {};
  let stop;
  try {
    stop = watchSession(f.context, "ses_root", f.update);
    await flush();
    assert.equal(f.updates.at(-1), undefined);
    f.fail(false);
    f.emit("client.connection", {});
    await waitForRefresh();
    assert.equal(f.updates.at(-1), 60);
  } finally {
    stop?.();
    console.warn = warn;
  }
});
