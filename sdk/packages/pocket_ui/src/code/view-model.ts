/**
 * Pure helpers behind `CodeView` (view.tsx): no framework imports, unit-tested in bun.
 */
import { columnToX, defaultCellWidth, type ViewMetrics } from "./viewport.ts";
import { colorFor, type TokenTheme } from "./theme.ts";

/** "#rrggbb" / "#rrggbbaa" -> Core ABGR u32 (the InlineText run colour format). */
export function hexToAbgr(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export interface Run { start: number; end: number; color: number }

export interface LineModel {
  /** Text actually rendered: tabs expanded, spaces optionally replaced by NBSP. */
  display: string;
  /** Source UTF-16 column -> display UTF-16 column (length text.length + 1). */
  colMap: number[];
  /** Colour runs in Unicode codepoints of `display`, sorted, disjoint, merged. */
  runs: Run[];
}

/**
 * Build the render model of one line. `tokens` is the tokenizer's flat
 * [start,end,kind,...] (UTF-16 columns of `text`). Plain-coloured stretches
 * produce no run (they use the node's base colour).
 */
export function buildLineModel(text: string, tokens: number[] | undefined, theme: TokenTheme, tabSize: number, nbsp: boolean, maxCols = 4000): LineModel {
  const fg = hexToAbgr(theme.foreground);
  const colMap: number[] = new Array(text.length + 1);
  let display = "";
  let dcol = 0, cells = 0;
  const sp = nbsp ? " " : " ";
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) as number;
    const len = cp > 0xffff ? 2 : 1;
    for (let k = 0; k < len; k++) colMap[i + k] = dcol + (k ? 0 : 0);
    if (cp === 9) {
      const n = tabSize - (cells % tabSize);
      display += sp.repeat(n); dcol += n; cells += n;
    } else if (cp === 32) { display += sp; dcol += 1; cells += 1; }
    else { display += cp > 0xffff ? text.slice(i, i + 2) : text[i]; dcol += len; cells += defaultCellWidth(cp); }
    i += len;
  }
  colMap[text.length] = dcol;
  if (display.length > maxCols) display = display.slice(0, maxCols);
  const runs: Run[] = [];
  if (tokens) {
    const needsCp = hasAstral(display);
    for (let t = 0; t + 2 < tokens.length; t += 3) {
      const s = colMap[tokens[t]], e = colMap[Math.min(tokens[t + 1], text.length)];
      if (s === undefined || e === undefined || e <= s || s >= display.length) continue;
      const color = hexToAbgr(colorFor(theme, tokens[t + 2]));
      if (color === fg) continue;
      const end = Math.min(e, display.length);
      const cs = needsCp ? cpIndex(display, s) : s, ce = needsCp ? cpIndex(display, end) : end;
      const last = runs[runs.length - 1];
      if (last && last.end === cs && last.color === color) last.end = ce;
      else if (!last || cs >= last.end) runs.push({ start: cs, end: ce, color });
    }
  }
  return { display, colMap, runs };
}

function hasAstral(s: string): boolean { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) return true; } return false; }
/** UTF-16 index -> codepoint index. */
export function cpIndex(s: string, idx: number): number { let n = 0; for (let i = 0; i < idx && i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) i++; n++; } return n; }

// ---------------------------------------------------------------------------
// Metrics calibration
// ---------------------------------------------------------------------------

export interface CalibrationSample { digit: number; space: number; nbsp: number; cjk: number }
export interface CalibratedMetrics { charWidth: number; spaceCells: number; cjkCells: number; nbsp: boolean; monospace: boolean }

/** Samples are the widths of 20 digits, 20 spaces, 20 NBSP and 10 CJK ideographs. */
export function calibrate(s: CalibrationSample): CalibratedMetrics | null {
  if (!(s.digit > 0)) return null;
  const cw = s.digit / 20;
  const spaceCells = s.space / 20 / cw, nbspCells = s.nbsp / 20 / cw;
  const nbsp = nbspCells > 0 && Math.abs(nbspCells - 1) < Math.abs(spaceCells - 1);
  const cjkCells = s.cjk > 0 ? s.cjk / 10 / cw : 2;
  return { charWidth: cw, spaceCells: nbsp ? nbspCells : spaceCells, cjkCells, nbsp, monospace: Math.abs((nbsp ? nbspCells : spaceCells) - 1) < 0.05 };
}

/** ViewMetrics for the display string (tabs already expanded, so no tab handling). */
export function makeMetrics(lineHeight: number, cal: { charWidth: number; spaceCells: number; cjkCells: number }, measure?: (cp: number) => number, gutterPadding = 8, paddingLeft = 8): ViewMetrics {
  const m = measure ?? ((cp: number): number => {
    if (cp === 0x20 || cp === 0xa0) return cal.spaceCells;
    const w = defaultCellWidth(cp);
    return w === 2 ? cal.cjkCells : w;
  });
  // tabSize is irrelevant for display text (no tabs); keep a huge value for safety.
  return { lineHeight, charWidth: cal.charWidth, measure: m, tabSize: 1, gutterPadding, paddingLeft };
}

