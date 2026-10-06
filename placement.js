export function placeLine(marker, line) {
  if (marker.isDestroyed || line.isDestroyed) return;
  const section = marker.parent?.getChildren().find((node) =>
    node.getChildren()[0]?.plainText?.trim() === "Context"
  );
  if (!section) {
    if (line.parent !== marker) marker.add(line);
    return;
  }

  // V2 has one slot for the complete sidebar, but none inside Context.
  // Insert only our own line with the public OpenTUI renderable API.
  const children = section.getChildren().filter((node) => node !== line);
  const anchor = children.findLast((node) => /(?:% used| tokens)$/u.test(node.plainText?.trim() ?? "")) ?? children[0];
  const next = children[children.indexOf(anchor) + 1];
  const current = section.getChildren();
  if (line.parent === section && current[current.indexOf(anchor) + 1] === line) return;
  if (next) section.insertBefore(line, next);
  else section.add(line);
}
