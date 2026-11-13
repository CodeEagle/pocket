/**
 * Undo/redo with typing coalescing and bounded memory.
 *
 * Coalescing rule: a new step is merged into the previous one when ALL hold:
 *  - both are kind "type" (or both "delete.back" / both "delete.fwd"),
 *  - the gap since the previous edit is <= `coalesceMs` (default 1000),
 *  - the selection before the new edit equals the selection after the previous
 *    one (contiguous caret, no cursor move in between),
 *  - no explicit `breakCoalescing()` happened (the editor calls it on cursor
 *    moves, save, focus loss),
 *  - the typed text is a single code point group without a line break and not
 *    a word -> whitespace transition (so "hello world" undoes as "hello" +
 *    " world"), and the replaced selection was empty.
 * Other kinds ("input" such as paste, "ime", "other") are always their own step.
 */
import type { BufferChange, TextBuffer } from "./buffer.ts";
import type { SelectionSet } from "./selection.ts";
import type { TxKind } from "./commands.ts";
import { wordClass } from "./buffer.ts";

export interface HistoryChange { offset: number; removed: string; inserted: string }
export interface HistoryStep {
  changes: HistoryChange[];
  before: SelectionSet;
  after: SelectionSet;
  kind: TxKind;
  time: number;
  bytes: number;
  /** last inserted char class (for word/space coalescing boundary) */
  lastClass: number;
}

export interface HistoryOptions {
  maxSteps?: number;
  /** Approximate cap on retained text (UTF-16 units * 2 bytes). */
  maxBytes?: number;
  coalesceMs?: number;
}

function stepBytes(changes: HistoryChange[]): number {
  let n = 64;
  for (const c of changes) n += (c.removed.length + c.inserted.length) * 2 + 32;
  return n;
}

export class History {
  private undoStack: HistoryStep[] = [];
  private redoStack: HistoryStep[] = [];
  private bytes = 0;
  private broken = true;
  readonly maxSteps: number;
  readonly maxBytes: number;
  readonly coalesceMs: number;

  constructor(opts: HistoryOptions = {}) {
    this.maxSteps = opts.maxSteps ?? 500;
    this.maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    this.coalesceMs = opts.coalesceMs ?? 1000;
  }

  get undoDepth(): number { return this.undoStack.length; }
  get redoDepth(): number { return this.redoStack.length; }
  get retainedBytes(): number { return this.bytes; }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  /** Force the next recorded edit into a new step. */
  breakCoalescing(): void { this.broken = true; }

  clear(): void { this.undoStack = []; this.redoStack = []; this.bytes = 0; this.broken = true; }

  /** Record an applied transaction. `changes` come in application order (as returned by applyTransaction). */
  record(changes: BufferChange[], before: SelectionSet, after: SelectionSet, kind: TxKind, time: number): void {
    if (!changes.length) return;
    const hc: HistoryChange[] = changes.map(c => ({ offset: c.offset, removed: c.removed, inserted: c.inserted }));
    this.redoStack = [];
    const last = this.undoStack.length ? this.undoStack[this.undoStack.length - 1] : null;
    const ins = hc.length === 1 ? hc[0] : null;
    const lastCls = ins && ins.inserted.length ? wordClass(ins.inserted.codePointAt(ins.inserted.length - 1) as number) : -1;
    if (last && !this.broken && last.kind === kind && (kind === "type" || kind === "delete.back" || kind === "delete.fwd") &&
        time - last.time <= this.coalesceMs && selEq(last.after, before) && hc.length === 1 && last.changes.length === 1 &&
        this.mergeable(last, hc[0], kind)) {
      const prev = last.changes[0], cur = hc[0];
      this.bytes -= last.bytes;
      if (kind === "type") { const rel = cur.offset - prev.offset; prev.inserted = prev.inserted.slice(0, rel) + cur.inserted + prev.inserted.slice(rel); }
      else if (kind === "delete.back") { prev.offset = cur.offset; prev.removed = cur.removed + prev.removed; }
      else prev.removed += cur.removed;
      last.after = after; last.time = time; last.lastClass = lastCls;
      last.bytes = stepBytes(last.changes);
      this.bytes += last.bytes;
      this.trim();
      return;
    }
    const step: HistoryStep = { changes: hc, before, after, kind, time, bytes: stepBytes(hc), lastClass: lastCls };
    this.undoStack.push(step);
    this.bytes += step.bytes;
    this.broken = false;
    this.trim();
  }

  private mergeable(last: HistoryStep, cur: HistoryChange, kind: TxKind): boolean {
    const prev = last.changes[0];
    if (kind === "type") {
      if (cur.removed.length || !cur.inserted.length || cur.inserted.indexOf("\n") >= 0) return false;
      const rel = cur.offset - prev.offset; // may land inside an auto-closed pair
      if (rel < 0 || rel > prev.inserted.length) return false;
      const cls = wordClass(cur.inserted.codePointAt(0) as number);
      if (last.lastClass === 1 && cls === 0) return false; // word -> space starts a new step
      return true;
    }
    if (kind === "delete.back") return cur.inserted === "" && cur.offset + cur.removed.length === prev.offset && cur.removed.indexOf("\n") < 0 && prev.inserted === "";
    return cur.inserted === "" && cur.offset === prev.offset && cur.removed.indexOf("\n") < 0 && prev.inserted === "";
  }

  private trim(): void {
    while (this.undoStack.length > 1 && (this.undoStack.length > this.maxSteps || this.bytes > this.maxBytes)) {
      const s = this.undoStack.shift() as HistoryStep;
      this.bytes -= s.bytes;
    }
  }

  /** Undo one step on `buffer`; returns the restored selection or null. */
  undo(buffer: TextBuffer): SelectionSet | null {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.bytes -= step.bytes;
    for (let i = step.changes.length - 1; i >= 0; i--) {
      const c = step.changes[i];
      buffer.replace(c.offset, c.offset + c.inserted.length, c.removed);
    }
    this.redoStack.push(step);
    this.broken = true;
    return step.before;
  }

  redo(buffer: TextBuffer): SelectionSet | null {
    const step = this.redoStack.pop();
    if (!step) return null;
    for (const c of step.changes) buffer.replace(c.offset, c.offset + c.removed.length, c.inserted);
    this.undoStack.push(step);
    this.bytes += step.bytes;
    this.broken = true;
    return step.after;
  }
}

function selEq(a: SelectionSet, b: SelectionSet): boolean {
  if (a.ranges.length !== b.ranges.length || a.primary !== b.primary) return false;
  for (let i = 0; i < a.ranges.length; i++) if (a.ranges[i].anchor !== b.ranges[i].anchor || a.ranges[i].head !== b.ranges[i].head) return false;
  return true;
}
