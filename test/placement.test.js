import assert from "node:assert/strict";
import { test } from "node:test";
import { placeSection } from "../placement.js";

function sidebar(headings) {
  const children = headings.map((plainText) => ({ getChildren: () => [{ plainText }] }));
  const section = { getChildren: () => [{ plainText: "Cache      main  subs   left" }] };
  children.push(section);
  let moves = 0;
  const parent = {
    getChildren: () => [...children],
    insertBefore(node, anchor) {
      children.splice(children.indexOf(node), 1);
      children.splice(children.indexOf(anchor), 0, node);
      moves++;
    },
    add(node) {
      children.splice(children.indexOf(node), 1);
      children.push(node);
      moves++;
    },
  };
  section.parent = parent;
  return {
    section, children, moves: () => moves,
    names: () => children.map((child) => child.getChildren()[0].plainText.split(" ")[0]),
  };
}

test("places the section directly after Context and does not move it on later frames", () => {
  const ui = sidebar(["Context", "Tokens Used Today", "MCP"]);
  placeSection(ui.section);
  assert.deepEqual(ui.names(), ["Context", "Cache", "Tokens", "MCP"]);
  placeSection(ui.section);
  assert.equal(ui.moves(), 1);
});

test("places before Tokens Used Today, or before MCP, until Context is available", () => {
  const ui = sidebar(["▶ MCP (3 active)", "Tokens Used Today"]);
  placeSection(ui.section);
  assert.deepEqual(ui.names(), ["▶", "Cache", "Tokens"]);
  const other = sidebar(["▼ MCP"]);
  placeSection(other.section);
  assert.deepEqual(other.names(), ["Cache", "▼"]);
  other.children.push({ getChildren: () => [{ plainText: "Context" }] });
  placeSection(other.section);
  assert.deepEqual(other.names(), ["▼", "Context", "Cache"]);
});

test("leaves an unmounted or destroyed section alone", () => {
  const ui = sidebar(["Context", "MCP"]);
  ui.section.isDestroyed = true;
  placeSection(ui.section);
  ui.section.isDestroyed = false;
  ui.section.parent = null;
  placeSection(ui.section);
  assert.equal(ui.moves(), 0);
});
