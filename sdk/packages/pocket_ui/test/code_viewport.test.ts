import { expect, test } from "bun:test";
import { caretPosition, columnToX, defaultCellWidth, gutterDigits, gutterWidth, hitTest, scrollToReveal, visibleRange, xToColumn, type ViewMetrics } from "../src/code/index.ts";

const M: ViewMetrics = { lineHeight: 20, charWidth: 10, tabSize: 4, paddingLeft: 8, gutterPadding: 8 };

test("visibleRange: overscan, clamping, empty and short docs", () => {
  expect(visibleRange(1000, 20, 200, 0, 2)).toEqual({ first: 0, last: 12, offsetY: 0, contentHeight: 20000 });
  expect(visibleRange(1000, 20, 200, 1000, 2)).toMatchObject({ first: 48, last: 62, offsetY: 960 });
  expect(visibleRange(1000, 20, 200, 1010, 0)).toMatchObject({ first: 50, last: 61 }); // partially visible line counts
  expect(visibleRange(1000, 20, 200, 1e9, 2).last).toBe(1000);
  expect(visibleRange(1000, 20, 200, -50, 2).first).toBe(0);
  expect(visibleRange(0, 20, 200, 0)).toEqual({ first: 0, last: 0, offsetY: 0, contentHeight: 0 });
  expect(visibleRange(3, 20, 200, 0, 5)).toMatchObject({ first: 0, last: 3 });
});

test("gutter width grows with digit count", () => {
  expect(gutterDigits(1)).toBe(2);
  expect(gutterDigits(99)).toBe(2);
  expect(gutterDigits(100)).toBe(3);
  expect(gutterDigits(5000)).toBe(4);
  expect(gutterDigits(100000)).toBe(6);
  expect(gutterWidth(5000, M)).toBe(4 * 10 + 16);
});

test("columnToX: ASCII, tabs, CJK double width, combining, emoji, measured hook", () => {
  expect(columnToX("abc", 2, M)).toBe(20);
  expect(columnToX("abc", 99, M)).toBe(30);
  expect(columnToX("a\tb", 2, M)).toBe(40);       // tab to the next multiple of 4
  expect(columnToX("你好a", 2, M)).toBe(40);
  expect(columnToX("éx", 2, M)).toBe(10);
  expect(columnToX("😀a", 2, M)).toBe(20);
  expect(columnToX("ab", 2, { ...M, measure: cp => (cp === 97 ? 1.5 : 1) })).toBe(25);
  expect(defaultCellWidth(0x200d)).toBe(0);
  expect(defaultCellWidth(0x4e2d)).toBe(2);
});

test("xToColumn rounds at half a glyph and snaps to clusters", () => {
  expect(xToColumn("abc", 0, M)).toBe(0);
  expect(xToColumn("abc", 4.9, M)).toBe(0);
  expect(xToColumn("abc", 5, M)).toBe(1);
  expect(xToColumn("abc", 14, M)).toBe(1);
  expect(xToColumn("abc", 15, M)).toBe(2);
  expect(xToColumn("abc", 1000, M)).toBe(3);
  expect(xToColumn("abc", -30, M)).toBe(0);
  expect(xToColumn("你好", 9, M)).toBe(0);
  expect(xToColumn("你好", 11, M)).toBe(1);
  expect(xToColumn("你好", 29, M)).toBe(1);
  expect(xToColumn("你好", 31, M)).toBe(2);
  expect(xToColumn("a😀b", 12, M)).toBe(1);
  expect(xToColumn("a😀b", 25, M)).toBe(3);   // never inside the surrogate pair
  expect(xToColumn("éx", 6, M)).toBe(2); // cluster is 1 cell: past half -> after the mark
  expect(xToColumn("a\tb", 25, M)).toBe(2);
  expect(xToColumn("", 50, M)).toBe(0);
  const long = "x".repeat(100_000);
  expect(xToColumn(long, 500_000, M)).toBe(50_000);
});

test("caretPosition and hitTest round trip with scroll", () => {
  const lines = ["hello", "你好 world", ""];
  const g = gutterWidth(lines.length, M);
  const c = caretPosition(lines[1], 1, 3, M, g, 0, 0);
  expect(c).toEqual({ x: g + 8 + 50, y: 20, height: 20 });
  const hit = hitTest(c.x, c.y + 3, lines.length, i => lines[i], M, g);
  expect(hit).toEqual({ line: 1, column: 3 });
  // scrolled
  const c2 = caretPosition(lines[0], 0, 2, M, g, 10, 5);
  expect(c2.y).toBe(-10); expect(c2.x).toBe(g + 8 + 20 - 5);
  expect(hitTest(c2.x, 5, lines.length, i => lines[i], M, g, 10, 5)).toEqual({ line: 0, column: 2 });
  // clamped
  expect(hitTest(-100, -100, 3, i => lines[i], M, g)).toEqual({ line: 0, column: 0 });
  expect(hitTest(1e6, 1e6, 3, i => lines[i], M, g)).toEqual({ line: 2, column: 0 });
  expect(hitTest(0, 25, 3, i => lines[i], M, g)).toEqual({ line: 1, column: 0 }); // in the gutter
  expect(hitTest(0, 0, 0, () => "", M, g)).toEqual({ line: 0, column: 0 });
});

test("scrollToReveal moves minimally", () => {
  expect(scrollToReveal(5, 20, 200, 0)).toBe(0);
  expect(scrollToReveal(10, 20, 200, 0)).toBe(20);
  expect(scrollToReveal(0, 20, 200, 100)).toBe(0);
  expect(scrollToReveal(7, 20, 200, 100)).toBe(100);
});
