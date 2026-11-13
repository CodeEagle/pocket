/**
 * Pure edit/move commands. A command takes the current buffer + selection and
 * returns a `Transaction` (sorted, non-overlapping edits in ORIGINAL
 * coordinates + the resulting selection in NEW coordinates) without touching
 * the buffer. `applyTransaction` applies one. Commands return null when they
 * would do nothing.
 */
import {
  TextBuffer, BufferChange, nextBoundary, prevBoundary, snapBoundary, wordLeft, wordRight, wordClass,
} from "./buffer.ts";
import {
  Edit, Range, SelectionSet, ChangeMap, normalize, rangeFrom, rangeTo, isEmptyRange, simplify,
} from "./selection.ts";

export type TxKind = "move" | "type" | "delete.back" | "delete.fwd" | "input" | "ime" | "other";

export interface Transaction {
  edits: Edit[];
  selection: SelectionSet;
  kind: TxKind;
}

export interface CommandOptions {
  /** Indent string for Tab/Shift+Tab/auto-indent. Default two spaces; may be "\t". */
  indentUnit: string;
  /** Line comment marker, or null to disable the toggle command. */
  lineComment: string | null;
  /** Auto-close brackets/quotes and overtype closers. */
  autoClose: boolean;
  /** Lines moved by PageUp/PageDown (UI sets this from the viewport). */
  pageLines: number;
}

export const defaultCommandOptions: CommandOptions = { indentUnit: "  ", lineComment: "//", autoClose: true, pageLines: 20 };

export interface CommandContext {
  buffer: TextBuffer;
  selection: SelectionSet;
  options: CommandOptions;
}

export type Command = (ctx: CommandContext) => Transaction | null;

