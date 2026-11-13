/**
 * Find/replace state over a CodeEditor, built on search.ts. Pure (no UI).
 * The UI (view.tsx) renders `matches` as highlights and the bar controls.
 */
import type { CodeEditor } from "./editor.ts";
import { findAll, findNext, findPrev, replaceAllTransaction, replaceOneTransaction, type Match, type SearchOptions } from "./search.ts";
import { single } from "./selection.ts";

export class FindModel {
  query = "";
  replacement = "";
  options: SearchOptions = { caseSensitive: false };
  matches: Match[] = [];
  capped = false;
  error: string | undefined;
  /** Index of the match equal to the primary selection, -1 when none. */
  current = -1;

  constructor(private editor: CodeEditor) {}

  /** Recompute matches (call after query/option/document changes). */
  refresh(): void {
    if (this.query === "") { this.matches = []; this.capped = false; this.error = undefined; this.current = -1; return; }
    const r = findAll(this.editor.buffer.getText(), this.query, this.options);
    this.matches = r.matches; this.capped = r.truncated || r.timedOut; this.error = r.error;
    this.syncCurrent();
  }

  syncCurrent(): void {
    const r = this.editor.selection.ranges[this.editor.selection.primary];
    const from = Math.min(r.anchor, r.head), to = Math.max(r.anchor, r.head);
    let lo = 0, hi = this.matches.length - 1, idx = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; const x = this.matches[m]; if (x.from === from && x.to === to) { idx = m; break; } if (x.from < from) lo = m + 1; else hi = m - 1; }
    this.current = idx;
  }

  private select(m: Match | null): boolean {
    if (!m) return false;
    this.editor.setSelection(single(m.from, m.to));
    this.syncCurrent();
    return true;
  }

  /** Select the next match after the selection (wraps). */
  next(): boolean {
    if (!this.query) return false;
    const r = this.editor.selection.ranges[this.editor.selection.primary];
    return this.select(findNext(this.editor.buffer.getText(), this.query, this.options, Math.max(r.anchor, r.head), true));
  }

  prev(): boolean {
    if (!this.query) return false;
    const r = this.editor.selection.ranges[this.editor.selection.primary];
    return this.select(findPrev(this.editor.buffer.getText(), this.query, this.options, Math.min(r.anchor, r.head), true));
  }

  /** Replace the current match (or select the next one). Returns true when the document changed. */
  replaceOne(): boolean {
    if (!this.query) return false;
    const tr = replaceOneTransaction(this.editor.buffer, this.editor.selection, this.query, this.options, this.replacement);
    const changed = this.editor.dispatch(tr) && !!tr && tr.edits.length > 0;
    this.refresh();
    return changed;
  }

  /** Replace every match as one undo step. Returns the number replaced. */
  replaceAll(): number {
    if (!this.query) return 0;
    const r = replaceAllTransaction(this.editor.buffer, this.query, this.options, this.replacement);
    if (!r.transaction) return 0;
    this.editor.dispatch(r.transaction);
    this.refresh();
    return r.count;
  }

  /** "3/12", "12" or "No results". */
  label(): string {
    if (this.error) return "!";
    if (!this.query) return "";
    const n = this.matches.length;
    if (n === 0) return "No results";
    const c = (this.capped ? "+" : "");
    return this.current >= 0 ? `${this.current + 1}/${n}${c}` : `${n}${c}`;
  }
}
