function heading(node) {
  return node.getChildren()[0]?.plainText?.trim() ?? "";
}

export function placeSection(section) {
  const parent = section.parent;
  if (!parent || section.isDestroyed) return;
  const siblings = parent.getChildren();
  const context = siblings.find((sibling) => heading(sibling) === "Context");
  // Tokens Used Today places itself after Cache. Without Context, go before it
  // so that the two sections do not move each other on each frame.
  const before = siblings.find((sibling) => heading(sibling) === "Tokens Used Today")
    ?? siblings.find((sibling) => /^(?:[▼▶]\s*)?MCP(?:\s|$)/u.test(heading(sibling)));

  // V2 exposes one slot for all sidebar sections. Move only our own renderable
  // within that slot, using OpenTUI's public API. The built-in sections stay live.
  if (context) {
    const next = siblings[siblings.indexOf(context) + 1];
    if (next === section) return;
    if (next) parent.insertBefore(section, next);
    else parent.add(section);
  } else if (before && siblings[siblings.indexOf(before) - 1] !== section) {
    parent.insertBefore(section, before);
  }
}
