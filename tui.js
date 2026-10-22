import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { formatTable } from "./cache.js";
import { placeSection } from "./placement.js";
import { watchSession } from "./usage.js";

const id = "opencode-v2-cache-hit";

export default {
  id,
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render(props) {
        const [summary, setSummary] = createSignal();
        const section = new BoxRenderable(context.renderer, {
          id: `${id}-${crypto.randomUUID()}`,
          flexDirection: "column",
          flexShrink: 0,
        });
        const title = new TextRenderable(context.renderer, { attributes: TextAttributes.BOLD });
        const rows = [];
        section.add(title);

        createEffect(() => {
          const stop = watchSession(context, props.sessionID, setSummary);
          onCleanup(stop);
        });
        createEffect(() => {
          const [heading, ...lines] = formatTable(summary());
          title.content = heading;
          title.fg = context.theme.text.base;
          while (rows.length > lines.length) rows.pop().destroyRecursively();
          while (rows.length < lines.length) {
            const row = new TextRenderable(context.renderer, {});
            section.add(row);
            rows.push(row);
          }
          lines.forEach((line, index) => {
            rows[index].content = line;
            rows[index].fg = context.theme.text.muted;
          });
        });

        // Run before layout so late-mounted sidebar sections and plugin
        // reloads keep the requested order without a polling timer.
        section.onLifecyclePass = () => placeSection(section);
        onCleanup(() => section.destroyRecursively());
        return section;
      },
    });
  },
};