/** x (px, text-area relative) of a SOURCE column of a line. */
export function sourceColX(model: LineModel, col: number, m: ViewMetrics): number {
  return columnToX(model.display, model.colMap[Math.min(col, model.colMap.length - 1)], m);
}

/** Display column -> nearest source column (inverse of colMap for hit-testing). */
export function displayToSourceCol(model: LineModel, dcol: number): number {
  const map = model.colMap;
  let best = 0;
  for (let i = 0; i < map.length; i++) { if (map[i] <= dcol) best = i; else break; }
  // Snap to the closer neighbour when the display column falls inside a tab expansion.
  if (best + 1 < map.length && map[best + 1] - dcol < dcol - map[best]) best++;
  return best;
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------

/** Multi-click counter: same spot within `ms` and `slop` px increments (1..3, then wraps to 1). */
export class ClickTracker {
  private t = -1e9; private x = 0; private y = 0; private n = 0;
  constructor(private ms = 500, private slop = 6) {}
  register(x: number, y: number, now: number): number {
    if (now - this.t <= this.ms && Math.abs(x - this.x) <= this.slop && Math.abs(y - this.y) <= this.slop) this.n = this.n >= 3 ? 1 : this.n + 1;
    else this.n = 1;
    this.t = now; this.x = x; this.y = y;
    return this.n;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";
export interface CodeDiagnostic { line: number; column?: number; severity: DiagnosticSeverity; message: string }

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 };
export const SEVERITY_COLORS: Record<DiagnosticSeverity, string> = { error: "#f85149", warning: "#d29922", info: "#388bfd", hint: "#8b949e" };

/** Worst-severity diagnostic per 0-based line. */
export function diagnosticsByLine(list: readonly CodeDiagnostic[] | undefined): Map<number, CodeDiagnostic[]> {
  const out = new Map<number, CodeDiagnostic[]>();
  for (const d of list ?? []) {
    if (!Number.isFinite(d.line) || d.line < 0) continue;
    const a = out.get(d.line); if (a) a.push(d); else out.set(d.line, [d]);
  }
  for (const a of out.values()) a.sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity]);
  return out;
}

// ---------------------------------------------------------------------------
// Ranges per line (selection / find matches / marked text)
// ---------------------------------------------------------------------------

export interface OffsetRange { from: number; to: number }
export interface LineSpan { line: number; fromCol: number; toCol: number; /** range continues past the line end (draw the newline cell) */ eol: boolean }

/**
 * Split offset ranges into per-line column spans restricted to lines [first, last).
 * `ranges` must be sorted by `from`. `lineOf`/`lineStart`/`lineLen` come from the buffer.
 */
export function spansForLines(ranges: readonly OffsetRange[], first: number, last: number, lineOf: (o: number) => number, lineStart: (l: number) => number, lineLen: (l: number) => number, lineCount: number): LineSpan[] {
  const out: LineSpan[] = [];
  for (const r of ranges) {
    if (r.to <= r.from) continue;
    const l0 = lineOf(r.from), l1 = lineOf(r.to);
    if (l1 < first || l0 >= last) continue;
    for (let l = Math.max(l0, first); l <= Math.min(l1, last - 1); l++) {
      const ls = lineStart(l), len = lineLen(l);
      const fromCol = l === l0 ? r.from - ls : 0;
      const toCol = l === l1 ? r.to - ls : len;
      const eol = l < l1 && l < lineCount - 1;
      if (toCol > fromCol || eol) out.push({ line: l, fromCol, toCol, eol });
    }
  }
  return out;
}

/** Binary search: matches overlapping [lo, hi) from a sorted, disjoint list. */
export function matchesInRange<T extends OffsetRange>(matches: readonly T[], lo: number, hi: number): T[] {
  let a = 0, b = matches.length;
  while (a < b) { const m = (a + b) >> 1; if (matches[m].to <= lo) a = m + 1; else b = m; }
  const out: T[] = [];
  for (let i = a; i < matches.length && matches[i].from < hi; i++) out.push(matches[i]);
  return out;
}

/** Ring-slot -> line for a virtualised window of `slots` rows over lines [first,last); -1 when the slot is unused. */
export function slotLine(slot: number, slots: number, first: number, last: number): number {
  if (slots <= 0) return -1;
  const l = first + (((slot - first) % slots) + slots) % slots;
  return l < last ? l : -1;
}