/** Apply a transaction's edits (descending so offsets stay valid). Returns the changes in application order. */
export function applyTransaction(buffer: TextBuffer, tr: Transaction): BufferChange[] {
  const out: BufferChange[] = [];
  for (let i = tr.edits.length - 1; i >= 0; i--) {
    const e = tr.edits[i];
    out.push(buffer.replace(e.from, e.to, e.text));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Planned { edits: Edit[]; resolve: (m: ChangeMap) => Range }

function mergeEdits(edits: Edit[]): Edit[] {
  if (edits.length < 2) return edits;
  const sorted = edits.slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Edit[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const e = sorted[i], last = out[out.length - 1];
    if (e.from < last.to) { last.to = Math.max(last.to, e.to); last.text += e.text; }
    else out.push({ ...e });
  }
  return out;
}

function build(ctx: CommandContext, plans: Planned[], kind: TxKind): Transaction | null {
  const all: Edit[] = [];
  for (const p of plans) for (const e of p.edits) all.push(e);
  const edits = mergeEdits(all);
  const m = new ChangeMap(edits);
  const ranges = plans.map(p => p.resolve(m));
  const selection = normalize({ ranges, primary: ctx.selection.primary });
  return { edits, selection, kind };
}

function leadingWs(s: string): number { let i = 0; while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++; return i; }
function lineText(ctx: CommandContext, line: number): string { return ctx.buffer.line(line); }

function plan(ctx: CommandContext, fn: (r: Range, from: number, to: number) => Planned): Planned[] {
  return ctx.selection.ranges.map(r => fn(r, rangeFrom(r), rangeTo(r)));
}

interface Block { first: number; last: number }
/** Lines touched by the ranges (a non-empty range ending at column 0 of a later line excludes that line), merged. */
function lineBlocks(ctx: CommandContext): Block[] {
  const b = ctx.buffer;
  const blocks: Block[] = [];
  for (const r of ctx.selection.ranges) {
    const from = rangeFrom(r), to = rangeTo(r);
    const first = b.lineAt(from);
    let last = b.lineAt(to);
    if (to > from && last > first && to === b.lineStart(last)) last--;
    if (blocks.length && first <= blocks[blocks.length - 1].last + 1) {
      const prev = blocks[blocks.length - 1];
      if (last > prev.last) prev.last = last;
    } else blocks.push({ first, last });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Insertion
// ---------------------------------------------------------------------------

/** Replace each range with `text`. If `text` has exactly as many lines as there are ranges (> 1), one line goes to each. */
export function insertText(ctx: CommandContext, text: string, kind: TxKind = "input"): Transaction | null {
  const n = ctx.selection.ranges.length;
  let parts: string[] | null = null;
  if (n > 1 && text.indexOf("\n") >= 0) { const p = text.split("\n"); if (p.length === n) parts = p; }
  let i = 0;
  const plans = plan(ctx, (r, from, to) => {
    const t = parts ? parts[i++] : text;
    return { edits: [{ from, to, text: t }], resolve: m => { const p = m.map(to, 1); return { anchor: p, head: p }; } };
  });
  if (!parts && text === "" && ctx.selection.ranges.every(isEmptyRange)) return null;
  return build(ctx, plans, kind);
}

const OPEN = "([{";
const CLOSE: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const QUOTES = "\"'`";
function isWordCh(c: string): boolean { return c !== "" && wordClass(c.charCodeAt(0)) === 1; }

/** Typed character with auto-close / wrap / overtype. */
export function typeChar(ctx: CommandContext, ch: string): Transaction | null {
  const b = ctx.buffer;
  const auto = ctx.options.autoClose && ch.length === 1;
  const isOpen = auto && OPEN.indexOf(ch) >= 0, isQuote = auto && QUOTES.indexOf(ch) >= 0;
  const isClose = auto && (ch === ")" || ch === "]" || ch === "}");
  const plans = plan(ctx, (r, from, to) => {
    const line = b.lineAt(from), ls = b.lineStart(line), text = b.line(line), col = from - ls;
    const next = from === to && col < text.length ? text[col] : "";
    const prev = col > 0 ? text[col - 1] : "";
    if (from !== to && (isOpen || isQuote)) {
      const close = isOpen ? CLOSE[ch] : ch;
      const fwd = r.anchor <= r.head;
      return {
        edits: [{ from, to: from, text: ch }, { from: to, to, text: close }],
        resolve: m => { const a = m.map(from, 1), h = m.map(to, -1); return fwd ? { anchor: a, head: h } : { anchor: h, head: a }; },
      };
    }
    if (from === to) {
      if ((isClose || isQuote) && next === ch) return { edits: [], resolve: m => { const p = m.map(from + 1, -1); return { anchor: p, head: p }; } };
      let pair = false;
      if (isOpen) pair = next === "" || /[\s)\]};,.:>]/.test(next);
      else if (isQuote) pair = !isWordCh(prev) && prev !== ch && prev !== "\\" && !isWordCh(next) && next !== ch;
      if (pair) {
        const close = isOpen ? CLOSE[ch] : ch;
        return { edits: [{ from, to, text: ch + close }], resolve: m => { const p = m.map(from, -1) + 1; return { anchor: p, head: p }; } };
      }
    }
    return { edits: [{ from, to, text: ch }], resolve: m => { const p = m.map(to, 1); return { anchor: p, head: p }; } };
  });
  return build(ctx, plans, "type");
}

/** Enter with auto-indent. */
export function newline(ctx: CommandContext): Transaction | null {
  const b = ctx.buffer, unit = ctx.options.indentUnit;
  const plans = plan(ctx, (r, from, to) => {
    const line = b.lineAt(from), ls = b.lineStart(line), text = b.line(line), col = from - ls;
    const before = text.slice(0, col);
    const indent = text.slice(0, Math.min(leadingWs(text), col));
    const trimmed = before.replace(/\s+$/, "");
    const last = trimmed[trimmed.length - 1] ?? "";
    const opener = (last !== "" && OPEN.indexOf(last) >= 0) || trimmed.endsWith("=>");
    const after = b.getRange(to, to + 1);
    if (opener && last !== "" && CLOSE[last] === after && !trimmed.endsWith("=>")) {
      return {
        edits: [{ from, to, text: "\n" + indent + unit + "\n" + indent }],
        resolve: m => { const p = m.map(from, -1) + 1 + indent.length + unit.length; return { anchor: p, head: p }; },
      };
    }
    const ins = "\n" + indent + (opener ? unit : "");
    return { edits: [{ from, to, text: ins }], resolve: m => { const p = m.map(to, 1); return { anchor: p, head: p }; } };
  });
  return build(ctx, plans, "other");
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

const PAIRS = ["()", "[]", "{}", "\"\"", "''", "``"];

export type DeleteUnit = "char" | "word" | "line";

export function deleteBackward(ctx: CommandContext, unit: DeleteUnit = "char"): Transaction | null {
  const b = ctx.buffer, indentUnit = ctx.options.indentUnit;
  const plans = plan(ctx, (r, from, to) => {
    let start = from;
    if (from === to) {
      const line = b.lineAt(from), ls = b.lineStart(line), text = b.line(line), col = from - ls;
      if (col === 0) start = Math.max(0, from - 1);
      else if (unit === "word") start = ls + wordLeft(text, col);
      else if (unit === "line") start = ls;
      else {
        const before = text.slice(0, col);
        if (indentUnit.charCodeAt(0) === 32 && before.trim() === "" && before.indexOf("\t") < 0) {
          const w = indentUnit.length;
          start = from - (col % w || w);
        } else {
          start = ls + prevBoundary(text, col);
          if (ctx.options.autoClose && col < text.length && PAIRS.indexOf(text[col - 1] + text[col]) >= 0 && start === from - 1) {
            return { edits: [{ from: start, to: to + 1, text: "" }], resolve: m => { const p = m.map(start, -1); return { anchor: p, head: p }; } };
          }
        }
      }
    }
    return { edits: start === to ? [] : [{ from: start, to, text: "" }], resolve: m => { const p = m.map(start, -1); return { anchor: p, head: p }; } };
  });
  const tr = build(ctx, plans, "delete.back");
  return tr && tr.edits.length ? tr : null;
}

export function deleteForward(ctx: CommandContext, unit: DeleteUnit = "char"): Transaction | null {
  const b = ctx.buffer;
  const plans = plan(ctx, (r, from, to) => {
    let end = to;
    if (from === to) {
      const line = b.lineAt(from), ls = b.lineStart(line), text = b.line(line), col = from - ls;
      if (col === text.length) end = Math.min(b.length, from + 1);
      else if (unit === "word") end = ls + wordRight(text, col);
      else if (unit === "line") end = ls + text.length;
      else end = ls + nextBoundary(text, col);
    }
    return { edits: end === from ? [] : [{ from, to: end, text: "" }], resolve: m => { const p = m.map(from, -1); return { anchor: p, head: p }; } };
  });
  const tr = build(ctx, plans, "delete.fwd");
  return tr && tr.edits.length ? tr : null;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function moved(ctx: CommandContext, fn: (r: Range) => { head: number; goal?: number }, extend: boolean): Transaction {
  const ranges = ctx.selection.ranges.map(r => {
    const { head, goal } = fn(r);
    const out: Range = extend ? { anchor: r.anchor, head } : { anchor: head, head };
    if (goal !== undefined) out.goal = goal;
    return out;
  });
  return { edits: [], selection: normalize({ ranges, primary: ctx.selection.primary }), kind: "move" };
}

export function moveHorizontal(ctx: CommandContext, dir: -1 | 1, unit: "char" | "word", extend: boolean): Transaction {
  const b = ctx.buffer;
  return moved(ctx, r => {
    if (!extend && unit === "char" && !isEmptyRange(r)) return { head: dir < 0 ? rangeFrom(r) : rangeTo(r) };
    const p = r.head, line = b.lineAt(p), ls = b.lineStart(line), text = b.line(line), col = p - ls;
    if (dir < 0) {
      if (col === 0) return { head: Math.max(0, p - 1) };
      return { head: ls + (unit === "char" ? prevBoundary(text, col) : wordLeft(text, col)) };
    }
    if (col === text.length) return { head: Math.min(b.length, p + 1) };
    return { head: ls + (unit === "char" ? nextBoundary(text, col) : wordRight(text, col)) };
  }, extend);
}

export function moveVertical(ctx: CommandContext, dir: -1 | 1, lines: number, extend: boolean): Transaction {
  const b = ctx.buffer;
  return moved(ctx, r => {
    const p = r.head, line = b.lineAt(p), col = p - b.lineStart(line);
    const goal = r.goal ?? col;
    const target = line + dir * lines;
    if (target < 0) return { head: 0, goal };
    if (target >= b.lineCount) return { head: b.length, goal };
    const text = b.line(target);
    return { head: b.lineStart(target) + snapBoundary(text, Math.min(goal, text.length)), goal };
  }, extend);
}

/** Home/End. `smart` Home toggles between the first non-blank column and column 0. */
export function moveLineBoundary(ctx: CommandContext, which: "start" | "end", extend: boolean, smart = true): Transaction {
  const b = ctx.buffer;
  return moved(ctx, r => {
    const line = b.lineAt(r.head), ls = b.lineStart(line), text = b.line(line), col = r.head - ls;
    if (which === "end") return { head: ls + text.length };
    const ind = leadingWs(text);
    return { head: ls + (smart && col !== ind ? ind : 0) };
  }, extend);
}

export function moveDocument(ctx: CommandContext, which: "start" | "end", extend: boolean): Transaction {
  return moved(ctx, () => ({ head: which === "start" ? 0 : ctx.buffer.length }), extend);
}

export function selectAll(ctx: CommandContext): Transaction {
  return { edits: [], kind: "move", selection: { ranges: [{ anchor: 0, head: ctx.buffer.length }], primary: 0 } };
}

export function addCursorVertical(ctx: CommandContext, dir: -1 | 1): Transaction | null {
  const b = ctx.buffer;
  const ranges = ctx.selection.ranges.slice();
  const lines = ranges.map(r => b.lineAt(r.head));
  const extra: Range[] = [];
  const target = dir < 0 ? Math.min(...lines) + dir : Math.max(...lines) + dir;
  if (target < 0 || target >= b.lineCount) return null;
  for (const r of ctx.selection.ranges) {
    const line = b.lineAt(r.head);
    if (line + dir !== target && !(dir < 0 ? line === Math.min(...lines) : line === Math.max(...lines))) continue;
    const col = r.goal ?? r.head - b.lineStart(line);
    const text = b.line(target);
    const pos = b.lineStart(target) + snapBoundary(text, Math.min(col, text.length));
    extra.push({ anchor: pos, head: pos, goal: col });
  }
  const sel = normalize({ ranges: ranges.concat(extra), primary: ctx.selection.primary });
  return { edits: [], selection: sel, kind: "move" };
}

export function escapeSelection(ctx: CommandContext): Transaction | null {
  if (ctx.selection.ranges.length === 1) return null;
  return { edits: [], selection: simplify(ctx.selection), kind: "move" };
}

// ---------------------------------------------------------------------------
// Indent / outdent
// ---------------------------------------------------------------------------

/** Tab: insert to the next tab stop at bare cursors, indent whole lines for selections (`lines` forces line indent). */
export function indentSelection(ctx: CommandContext, lines = false): Transaction | null {
  const b = ctx.buffer, unit = ctx.options.indentUnit;
  if (!lines && ctx.selection.ranges.every(isEmptyRange)) {
    const plans = plan(ctx, (r, from, to) => {
      const col = from - b.lineStart(b.lineAt(from));
      const ins = unit.charCodeAt(0) === 32 && unit.trim() === "" ? " ".repeat(unit.length - (col % unit.length)) : unit;
      return { edits: [{ from, to, text: ins }], resolve: m => { const p = m.map(to, 1); return { anchor: p, head: p }; } };
    });
    return build(ctx, plans, "other");
  }
  const edits: Edit[] = [];
  for (const blk of lineBlocks(ctx)) {
    for (let l = blk.first; l <= blk.last; l++) {
      if (b.lineLength(l) === 0 && blk.first !== blk.last) continue;
      const s = b.lineStart(l);
      edits.push({ from: s, to: s, text: unit });
    }
  }
  const m = new ChangeMap(edits);
  const ranges = ctx.selection.ranges.map(r => {
    const f = m.map(rangeFrom(r), -1), t = m.map(rangeTo(r), 1);
    return r.anchor <= r.head ? { anchor: f, head: t } : { anchor: t, head: f };
  });
  return { edits, selection: normalize({ ranges, primary: ctx.selection.primary }), kind: "other" };
}

export function outdentSelection(ctx: CommandContext): Transaction | null {
  const b = ctx.buffer, unit = ctx.options.indentUnit;
  const edits: Edit[] = [];
  for (const blk of lineBlocks(ctx)) {
    for (let l = blk.first; l <= blk.last; l++) {
      const t = b.line(l);
      let k = 0;
      if (t.charCodeAt(0) === 9) k = 1;
      else { while (k < unit.length && t.charCodeAt(k) === 32) k++; }
      if (k > 0) { const s = b.lineStart(l); edits.push({ from: s, to: s + k, text: "" }); }
    }
  }
  if (!edits.length) return null;
  const m = new ChangeMap(edits);
  const ranges = ctx.selection.ranges.map(r => ({ anchor: m.map(r.anchor, -1), head: m.map(r.head, -1) }));
  return { edits, selection: normalize({ ranges, primary: ctx.selection.primary }), kind: "other" };
}

// ---------------------------------------------------------------------------
// Line operations
// ---------------------------------------------------------------------------

export function duplicateLine(ctx: CommandContext, dir: "down" | "up" = "down"): Transaction | null {
  const b = ctx.buffer;
  const edits: Edit[] = [];
  const blocks = lineBlocks(ctx);
  for (const blk of blocks) {
    const text = b.getRange(b.lineStart(blk.first), b.lineEnd(blk.last));
    const at = b.lineEnd(blk.last);
    edits.push({ from: at, to: at, text: "\n" + text });
  }
  const m = new ChangeMap(edits);
  const ranges = ctx.selection.ranges.map(r => {
    if (dir === "up") return { anchor: m.map(r.anchor, -1), head: m.map(r.head, -1) };
    // shift into the copy: add the copied block length for every block at/above
    const shiftOf = (p: number) => {
      let s = 0;
      const line = b.lineAt(p);
      for (let i = 0; i < blocks.length; i++) {
        const blk = blocks[i], len = edits[i].text.length;
        if (line >= blk.first && line <= blk.last) { s += len; break; }
        if (line > blk.last) s += len;
      }
      return p + s;
    };
    return { anchor: shiftOf(r.anchor), head: shiftOf(r.head) };
  });
  const sel = dir === "up"
    ? { ranges: ctx.selection.ranges.map(r => ({ anchor: m.map(r.anchor, -1), head: m.map(r.head, -1) })), primary: ctx.selection.primary }
    : { ranges, primary: ctx.selection.primary };
  return { edits, selection: normalize(sel), kind: "other" };
}

export function moveLines(ctx: CommandContext, dir: "up" | "down"): Transaction | null {
  const b = ctx.buffer;
  const edits: Edit[] = [];
  const shifts: { first: number; last: number; delta: number }[] = [];
  for (const blk of lineBlocks(ctx)) {
    const nb = dir === "up" ? blk.first - 1 : blk.last + 1;
    if (nb < 0 || nb >= b.lineCount) continue;
    const blockText = b.getRange(b.lineStart(blk.first), b.lineEnd(blk.last));
    const nbText = b.line(nb);
    if (dir === "up") {
      edits.push({ from: b.lineStart(nb), to: b.lineEnd(blk.last), text: blockText + "\n" + nbText });
      shifts.push({ first: blk.first, last: blk.last, delta: -(nbText.length + 1) });
    } else {
      edits.push({ from: b.lineStart(blk.first), to: b.lineEnd(nb), text: nbText + "\n" + blockText });
      shifts.push({ first: blk.first, last: blk.last, delta: nbText.length + 1 });
    }
  }
  if (!edits.length) return null;
  const mv = (p: number) => {
    const line = b.lineAt(p);
    for (const s of shifts) if (line >= s.first && line <= s.last) return p + s.delta;
    return p;
  };
  const ranges = ctx.selection.ranges.map(r => ({ anchor: mv(r.anchor), head: mv(r.head) }));
  return { edits, selection: normalize({ ranges, primary: ctx.selection.primary }), kind: "other" };
}

export function toggleLineComment(ctx: CommandContext): Transaction | null {
  const marker = ctx.options.lineComment;
  if (!marker) return null;
  const b = ctx.buffer;
  const lines: number[] = [];
  for (const blk of lineBlocks(ctx)) for (let l = blk.first; l <= blk.last; l++) lines.push(l);
  const nonBlank = lines.filter(l => b.line(l).trim() !== "");
  const target = nonBlank.length ? nonBlank : lines;
  const allCommented = nonBlank.length > 0 && nonBlank.every(l => { const t = b.line(l); return t.startsWith(marker, leadingWs(t)); });
  const edits: Edit[] = [];
  if (allCommented) {
    for (const l of target) {
      const t = b.line(l), i = leadingWs(t), s = b.lineStart(l);
      const k = marker.length + (t.charCodeAt(i + marker.length) === 32 ? 1 : 0);
      edits.push({ from: s + i, to: s + i + k, text: "" });
    }
  } else {
    let min = Infinity;
    for (const l of target) min = Math.min(min, leadingWs(b.line(l)));
    if (!isFinite(min) || nonBlank.length === 0) min = 0;
    for (const l of target) { const s = b.lineStart(l); edits.push({ from: s + min, to: s + min, text: marker + " " }); }
  }
  if (!edits.length) return null;
  const m = new ChangeMap(edits);
  const ranges = ctx.selection.ranges.map(r => ({ anchor: m.map(r.anchor, 1), head: m.map(r.head, 1) }));
  return { edits, selection: normalize({ ranges, primary: ctx.selection.primary }), kind: "other" };
}

// ---------------------------------------------------------------------------
// Clipboard helpers (the host plugin does the actual clipboard IO)
// ---------------------------------------------------------------------------

/** Text for copy/cut: selected ranges joined with "\n"; with only cursors, the current line(s) including the break. */
export function copyText(ctx: CommandContext): { text: string; wholeLines: boolean } {
  const b = ctx.buffer;
  if (ctx.selection.ranges.every(isEmptyRange)) {
    const seen: number[] = [];
    for (const r of ctx.selection.ranges) { const l = b.lineAt(r.head); if (seen.indexOf(l) < 0) seen.push(l); }
    return { text: seen.map(l => b.line(l) + "\n").join(""), wholeLines: true };
  }
  return { text: ctx.selection.ranges.filter(r => !isEmptyRange(r)).map(r => b.getRange(rangeFrom(r), rangeTo(r))).join("\n"), wholeLines: false };
}

export function cutTransaction(ctx: CommandContext): Transaction | null {
  const b = ctx.buffer;
  if (ctx.selection.ranges.every(isEmptyRange)) {
    const edits: Edit[] = [];
    for (const blk of lineBlocks(ctx)) {
      let from: number, to: number;
      if (blk.last < b.lineCount - 1) { from = b.lineStart(blk.first); to = b.lineStart(blk.last + 1); }
      else { from = blk.first > 0 ? b.lineStart(blk.first) - 1 : 0; to = b.lineEnd(blk.last); }
      edits.push({ from, to, text: "" });
    }
    const m = new ChangeMap(edits);
    const ranges = ctx.selection.ranges.map(r => { const p = m.map(r.head, -1); return { anchor: p, head: p }; });
    return { edits, selection: normalize({ ranges, primary: ctx.selection.primary }), kind: "other" };
  }
  return deleteBackward(ctx, "char");
}

// ---------------------------------------------------------------------------
// Command table (ids used by the keymap)
// ---------------------------------------------------------------------------

export const commandTable: Record<string, Command> = {
  cursorLeft: c => moveHorizontal(c, -1, "char", false), selectLeft: c => moveHorizontal(c, -1, "char", true),
  cursorRight: c => moveHorizontal(c, 1, "char", false), selectRight: c => moveHorizontal(c, 1, "char", true),
  cursorWordLeft: c => moveHorizontal(c, -1, "word", false), selectWordLeft: c => moveHorizontal(c, -1, "word", true),
  cursorWordRight: c => moveHorizontal(c, 1, "word", false), selectWordRight: c => moveHorizontal(c, 1, "word", true),
  cursorUp: c => moveVertical(c, -1, 1, false), selectUp: c => moveVertical(c, -1, 1, true),
  cursorDown: c => moveVertical(c, 1, 1, false), selectDown: c => moveVertical(c, 1, 1, true),
  cursorPageUp: c => moveVertical(c, -1, c.options.pageLines, false), selectPageUp: c => moveVertical(c, -1, c.options.pageLines, true),
  cursorPageDown: c => moveVertical(c, 1, c.options.pageLines, false), selectPageDown: c => moveVertical(c, 1, c.options.pageLines, true),
  cursorLineStart: c => moveLineBoundary(c, "start", false), selectLineStart: c => moveLineBoundary(c, "start", true),
  cursorLineEnd: c => moveLineBoundary(c, "end", false), selectLineEnd: c => moveLineBoundary(c, "end", true),
  cursorDocStart: c => moveDocument(c, "start", false), selectDocStart: c => moveDocument(c, "start", true),
  cursorDocEnd: c => moveDocument(c, "end", false), selectDocEnd: c => moveDocument(c, "end", true),
  selectAll,
  newline,
  deleteBackward: c => deleteBackward(c, "char"), deleteWordBackward: c => deleteBackward(c, "word"), deleteLineBackward: c => deleteBackward(c, "line"),
  deleteForward: c => deleteForward(c, "char"), deleteWordForward: c => deleteForward(c, "word"),
  indent: c => indentSelection(c), indentLines: c => indentSelection(c, true), outdent: outdentSelection,
  duplicateLineDown: c => duplicateLine(c, "down"), duplicateLineUp: c => duplicateLine(c, "up"),
  moveLineUp: c => moveLines(c, "up"), moveLineDown: c => moveLines(c, "down"),
  toggleLineComment,
  addCursorAbove: c => addCursorVertical(c, -1), addCursorBelow: c => addCursorVertical(c, 1),
  escape: escapeSelection,
};
