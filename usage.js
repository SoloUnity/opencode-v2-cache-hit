import { MAX_TTL, summarize } from "./cache.js";

// Use session counters for totals, not the TUI's limited message history.
// Requests come from step events, and from recent messages when the view loads.
// The client API works against both the local service and remote OpenCode servers.
export function watchSession(context, sessionID, update, { now = Date.now } = {}) {
  const controller = new AbortController();
  let sessions = new Map();
  let steps = new Map();
  let inFlightUsage;
  let inFlightSteps;
  let ready = false;
  let disposed = false;
  let running = false;
  let pending = false;
  let timer;
  let ticker;

  function publish() {
    if (disposed) return;
    const cutoff = now() - MAX_TTL;
    for (const [id, step] of steps) if (step.started < cutoff) steps.delete(id);
    const summary = ready ? summarize({ rootID: sessionID, sessions, steps, now: now() }) : undefined;
    update(summary);
    if (disposed) return;
    // Countdowns change each second. Tick only while a provider row shows.
    if (summary?.rows.length && !ticker) ticker = setInterval(publish, 1000);
    if (!summary?.rows.length && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  async function loadSteps(list, options) {
    const cutoff = now() - MAX_TTL;
    const loaded = new Map();
    await Promise.all(list.filter((session) => !(session.time?.updated < cutoff)).map(async (session) => {
      let cursor;
      do {
        const page = await context.client.message.list({
          sessionID: session.id,
          type: "assistant",
          limit: 50,
          ...(cursor ? { cursor } : { order: "desc" }),
        }, options);
        if (disposed) return;
        cursor = page.cursor?.next;
        for (const message of page.data) {
          if (message.type !== "assistant") continue;
          if (message.time.created < cutoff) {
            cursor = undefined;
            break;
          }
          loaded.set(message.id, {
            sessionID: session.id,
            model: message.model,
            started: message.time.created,
            tokens: message.tokens,
            running: message.time.completed === undefined && message.tokens === undefined,
          });
        }
      } while (cursor);
    }));
    return loaded;
  }

  async function refresh() {
    if (disposed) return;
    pending = true;
    if (running) return;
    running = true;
    try {
      while (pending && !disposed) {
        pending = false;
        inFlightUsage = new Map();
        inFlightSteps = new Set();
        try {
          const options = { signal: controller.signal };
          const root = await context.client.session.get({ sessionID }, options);
          if (disposed) return;
          const next = new Map([[root.id, root]]);
          const queue = [root.id];
          for (let index = 0; index < queue.length; index++) {
            let cursor;
            do {
              const page = await context.client.session.list({
                parentID: queue[index],
                limit: 100,
                order: "desc",
                ...(cursor ? { cursor } : {}),
              }, options);
              if (disposed) return;
              for (const child of page.data) {
                if (next.has(child.id)) continue;
                next.set(child.id, child);
                queue.push(child.id);
              }
              cursor = page.cursor?.next;
            } while (cursor);
          }
          const loaded = await loadSteps([...next.values()], options);
          if (disposed) return;
          // An event can arrive after a request started but before it returns.
          // Do not replace its newer values with the request's old snapshot.
          for (const [id, tokens] of inFlightUsage) {
            const session = next.get(id);
            if (session) next.set(id, { ...session, tokens });
          }
          for (const id of inFlightSteps) {
            const step = steps.get(id);
            if (step) loaded.set(id, step);
          }
          sessions = next;
          steps = loaded;
          ready = true;
          publish();
        } catch (error) {
          if (disposed) return;
          ready = false;
          publish();
          console.warn("Cache hit: could not load session usage", error instanceof Error ? error.message : "Request failed");
        } finally {
          inFlightUsage = undefined;
          inFlightSteps = undefined;
        }
      }
    } finally {
      running = false;
    }
  }

  function scheduleRefresh() {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 100);
  }

  // Record steps from all sessions. A new sub-agent can send events before the
  // refresh adds it to the tree. summarize() ignores sessions outside the tree.
  function setSteps(changes) {
    if (disposed || changes.length === 0) return;
    for (const [id, step] of changes) {
      steps.set(id, step);
      inFlightSteps?.add(id);
    }
    if (ready && changes.some(([, step]) => sessions.has(step.sessionID))) publish();
  }

  function endStep({ data }) {
    if (disposed) return;
    const step = steps.get(data.assistantMessageID);
    if (!step) {
      if (sessions.has(data.sessionID)) scheduleRefresh();
      return;
    }
    setSteps([[data.assistantMessageID, { ...step, running: false, tokens: data.tokens ?? step.tokens }]]);
  }

  function endSession(id) {
    setSteps([...steps].filter(([, step]) => step.sessionID === id && step.running)
      .map(([stepID, step]) => [stepID, { ...step, running: false }]));
  }

  const stops = [
    context.data.on("session.usage.updated", ({ data }) => {
      if (disposed) return;
      inFlightUsage?.set(data.sessionID, data.tokens);
      const session = sessions.get(data.sessionID);
      if (session) {
        sessions.set(session.id, { ...session, tokens: data.tokens });
        publish();
      }
      if (!ready) scheduleRefresh();
    }),
    context.data.on("session.step.started", ({ data }) => {
      if (disposed) return;
      // A new step ends the previous step in the same session.
      const ended = [...steps].filter(([id, step]) => id !== data.assistantMessageID && step.sessionID === data.sessionID && step.running)
        .map(([id, step]) => [id, { ...step, running: false }]);
      setSteps([...ended, [data.assistantMessageID, {
        sessionID: data.sessionID,
        model: data.model,
        started: Number.isFinite(data.started) ? data.started : now(),
        running: true,
      }]]);
    }),
    context.data.on("session.step.ended", endStep),
    context.data.on("session.step.failed", endStep),
    context.data.on("session.execution.succeeded", ({ data }) => endSession(data.sessionID)),
    context.data.on("session.execution.failed", ({ data }) => endSession(data.sessionID)),
    context.data.on("session.execution.interrupted", ({ data }) => endSession(data.sessionID)),
    context.data.on("session.created", scheduleRefresh),
    context.data.on("session.deleted", scheduleRefresh),
    context.data.on("client.connection", scheduleRefresh),
  ];
  update(undefined);
  void refresh();

  return () => {
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    clearInterval(ticker);
    stops.forEach((stop) => stop());
  };
}
