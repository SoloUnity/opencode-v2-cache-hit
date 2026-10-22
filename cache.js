const MINUTE = 60_000;
const widths = [10, 5, 6, 7];

// The longest TTL below. An older request cannot keep a cache alive.
export const MAX_TTL = 30 * MINUTE;

export function cacheHit(items) {
  let read = 0;
  let input = 0;
  for (const item of items) {
    const tokens = item.tokens;
    if (!tokens) continue;
    const values = [tokens.input, tokens.cache?.read, tokens.cache?.write];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return;
    read += tokens.cache.read;
    input += tokens.input + tokens.cache.read + tokens.cache.write;
  }
  if (input > 0) return Math.round((read / input) * 100);
}

// Each TTL starts again at the start of every request that reads the cache.
// Anthropic: 5 minutes. OpenAI GPT-5.6 and later: at least 30 minutes.
// Other values are estimates, because the provider does not publish a fixed TTL.
export function cacheTTL(model) {
  if (model?.providerID === "anthropic") return { ms: 5 * MINUTE, exact: true };
  if (model?.providerID === "openai") {
    const [, major, minor = "0"] = /^gpt-(\d+)(?:\.(\d+))?/u.exec(model.id ?? "") ?? [];
    if (Number(major) > 5 || (Number(major) === 5 && Number(minor) >= 6)) return { ms: 30 * MINUTE, exact: true };
    return { ms: 10 * MINUTE, exact: false };
  }
  return { ms: 5 * MINUTE, exact: false };
}

// A provider row stays while its newest request can still have a live cache.
// Its percentages use only the requests in that TTL window.
export function summarize({ rootID, sessions, steps, now }) {
  const root = sessions.get(rootID);
  const children = [...sessions.values()].filter((session) => session.id !== rootID);
  const groups = new Map();
  for (const step of steps.values()) {
    const providerID = step.model?.providerID;
    if (!providerID || !sessions.has(step.sessionID)) continue;
    if (!groups.has(providerID)) groups.set(providerID, []);
    groups.get(providerID).push(step);
  }

  const rows = [];
  for (const [providerID, list] of groups) {
    const latest = list.reduce((newest, step) => (step.started > newest.started ? step : newest));
    const ttl = cacheTTL(latest.model);
    const running = list.some((step) => step.running);
    const ms = latest.started + ttl.ms - now;
    if (!running && ms <= 0) continue;
    const window = list.filter((step) => step.started > now - ttl.ms);
    rows.push({
      providerID,
      main: cacheHit(window.filter((step) => step.sessionID === rootID)),
      subs: cacheHit(window.filter((step) => step.sessionID !== rootID)),
      left: running ? { running } : { ms, exact: ttl.exact },
    });
  }
  rows.sort((a, b) => a.providerID.localeCompare(b.providerID));
  return { rows, total: { main: cacheHit(root ? [root] : []), subs: cacheHit(children) } };
}

function row(cells) {
  return cells.map((cell, index) => (index === 0 ? cell.padEnd(widths[0]) : cell.padStart(widths[index]))).join("").trimEnd();
}

function name(text) {
  return text.length < widths[0] ? text : `${text.slice(0, widths[0] - 2)}…`;
}

function percent(value) {
  return value === undefined ? "—" : `${value}%`;
}

function left({ running, ms, exact }) {
  if (running) return "active";
  const minutes = Math.ceil(ms / MINUTE);
  if (!exact) return `~${minutes}m`;
  const seconds = Math.ceil(ms / 1000);
  return seconds < 60 ? `0:${String(seconds).padStart(2, "0")}` : `${minutes}m`;
}

export function formatTable(summary) {
  return [
    row(["Cache", "main", "subs", "left"]),
    ...(summary?.rows ?? []).map((item) => row([name(item.providerID), percent(item.main), percent(item.subs), left(item.left)])),
    row(["total", percent(summary?.total.main), percent(summary?.total.subs), ""]),
  ];
}
