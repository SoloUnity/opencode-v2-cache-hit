import { BoxRenderable, TextRenderable } from "@opentui/core";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { placeLine } from "./placement.js";
import { formatCacheHit, watchSession } from "./usage.js";

const id = "opencode-v2-cache-hit";

export default {
  id,
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render(props) {
        const [percent, setPercent] = createSignal();
        const marker = new BoxRenderable(context.renderer, {
          id: `${id}-${crypto.randomUUID()}`,
          position: "absolute",
          width: 0,
          height: 0,
        });
        let line;
        let content = formatCacheHit();
        let color;

        createEffect(() => {
          const stop = watchSession(context, props.sessionID, setPercent);
          onCleanup(stop);
        });
        createEffect(() => {
          content = formatCacheHit(percent());
          color = context.theme.text.muted;
          if (line && !line.isDestroyed) {
            line.content = content;
            line.fg = color;
          }
        });

        // Keep placement correct when Context mounts late or is rebuilt.
        // The marker stays in the slot. Only the metric moves into Context.
        marker.onLifecyclePass = () => {
          if (!line || line.isDestroyed) {
            line = new TextRenderable(context.renderer, {
              id: `${id}-line-${crypto.randomUUID()}`,
              content,
              fg: color,
              flexShrink: 0,
            });
            marker.add(line);
          }
          placeLine(marker, line);
        };
        onCleanup(() => {
          if (line && !line.isDestroyed) line.destroyRecursively();
          marker.destroyRecursively();
        });
        return marker;
      },
    });
  },
};
