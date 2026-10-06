import assert from "node:assert/strict";
import { test } from "node:test";
import { placeLine } from "../placement.js";

class Node {
  constructor(plainText) {
    this.plainText = plainText;
    this.children = [];
    this.moves = 0;
  }
  getChildren() { return [...this.children]; }
  add(node) {
    node.parent?.remove(node);
    this.children.push(node);
    node.parent = this;
    this.moves++;
  }
  remove(node) { this.children.splice(this.children.indexOf(node), 1); }
  insertBefore(node, anchor) {
    node.parent?.remove(node);
    this.children.splice(this.children.indexOf(anchor), 0, node);
    node.parent = this;
    this.moves++;
  }
}

function fixture(lines = ["Context", "49,204 tokens", "5% used", "$1.00 spent"]) {
  const parent = new Node();
  const section = new Node();
  for (const text of lines) section.add(new Node(text));
  const today = new Node();
  today.add(new Node("Tokens Used Today"));
  const marker = new Node();
  const line = new Node("99% cache hit");
  marker.add(line);
  parent.add(section);
  parent.add(today);
  parent.add(marker);
  return { parent, section, marker, line, names: () => section.getChildren().map((node) => node.plainText) };
}

test("places the line inside Context after percent used and before cost", () => {
  const f = fixture();
  const siblings = f.parent.getChildren();
  placeLine(f.marker, f.line);
  assert.deepEqual(f.names(), ["Context", "49,204 tokens", "5% used", "99% cache hit", "$1.00 spent"]);
  assert.deepEqual(f.parent.getChildren(), siblings);
  const moves = f.section.moves;
  placeLine(f.marker, f.line);
  assert.equal(f.section.moves, moves);
});

test("works when the existing cost line is hidden or absent", () => {
  const f = fixture(["Context", "49,204 tokens", "5% used"]);
  placeLine(f.marker, f.line);
  assert.deepEqual(f.names(), ["Context", "49,204 tokens", "5% used", "99% cache hit"]);
});

test("works without a model context limit", () => {
  const f = fixture(["Context", "49,204 tokens", "$1.00 spent"]);
  placeLine(f.marker, f.line);
  assert.deepEqual(f.names(), ["Context", "49,204 tokens", "99% cache hit", "$1.00 spent"]);
});

test("waits for Context to mount and can move into a replacement section", () => {
  const f = fixture();
  f.parent.remove(f.section);
  placeLine(f.marker, f.line);
  assert.equal(f.line.parent, f.marker);
  f.parent.add(f.section);
  placeLine(f.marker, f.line);
  assert.equal(f.line.parent, f.section);
  f.parent.remove(f.section);
  const next = new Node();
  next.add(new Node("Context"));
  next.add(new Node("50,000 tokens"));
  f.parent.add(next);
  placeLine(f.marker, f.line);
  assert.equal(f.line.parent, next);
  assert.deepEqual(next.getChildren().map((node) => node.plainText), ["Context", "50,000 tokens", "99% cache hit"]);
});

test("leaves destroyed or unmounted renderables alone", () => {
  const f = fixture();
  f.marker.parent = undefined;
  placeLine(f.marker, f.line);
  assert.equal(f.line.parent, f.marker);
  f.marker.parent = f.parent;
  f.line.isDestroyed = true;
  placeLine(f.marker, f.line);
  assert.equal(f.line.parent, f.marker);
});
