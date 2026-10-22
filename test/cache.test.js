import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheHit, cacheTTL, formatTable, summarize } from "../cache.js";

const MINUTE = 60_000;
const tokens = (input, read, write = 0) => ({ input, output: 100, reasoning: 20, cache: { read, write } });
const session = (id, usage, parentID) => ({ id, tokens: usage, parentID });
const anthropic = { providerID: "anthropic", id: "claude-opus-5-5" };
const openai = { providerID: "openai", id: "gpt-6-astra" };
const step = (sessionID, model, started, usage, running = false) => ({ sessionID, model, started, tokens: usage, running });

test("uses cache read divided by all input tokens, not output or reasoning", () => {
  assert.equal(cacheHit([session("ses_root", tokens(100, 9900))]), 99);
  assert.equal(cacheHit([session("ses_root", tokens(100, 800, 100))]), 80);
  assert.equal(cacheHit([session("ses_root", tokens(1000, 0))]), 0);
  assert.equal(cacheHit([session("ses_root", tokens(0, 1000))]), 100);
  assert.equal(cacheHit([session("ses_root", tokens(0, 0, 1000))]), 0);
  assert.equal(cacheHit([session("ses_root", tokens(10, 90)), session("ses_child", tokens(900, 0))]), 9);
});

test("shows no percentage before input usage is available", () => {
  assert.equal(cacheHit([]), undefined);
  assert.equal(cacheHit([{ id: "ses_empty" }]), undefined);
  assert.equal(cacheHit([session("ses_empty", tokens(0, 0))]), undefined);
  for (const invalid of [NaN, Infinity, -1, undefined]) {
    assert.equal(cacheHit([session("ses_invalid", tokens(invalid, 100))]), undefined);
  }
});

test("uses known TTLs and marks other values as estimates", () => {
  assert.deepEqual(cacheTTL(anthropic), { ms: 5 * MINUTE, exact: true });
  for (const id of ["gpt-5.6-luna", "gpt-6-astra", "gpt-6.1-sol-fast"]) {
    assert.deepEqual(cacheTTL({ providerID: "openai", id }), { ms: 30 * MINUTE, exact: true });
  }
  for (const id of ["gpt-5.5", "gpt-5", "o3"]) {
    assert.deepEqual(cacheTTL({ providerID: "openai", id }), { ms: 10 * MINUTE, exact: false });
  }
  assert.deepEqual(cacheTTL({ providerID: "fireworks-ai", id: "deepseek" }), { ms: 5 * MINUTE, exact: false });
});

function state(steps, now) {
  const sessions = new Map([
    ["ses_root", session("ses_root", tokens(100, 900))],
    ["ses_child", session("ses_child", tokens(500, 500), "ses_root")],
  ]);
  return { rootID: "ses_root", sessions, steps: new Map(steps.map((item, index) => [`msg_${index}`, item])), now };
}

test("divides each provider row into the main session and sub-agents", () => {
  const now = 100 * MINUTE;
  const summary = summarize(state([
    step("ses_root", anthropic, now - MINUTE, tokens(10, 90)),
    step("ses_child", anthropic, now - 2 * MINUTE, tokens(50, 50)),
    step("ses_child", openai, now - 10 * MINUTE, tokens(20, 80)),
    step("ses_other", openai, now - MINUTE, tokens(100, 0)),
  ], now));
  assert.deepEqual(summary, {
    rows: [
      { providerID: "anthropic", main: 90, subs: 50, left: { ms: 4 * MINUTE, exact: true } },
      { providerID: "openai", main: undefined, subs: 80, left: { ms: 20 * MINUTE, exact: true } },
    ],
    total: { main: 90, subs: 50 },
  });
});

test("removes a row when its cache expires and shows the full TTL while a step runs", () => {
  const now = 100 * MINUTE;
  const expired = summarize(state([step("ses_root", anthropic, now - 5 * MINUTE, tokens(10, 90))], now));
  assert.deepEqual(expired.rows, []);
  const active = summarize(state([
    step("ses_root", anthropic, now - 6 * MINUTE, tokens(10, 90)),
    step("ses_root", anthropic, now - 2 * MINUTE, undefined, true),
  ], now));
  assert.deepEqual(active.rows, [{ providerID: "anthropic", main: undefined, subs: undefined, left: { ms: 5 * MINUTE, exact: true } }]);
});

test("uses the newest model of a provider and only requests in its window", () => {
  const now = 100 * MINUTE;
  const summary = summarize(state([
    step("ses_root", { providerID: "openai", id: "gpt-6-astra" }, now - 20 * MINUTE, tokens(100, 0)),
    step("ses_root", { providerID: "openai", id: "gpt-5.5" }, now - MINUTE, tokens(10, 90)),
  ], now));
  assert.deepEqual(summary.rows, [{ providerID: "openai", main: 90, subs: undefined, left: { ms: 9 * MINUTE, exact: false } }]);
});

test("formats aligned columns without a border", () => {
  assert.deepEqual(formatTable(undefined), [
    "Cache      main  subs   left",
    "total         —     —",
  ]);
  assert.deepEqual(formatTable({
    rows: [
      { providerID: "anthropic", main: 96, subs: 91, left: { ms: 192_000, exact: true } },
      { providerID: "fireworks-ai", main: undefined, subs: 100, left: { ms: 61_000, exact: false } },
      { providerID: "openai", main: 5, subs: undefined, left: { ms: 30 * MINUTE, exact: true } },
    ],
    total: { main: 95, subs: undefined },
  }), [
    "Cache      main  subs   left",
    "anthropic   96%   91%     4m",
    "firework…     —  100%    ~2m",
    "openai       5%     —    30m",
    "total       95%     —",
  ]);
});

test("shows whole minutes, then seconds in the last minute", () => {
  const lefts = [30 * MINUTE, 5 * MINUTE, 4 * MINUTE + 1, 2 * MINUTE, MINUTE + 1, MINUTE, 59_001, 59_000, 9_500, 1].map((ms) =>
    formatTable({ rows: [{ providerID: "anthropic", left: { ms, exact: true } }], total: {} })[1].split(" ").at(-1));
  assert.deepEqual(lefts, ["30m", "5m", "5m", "2m", "2m", "1m", "1m", "0:59", "0:10", "0:01"]);
});
