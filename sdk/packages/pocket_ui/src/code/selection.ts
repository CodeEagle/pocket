/**
 * Multi-cursor selection model. Offsets are logical UTF-16 offsets in the
 * TextBuffer. A selection set holds >= 1 ranges and one primary index.
 */

export interface Range {
  /** Fixed end. */
  anchor: number;
  /** Moving end (the caret). */
  head: number;
  /** Remembered visual column for vertical movement (UTF-16 columns), if any. */
  goal?: number;
}

export interface SelectionSet {
  ranges: Range[];
  /** Index of the primary range in `ranges`. */
  primary: number;
}

export interface Edit { from: number; to: number; text: string }

export const rangeFrom = (r: Range): number => (r.anchor < r.head ? r.anchor : r.head);
export const rangeTo = (r: Range): number => (r.anchor < r.head ? r.head : r.anchor);
export const isEmptyRange = (r: Range): boolean => r.anchor === r.head;

export function cursor(pos: number, goal?: number): Range { return goal === undefined ? { anchor: pos, head: pos } : { anchor: pos, head: pos, goal }; }
export function range(anchor: number, head: number): Range { return { anchor, head }; }

/** A single-range selection set. */
export function single(anchor: number, head: number = anchor): SelectionSet {
  return { ranges: [{ anchor, head }], primary: 0 };
}

export function primaryRange(sel: SelectionSet): Range { return sel.ranges[sel.primary]; }

/** Sort ranges and merge overlapping ones (touching cursors at one position
 * merge too; touching non-empty ranges stay separate). Keeps the primary. */
export function normalize(sel: SelectionSet): SelectionSet {
  const n = sel.ranges.length;
  if (n === 1) return sel;
  let sorted = true;
  for (let i = 1; i < n; i++) if (rangeFrom(sel.ranges[i]) < rangeFrom(sel.ranges[i - 1])) { sorted = false; break; }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (!sorted) idx.sort((a, b) => rangeFrom(sel.ranges[a]) - rangeFrom(sel.ranges[b]) || rangeTo(sel.ranges[a]) - rangeTo(sel.ranges[b]));
  const out: Range[] = [];
  let primary = 0;
  for (const i of idx) {
    const r = sel.ranges[i];
    const last = out.length ? out[out.length - 1] : null;
    if (last && (rangeFrom(r) < rangeTo(last) || (rangeFrom(r) === rangeTo(last) && (isEmptyRange(r) || isEmptyRange(last))))) {
      const from = Math.min(rangeFrom(last), rangeFrom(r)), to = Math.max(rangeTo(last), rangeTo(r));
      const forward = last.anchor <= last.head;
      out[out.length - 1] = forward ? { anchor: from, head: to } : { anchor: to, head: from };
      if (i === sel.primary) primary = out.length - 1;
    } else {
      out.push(r);
      if (i === sel.primary) primary = out.length - 1;
    }
  }
  return { ranges: out, primary };
}

export function selectionsEqual(a: SelectionSet, b: SelectionSet): boolean {
  if (a.primary !== b.primary || a.ranges.length !== b.ranges.length) return false;
  for (let i = 0; i < a.ranges.length; i++) if (a.ranges[i].anchor !== b.ranges[i].anchor || a.ranges[i].head !== b.ranges[i].head) return false;
  return true;
}

/** Keep only the primary range (Escape). */
export function simplify(sel: SelectionSet): SelectionSet {
  return sel.ranges.length === 1 ? sel : { ranges: [sel.ranges[sel.primary]], primary: 0 };
}

/** Clamp every offset into [0, length]. */
export function clampSelection(sel: SelectionSet, length: number): SelectionSet {
  const c = (v: number) => (v < 0 ? 0 : v > length ? length : v);
  return { ranges: sel.ranges.map(r => (r.goal === undefined ? { anchor: c(r.anchor), head: c(r.head) } : { anchor: c(r.anchor), head: c(r.head), goal: r.goal })), primary: sel.primary };
}

/**
 * Position mapping through a sorted list of non-overlapping edits expressed in
 * original-document coordinates.
 */
export class ChangeMap {
  constructor(readonly edits: readonly Edit[]) {}
  /** Map an original offset to the new document. `assoc` < 0 keeps the
   * position before inserted text / at the start of a replaced region; >= 0
   * moves it after. */
  map(p: number, assoc = 1): number {
    let shift = 0;
    for (const e of this.edits) {
      if (p < e.from) break;
      if (p > e.to) { shift += e.text.length - (e.to - e.from); continue; }
      if (p === e.to && e.to > e.from) return e.from + shift + e.text.length;
      return e.from + shift + (assoc < 0 ? 0 : e.text.length);
    }
    return p + shift;
  }
}

/** Map a selection through edits (used for non-primary state after external edits). */
export function mapSelection(sel: SelectionSet, map: ChangeMap): SelectionSet {
  return normalize({ ranges: sel.ranges.map(r => ({ anchor: map.map(r.anchor), head: map.map(r.head) })), primary: sel.primary });
}
