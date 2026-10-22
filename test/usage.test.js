import assert from "node:assert/strict";
import { test } from "node:test";
import { watchSession } from "../usage.js";

const MINUTE = 60_000;
const NOW = 1_000 * MINUTE;
const tokens = (input, read, write = 0) => ({ input, output: 100, reasoning: 20, cache: { read, write } });
const session = (id, usage, parentID, updated = NOW) => ({ id, tokens: usage, parentID, time: { created: 0, updated } });
const anthropic = { providerID: "anthropic", id: "claude-opus-5-5" };
const message = (id, started, usage, completed = started + 1000) => ({
  id, type: "assistant", model: anthropic, time: { created: started, ...(completed ? { completed } : {}) }, ...(usage ? { tokens: usage } : {}),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitForRefresh = () => new Promise((resolve) => setTimeout(resolve, 150));

function fixture() {
  const sessions = new Map([
    ["ses_root", session("ses_root", tokens(100, 900))],
    ["ses_child", session("ses_child", tokens(100, 900), "ses_root")],
    ["ses_nested", session("ses_nested", tokens(1000, 0), "ses_child")],
    ["ses_other", session("ses_other", tokens(100000, 0))],
  ]);
  const messages = new Map();
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
        message: {
          async list(input, options) {
            calls.push({ type: "messages", input, options });
            const data = (messages.get(input.sessionID) ?? []).toSorted((a, b) => b.time.created - a.time.created);
            const offset = Number(input.cursor ?? 0);
            return {
              data: structuredClone(data.slice(offset, offset + 1)),
              cursor: { next: data.length > offset + 1 ? String(offset + 1) : undefined },
            };
          },
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
    context, sessions, messages, handlers, updates, calls,
    update: (value) => updates.push(value),
    emit: (type, data) => handlers.get(type)?.({ data }),
    beforeList: (handler) => { beforeList = handler; },
    fail: (value) => { fail = value; },
  };
}

function watch(f, now = () => NOW) {
  return watchSession(f.context, "ses_root", f.update, { now });
}

test("loads the complete nested sub-agent tree and follows each page", async () => {
  const f = fixture();
  f.sessions.set("ses_second", session("ses_second", tokens(1000, 0), "ses_root"));
  const stop = watch(f);
  await flush();
  assert.deepEqual(f.updates, [undefined, { rows: [], total: { main: 90, subs: 30 } }]);
  assert.ok(f.calls.some((call) => call.input?.cursor === "1"));
  assert.ok(f.calls.some((call) => call.input?.parentID === "ses_nested"));
  assert.ok(!f.calls.some((call) => call.input?.parentID === "ses_other"));
  stop();
  assert.equal(f.handlers.size, 0);
  assert.ok(f.calls.every((call) => call.options.signal.aborted));
});

test("loads recent requests only from sessions that changed in the TTL window", async () => {
  const f = fixture();
  f.sessions.get("ses_nested").time.updated = NOW - 31 * MINUTE;
  f.messages.set("ses_root", [
    message("msg_old", NOW - 40 * MINUTE, tokens(1000, 0)),
    message("msg_new", NOW - MINUTE, tokens(10, 90)),
    message("msg_mid", NOW - 2 * MINUTE, tokens(10, 90)),
  ]);
  f.messages.set("ses_child", [message("msg_child", NOW - 3 * MINUTE, tokens(50, 50))]);
  const stop = watch(f);
  await flush();
  assert.deepEqual(f.updates.at(-1).rows, [
    { providerID: "anthropic", main: 90, subs: 50, left: { ms: 4 * MINUTE, exact: true } },
  ]);
  const requests = f.calls.filter((call) => call.type === "messages");
  assert.ok(!requests.some((call) => call.input.sessionID === "ses_nested"));
  assert.ok(requests.every((call) => call.input.type === "assistant"));
  assert.ok(requests.every((call) => (call.input.cursor ? call.input.order === undefined : call.input.order === "desc")));
  // The walk stops at the first message that is older than the longest TTL.
  assert.equal(requests.filter((call) => call.input.sessionID === "ses_root").length, 3);
  stop();
});

test("shows a provider while a step runs and counts down after it ends", async () => {
  const f = fixture();
  let now = NOW;
  const stop = watch(f, () => now);
  await flush();
  f.emit("session.step.started", { sessionID: "ses_root", assistantMessageID: "msg_1", model: anthropic, started: NOW });
  assert.deepEqual(f.updates.at(-1).rows, [{ providerID: "anthropic", main: undefined, subs: undefined, left: { running: true } }]);
  now = NOW + MINUTE;
  f.emit("session.step.ended", { sessionID: "ses_root", assistantMessageID: "msg_1", tokens: tokens(10, 90) });
  assert.deepEqual(f.updates.at(-1).rows, [{ providerID: "anthropic", main: 90, subs: undefined, left: { ms: 4 * MINUTE, exact: true } }]);
  now = NOW + 5 * MINUTE;
  f.emit("session.usage.updated", { sessionID: "ses_root", tokens: tokens(110, 990) });
  assert.deepEqual(f.updates.at(-1).rows, []);
  stop();
});

test("ends running steps when the next step or the execution ends", async () => {
  const f = fixture();
  const stop = watch(f);
  await flush();
  f.emit("session.step.started", { sessionID: "ses_child", assistantMessageID: "msg_1", model: anthropic, started: NOW - MINUTE });
  f.emit("session.step.started", { sessionID: "ses_child", assistantMessageID: "msg_2", model: anthropic, started: NOW });
  f.emit("session.execution.succeeded", { sessionID: "ses_child" });
  assert.deepEqual(f.updates.at(-1).rows[0].left, { ms: 5 * MINUTE, exact: true });
  stop();
});

test("ignores steps and usage from unrelated sessions", async () => {
  const f = fixture();
  const stop = watch(f);
  await flush();
  const count = f.updates.length;
  f.emit("session.step.started", { sessionID: "ses_other", assistantMessageID: "msg_1", model: anthropic, started: NOW });
  f.emit("session.usage.updated", { sessionID: "ses_other", tokens: tokens(0, 100000) });
  assert.equal(f.updates.length, count);
  f.emit("session.usage.updated", { sessionID: "ses_nested", tokens: tokens(1000, 3000) });
  assert.deepEqual(f.updates.at(-1), { rows: [], total: { main: 90, subs: 78 } });
  stop();
});

test("retains events that arrive while a stale snapshot is loading", async () => {
  const f = fixture();
  f.beforeList((input) => {
    if (input.parentID !== "ses_root") return;
    f.emit("session.usage.updated", { sessionID: "ses_child", tokens: tokens(100, 2900) });
    f.emit("session.step.started", { sessionID: "ses_child", assistantMessageID: "msg_1", model: anthropic, started: NOW });
  });
  const stop = watch(f);
  await flush();
  assert.deepEqual(f.updates.at(-1), {
    rows: [{ providerID: "anthropic", main: undefined, subs: undefined, left: { running: true } }],
    total: { main: 90, subs: 73 },
  });
  stop();
});

test("includes new sub-agents and removes deleted sessions", async () => {
  const f = fixture();
  const stop = watch(f);
  await flush();
  f.sessions.set("ses_new", session("ses_new", tokens(0, 1000), "ses_nested"));
  f.messages.set("ses_new", [message("msg_new", NOW, tokens(0, 1000))]);
  f.emit("session.created", { sessionID: "ses_new", parentID: "ses_nested" });
  await waitForRefresh();
  assert.deepEqual(f.updates.at(-1), {
    rows: [{ providerID: "anthropic", main: undefined, subs: 100, left: { ms: 5 * MINUTE, exact: true } }],
    total: { main: 90, subs: 63 },
  });
  f.sessions.delete("ses_new");
  f.emit("session.deleted", { sessionID: "ses_new" });
  await waitForRefresh();
  assert.deepEqual(f.updates.at(-1), { rows: [], total: { main: 90, subs: 45 } });
  stop();
});

test("stops pending refreshes and never publishes after disposal", async () => {
  const f = fixture();
  const hold = Promise.withResolvers();
  f.beforeList(() => hold.promise);
  const stop = watch(f);
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

test("does not start the countdown timer when an update stops the watcher", async () => {
  const f = fixture();
  f.messages.set("ses_root", [message("msg_1", NOW - MINUTE, tokens(10, 90))]);
  let stop;
  stop = watchSession(f.context, "ses_root", (summary) => {
    f.updates.push(summary);
    if (summary) stop();
  }, { now: () => NOW });
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.updates.length, 2);
});

test("uses unknown values on failure and recovers after reconnect", async () => {
  const f = fixture();
  f.fail(true);
  const warn = console.warn;
  console.warn = () => {};
  let stop;
  try {
    stop = watch(f);
    await flush();
    assert.equal(f.updates.at(-1), undefined);
    f.fail(false);
    f.emit("client.connection", {});
    await waitForRefresh();
    assert.deepEqual(f.updates.at(-1), { rows: [], total: { main: 90, subs: 45 } });
  } finally {
    stop?.();
    console.warn = warn;
  }
});
