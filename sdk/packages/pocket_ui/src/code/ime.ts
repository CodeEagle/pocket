/**
 * IME reducer for the raw text events of STUDIO_TEXT_INPUT.md
 * (`composition`, `compositionEnd`, `commit`).
 *
 * Model: composition is a TRANSIENT overlay on the buffer and never touches
 * history.
 *  - `composition{text,selectionStart,selectionEnd}`: on the first event the
 *    primary selection range is recorded (text + full selection set) and
 *    replaced by the marked text; later events replace the marked range. The
 *    selection becomes the caret/clause selection inside the marked text
 *    (UTF-16 offsets relative to it, clamped and snapped off surrogate halves).
 *    Only the primary range takes part (extra cursors are kept in the saved
 *    selection and come back on end/commit).
 *  - `compositionEnd`: the marked text is removed and the pre-composition text
 *    AND selection are restored exactly. A cancelled composition stops here.
 *    A confirmed one is followed by `commit`, which therefore replaces the
 *    original selection: one clean undo step, no flicker as long as the UI
 *    renders after the whole frame batch of events.
 *  - `commit` while still composing behaves as end + commit.
 *  - `commit` right after `compositionEnd` is returned as a Transaction of kind
 *    "ime" (plain insert, no auto-close). Any other `commit` is ordinary typing:
 *    the reducer returns it as `plainText` for the caller to route through
 *    `typeChar` / `insertText`.
 */
import { TextBuffer } from "./buffer.ts";
import { SelectionSet, single, primaryRange, rangeFrom, rangeTo } from "./selection.ts";
import { CommandContext, Transaction, insertText } from "./commands.ts";

export type ImeEvent =
  | { kind: "composition"; text: string; selectionStart?: number; selectionEnd?: number }
  | { kind: "compositionEnd" }
  | { kind: "commit"; text: string };

export interface ImeOrigin { from: number; to: number; removed: string; selection: SelectionSet }
export interface ImeState {
  /** Marked (provisional) range in the buffer, or null. The UI underlines it. */
  marked: { from: number; to: number } | null;
  origin: ImeOrigin | null;
  /** True between compositionEnd and the next event (a following commit is IME text). */
  afterEnd: boolean;
}

export const initialImeState: ImeState = { marked: null, origin: null, afterEnd: false };

export interface ImeResult {
  state: ImeState;
  selection: SelectionSet;
  /** Set for an IME-originated commit; apply with history kind "ime". */
  commit: Transaction | null;
  /** Set for a non-IME commit: ordinary typed text for the caller. */
  plainText: string | null;
  /** The buffer text changed during this step (composition update / restore). */
  bufferChanged: boolean;
}

function snapIn(text: string, i: number | undefined, fallback: number): number {
  let v = i === undefined || !isFinite(i) ? fallback : Math.min(Math.max(Math.floor(i), 0), text.length);
  if (v > 0 && v < text.length) {
    const c = text.charCodeAt(v);
    if (c >= 0xdc00 && c <= 0xdfff) { const h = text.charCodeAt(v - 1); if (h >= 0xd800 && h <= 0xdbff) v--; }
  }
  return v;
}

function restore(state: ImeState, buffer: TextBuffer): { selection: SelectionSet; changed: boolean } | null {
  if (!state.origin || !state.marked) return null;
  buffer.replace(state.marked.from, state.marked.to, state.origin.removed);
  return { selection: state.origin.selection, changed: true };
}

/** Cancel any active composition (e.g. the pointer moved the caret). Returns the restored selection. */
export function cancelComposition(state: ImeState, buffer: TextBuffer, selection: SelectionSet): { state: ImeState; selection: SelectionSet } {
  const r = restore(state, buffer);
  if (!r) return { state, selection };
  return { state: initialImeState, selection: r.selection };
}

export function reduceIme(state: ImeState, ev: ImeEvent, buffer: TextBuffer, selection: SelectionSet, options: CommandContext["options"]): ImeResult {
  if (ev.kind === "composition") {
    let origin = state.origin;
    let from: number, to: number;
    if (!origin || !state.marked) {
      const r = primaryRange(selection);
      from = rangeFrom(r); to = rangeTo(r);
      origin = { from, to, removed: buffer.getRange(from, to), selection };
    } else { from = state.marked.from; to = state.marked.to; }
    const text = ev.text ?? "";
    buffer.replace(from, to, text);
    const s = snapIn(text, ev.selectionStart, text.length), e = snapIn(text, ev.selectionEnd, s);
    return {
      state: { marked: { from, to: from + text.length }, origin, afterEnd: false },
      selection: single(from + s, from + e), commit: null, plainText: null, bufferChanged: true,
    };
  }
  if (ev.kind === "compositionEnd") {
    const r = restore(state, buffer);
    if (!r) return { state: { ...state, afterEnd: false }, selection, commit: null, plainText: null, bufferChanged: false };
    return { state: { marked: null, origin: null, afterEnd: true }, selection: r.selection, commit: null, plainText: null, bufferChanged: true };
  }
  // commit
  const r = restore(state, buffer);
  const imeCommit = !!r || state.afterEnd;
  const sel = r ? r.selection : selection;
  const next: ImeState = initialImeState;
  if (!imeCommit) return { state: next, selection, commit: null, plainText: ev.text, bufferChanged: false };
  const tr = insertText({ buffer, selection: sel, options }, ev.text, "ime");
  return { state: next, selection: sel, commit: tr, plainText: null, bufferChanged: !!r };
}
