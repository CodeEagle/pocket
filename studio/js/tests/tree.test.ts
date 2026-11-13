import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { buildTree, toggled, viewerLines, visibleRows } from "../src/tree.ts";

const files = [
  { path: "app.tsx", bytes: 1 }, { path: "src/b.ts", bytes: 2 }, { path: "src/a.ts", bytes: 3 },
  { path: "src/deep/c.ts", bytes: 4 }, { path: "manifest.json", bytes: 5 },
];

test("flat list becomes a sorted tree with folders first", () => {
  const tree = buildTree(files);
  assert.deepEqual(tree.map((n) => n.name), ["src", "app.tsx", "manifest.json"]);
  assert.deepEqual(tree[0]!.children.map((n) => n.name), ["deep", "a.ts", "b.ts"]);
  assert.equal(tree[0]!.children[2]!.path, "src/b.ts");
});

test("visible rows follow the expanded set and indent by depth", () => {
  const tree = buildTree(files);
  assert.deepEqual(visibleRows(tree, new Set()).map((r) => r.node.path), ["src", "app.tsx", "manifest.json"]);
  const open = toggled(toggled(new Set<string>(), "src"), "src/deep");
  const rows = visibleRows(tree, open);
  assert.deepEqual(rows.map((r) => `${r.depth}:${r.node.path}`), ["0:src", "1:src/deep", "2:src/deep/c.ts", "1:src/a.ts", "1:src/b.ts", "0:app.tsx", "0:manifest.json"]);
  assert.deepEqual([...toggled(open, "src")], ["src/deep"]);
});

test("viewer caps lines and columns", () => {
  const out = viewerLines(Array.from({ length: 1000 }, () => "y".repeat(500)).join("\n"), 10, 20);
  assert.equal(out.lines.length, 10);
  assert.ok(out.truncated);
  assert.equal(out.lines[0]!.length, 21);
  assert.equal(viewerLines("a\nb").truncated, false);
});
