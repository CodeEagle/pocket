/**
 * Pure virtualization / geometry math for a monospace code view.
 *
 * Widths: the caller supplies `charWidth` (advance of one narrow cell).
 * Wide characters (CJK, fullwidth, most emoji) default to 2 cells and
 * combining marks / ZWJ / variation selectors to 0; tabs advance to the next
 * `tabSize` column. For exact widths of a proportional or fallback font the
 * caller can provide `measure(codePoint) => cells` (the host text layout is
 * the only source of truth for CJK glyph widths); results are in cell units,
 * so a measured 1.7 for a fallback glyph is allowed.
 */
import { isCombining, nextBoundary } from "./buffer.ts";

export interface ViewMetrics {
  lineHeight: number;
  /** Advance of a narrow cell in px. */
  charWidth: number;
  /** Optional per-code-point width in cells. Default: `defaultCellWidth`. */
  measure?: (codePoint: number) => number;
  tabSize?: number;
  /** Left padding between the gutter and the text, px. */
  paddingLeft?: number;
  /** Gutter horizontal padding (each side), px. */
  gutterPadding?: number;
}

export interface VisibleRange {
  /** First line to render (inclusive), including overscan. */
  first: number;
  /** Last line to render (exclusive), including overscan. */
  last: number;
  /** Y of line `first` in content coordinates (first * lineHeight). */
  offsetY: number;
  /** Total content height. */
  contentHeight: number;
}

export function visibleRange(lineCount: number, lineHeight: number, viewportHeight: number, scrollTop: number, overscan = 5): VisibleRange {
  const contentHeight = lineCount * lineHeight;
  if (lineCount <= 0 || lineHeight <= 0) return { first: 0, last: 0, offsetY: 0, contentHeight: 0 };
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, contentHeight - viewportHeight)));
  const first = Math.max(0, Math.floor(top / lineHeight) - overscan);
  const last = Math.min(lineCount, Math.ceil((top + viewportHeight) / lineHeight) + overscan);
  return { first, last, offsetY: first * lineHeight, contentHeight };
}

/** Number of decimal digits shown in the gutter (min 2). */
export function gutterDigits(lineCount: number): number { let d = 2, v = 100; while (lineCount >= v) { d++; v *= 10; } return d; }

export function gutterWidth(lineCount: number, m: ViewMetrics): number {
  return gutterDigits(lineCount) * m.charWidth + 2 * (m.gutterPadding ?? 8);
}

/** Cells for a code point: 0 for combining marks / ZWJ, 2 for wide, else 1. */
export function defaultCellWidth(cp: number): number {
  if (cp === 0x200d || isCombining(cp)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

/** X offset (px, relative to the start of the text area) of UTF-16 column `col` in `text`. */
export function columnToX(text: string, col: number, m: ViewMetrics): number {
  const measure = m.measure ?? defaultCellWidth, tab = m.tabSize ?? 4;
  const end = Math.min(col, text.length);
  let cells = 0;
  for (let i = 0; i < end;) {
    const cp = text.codePointAt(i) as number;
    if (cp === 9) cells += tab - (cells % tab);
    else cells += measure(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return cells * m.charWidth;
}

/** Nearest cluster boundary column for text-area x (px), rounding at half a glyph. */
export function xToColumn(text: string, x: number, m: ViewMetrics): number {
  if (x <= 0) return 0;
  const measure = m.measure ?? defaultCellWidth, tab = m.tabSize ?? 4;
  let cells = 0, col = 0;
  const target = x / m.charWidth;
  while (col < text.length) {
    const next = nextBoundary(text, col);
    let w = 0;
    for (let i = col; i < next;) {
      const cp = text.codePointAt(i) as number;
      w += cp === 9 ? tab - ((cells + w) % tab) : measure(cp);
      i += cp > 0xffff ? 2 : 1;
    }
    if (target < cells + w / 2) return col;
    cells += w; col = next;
    if (target < cells) return col;
  }
  return text.length;
}

export interface CaretPosition { x: number; y: number; height: number }

/** Caret rectangle in viewport coordinates (scroll applied). */
export function caretPosition(lineText: string, line: number, col: number, m: ViewMetrics, gutter: number, scrollTop = 0, scrollLeft = 0): CaretPosition {
  return { x: gutter + (m.paddingLeft ?? 8) + columnToX(lineText, col, m) - scrollLeft, y: line * m.lineHeight - scrollTop, height: m.lineHeight };
}

/** Pointer (viewport x,y) -> clamped (line, column). `lineText(i)` supplies line content. */
export function hitTest(x: number, y: number, lineCount: number, lineText: (i: number) => string, m: ViewMetrics, gutter: number, scrollTop = 0, scrollLeft = 0): { line: number; column: number } {
  let line = Math.floor((y + scrollTop) / m.lineHeight);
  line = line < 0 ? 0 : line >= lineCount ? lineCount - 1 : line;
  if (line < 0) line = 0;
  const text = lineText(line);
  return { line, column: xToColumn(text, x - gutter - (m.paddingLeft ?? 8) + scrollLeft, m) };
}

/** Scroll offset that keeps `line` fully visible (minimal movement). */
export function scrollToReveal(line: number, lineHeight: number, viewportHeight: number, scrollTop: number): number {
  const top = line * lineHeight, bottom = top + lineHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}
