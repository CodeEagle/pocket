import { expect, test } from "bun:test";
import { buildTree, toggled, visibleRows } from "../src/tree-model.ts";
import { clampSplit, dragSplit } from "../src/split-pane-model.ts";
import { stepTab } from "../src/tabs-model.ts";

const files = [
  { path: "app.tsx", bytes: 1 }, { path: "src/b.ts", bytes: 2 }, { path: "src/a.ts", bytes: 3 },
  { path: "src/deep/c.ts", bytes: 4 }, { path: "manifest.json", bytes: 5 },
];

test("tree model: folders first, sorted, empty folders, visible rows by expanded set", () => {
  const tree = buildTree(files, ["empty/inner"]);
  expect(tree.map((n) => n.name)).toEqual(["empty", "src", "app.tsx", "manifest.json"]);
  expect(tree[0]!.children[0]!.name).toBe("inner");
  expect(visibleRows(tree, new Set()).map((r) => r.node.path)).toEqual(["empty", "src", "app.tsx", "manifest.json"]);
  const open = toggled(toggled(new Set<string>(), "src"), "src/deep");
  expect(visibleRows(tree, open).map((r) => `${r.depth}:${r.node.path}`)).toEqual(
    ["0:empty", "0:src", "1:src/deep", "2:src/deep/c.ts", "1:src/a.ts", "1:src/b.ts", "0:app.tsx", "0:manifest.json"]);
  expect([...toggled(open, "src")]).toEqual(["src/deep"]);
  expect(open.has("src")).toBe(true); // toggled copies
});

test("split model: clamping and drag direction", () => {
  const lim = { min: 100, max: 400 };
  expect(clampSplit(50, lim)).toBe(100);
  expect(clampSplit(999, lim)).toBe(400);
  expect(clampSplit(Number.NaN, lim)).toBe(100);
  expect(clampSplit(150.6, lim)).toBe(151);
  expect(clampSplit(10, { min: 300, max: 200 })).toBe(300); // inverted limits: min wins
  expect(dragSplit(200, 30, "first", lim)).toBe(230);
  expect(dragSplit(200, 30, "second", lim)).toBe(170);
  expect(dragSplit(390, 30, "first", lim)).toBe(400);
  expect(dragSplit(110, 30, "second", lim)).toBe(100);
});

test("stepTab wraps and handles no tabs / no active tab", () => {
  const tabs = [{ id: "a", label: "a" }, { id: "b", label: "b" }, { id: "c", label: "c" }];
  expect(stepTab([], "a", 1)).toBe(-1);
  expect(stepTab(tabs, "a", 1)).toBe(1);
  expect(stepTab(tabs, "c", 1)).toBe(0);
  expect(stepTab(tabs, "a", -1)).toBe(2);
  expect(stepTab(tabs, undefined, 1)).toBe(0);
  expect(stepTab(tabs, undefined, -1)).toBe(2);
  expect(stepTab(tabs, "gone", 1)).toBe(0);
});
