export function cacheHit(sessions) {
  let read = 0;
  let input = 0;
  for (const session of sessions) {
    const tokens = session.tokens;
    if (!tokens) continue;
    const values = [tokens.input, tokens.cache?.read, tokens.cache?.write];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return;
    read += tokens.cache.read;
    input += tokens.input + tokens.cache.read + tokens.cache.write;
  }
  if (input > 0) return Math.round((read / input) * 100);
}

export function formatCacheHit(percent) {
  return percent === undefined ? "— cache hit" : `${percent}% cache hit`;
}

// Use session counters, not the TUI's limited message history. The client API
// works against both the local service and remote OpenCode servers.
export function watchSession(context, sessionID, update) {
  const controller = new AbortController();
  let sessions = new Map();
  let inFlightUsage;
  let ready = false;
  let disposed = false;
  let running = false;
  let pending = false;
  let timer;

  function publish() {
    update(ready ? cacheHit(sessions.values()) : undefined);
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
          // An event can arrive after a request started but before it returns.
          // Do not replace its newer counters with the request's old snapshot.
          for (const [id, tokens] of inFlightUsage) {
            const session = next.get(id);
            if (session) next.set(id, { ...session, tokens });
          }
          sessions = next;
          ready = true;
          publish();
        } catch (error) {
          if (disposed) return;
          ready = false;
          publish();
          console.warn("Cache hit: could not load session usage", error instanceof Error ? error.message : "Request failed");
        } finally {
          inFlightUsage = undefined;
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
    stops.forEach((stop) => stop());
  };
}
