/**
 * Thin glue that owns buffer + selection + history + IME state and routes raw
 * input events (STUDIO_TEXT_INPUT.md) through keymap, commands and the IME
 * reducer. It holds no UI policy: clipboard / find / save come back as
 * intents for the host plugin or the UI layer.
 */
import { TextBuffer } from "./buffer.ts";
import { SelectionSet, single, clampSelection } from "./selection.ts";
import {
  CommandContext, CommandOptions, Transaction, applyTransaction, commandTable, copyText, cutTransaction,
  defaultCommandOptions, insertText, newline, typeChar,
} from "./commands.ts";
import { History, HistoryOptions } from "./history.ts";
import { ImeEvent, ImeState, initialImeState, reduceIme, cancelComposition } from "./ime.ts";
import { Platform, lookupKey } from "./keymap.ts";

export type EditorIntent =
  | { type: "clipboard.write"; text: string; cut: boolean }
  | { type: "clipboard.read" }
  | { type: "find" } | { type: "findNext" } | { type: "findPrev" } | { type: "save" };

/** Raw `onTextEvent` payload subset the editor understands. */
export type RawTextEvent =
  | { kind: "keyDown" | "keyUp"; key: string; repeat?: boolean }
  | ImeEvent;

export interface EditorOptions {
  platform?: Platform;
  command?: Partial<CommandOptions>;
  history?: HistoryOptions;
  /** Clock for coalescing (default Date.now). */
  now?: () => number;
}

export interface InputOutcome {
  /** The key/event was consumed (do not let the platform handle it). */
  handled: boolean;
  /** Buffer text or selection changed. */
  changed: boolean;
  intent?: EditorIntent;
}

export class CodeEditor {
  readonly buffer: TextBuffer;
  selection: SelectionSet = single(0);
  readonly history: History;
  ime: ImeState = initialImeState;
  readonly options: CommandOptions;
  platform: Platform;
  private now: () => number;

  constructor(text = "", opts: EditorOptions = {}) {
    this.buffer = new TextBuffer(text);
    this.options = { ...defaultCommandOptions, ...opts.command };
    this.history = new History(opts.history);
    this.platform = opts.platform ?? "mac";
    this.now = opts.now ?? Date.now;
  }

  /** Marked (IME provisional) range for underlining, or null. */
  get marked(): { from: number; to: number } | null { return this.ime.marked; }

  context(): CommandContext { return { buffer: this.buffer, selection: this.selection, options: this.options }; }

  /** Apply a transaction with history. Returns true if anything changed. */
  dispatch(tr: Transaction | null): boolean {
    if (!tr) return false;
    this.cancelIme();
    const before = this.selection;
    if (tr.edits.length === 0) {
      this.history.breakCoalescing();
      const sel = clampSelection(tr.selection, this.buffer.length);
      const same = sel.primary === before.primary && sel.ranges.length === before.ranges.length &&
        sel.ranges.every((r, i) => r.anchor === before.ranges[i].anchor && r.head === before.ranges[i].head);
      this.selection = sel;
      return !same;
    }
    const changes = applyTransaction(this.buffer, tr);
    this.selection = clampSelection(tr.selection, this.buffer.length);
    this.history.record(changes, before, this.selection, tr.kind, this.now());
    return true;
  }

  /** Replace the selection by pointer / external code (breaks coalescing, cancels composition). */
  setSelection(sel: SelectionSet): void {
    this.cancelIme();
    this.history.breakCoalescing();
    this.selection = clampSelection(sel, this.buffer.length);
  }

  private cancelIme(): void {
    if (!this.ime.marked) return;
    const r = cancelComposition(this.ime, this.buffer, this.selection);
    this.ime = r.state; this.selection = r.selection;
  }

  undo(): boolean {
    this.cancelIme();
    const sel = this.history.undo(this.buffer);
    if (!sel) return false;
    this.selection = clampSelection(sel, this.buffer.length);
    return true;
  }

  redo(): boolean {
    this.cancelIme();
    const sel = this.history.redo(this.buffer);
    if (!sel) return false;
    this.selection = clampSelection(sel, this.buffer.length);
    return true;
  }

  /** Insert pasted text (the host answered an `clipboard.read` intent). One undo step. */
  paste(text: string): boolean {
    if (text === "") return false;
    return this.dispatch(insertText(this.context(), text, "input"));
  }

  /** Handle a key name ("Meta+z", "Alt+ArrowLeft"). */
  handleKey(name: string): InputOutcome {
    if (this.ime.marked) return { handled: false, changed: false };
    const id = lookupKey(name, this.platform);
    if (!id) return { handled: false, changed: false };
    switch (id) {
      case "undo": return { handled: true, changed: this.undo() };
      case "redo": return { handled: true, changed: this.redo() };
      case "copy": return { handled: true, changed: false, intent: { type: "clipboard.write", text: copyText(this.context()).text, cut: false } };
      case "cut": {
        const text = copyText(this.context()).text;
        const changed = this.dispatch(cutTransaction(this.context()));
        return { handled: true, changed, intent: { type: "clipboard.write", text, cut: true } };
      }
      case "paste": return { handled: true, changed: false, intent: { type: "clipboard.read" } };
      case "find": case "findNext": case "findPrev": case "save":
        return { handled: true, changed: false, intent: { type: id } };
    }
    const cmd = commandTable[id];
    if (!cmd) return { handled: false, changed: false };
    const changed = this.dispatch(cmd(this.context()));
    return { handled: true, changed };
  }

  /** Handle any raw text event (keyDown / keyUp / composition / compositionEnd / commit). */
  handleInput(ev: RawTextEvent): InputOutcome {
    if (ev.kind === "keyDown") return this.handleKey(ev.key);
    if (ev.kind === "keyUp") return { handled: false, changed: false };
    const r = reduceIme(this.ime, ev as ImeEvent, this.buffer, this.selection, this.options);
    this.ime = r.state; this.selection = r.selection;
    let changed = r.bufferChanged;
    if (r.commit) {
      changed = this.dispatch(r.commit) || changed;
    } else if (r.plainText !== null) {
      const t = r.plainText;
      let tr: Transaction | null;
      if (t === "\n") tr = newline(this.context());
      else if (t.length <= 2 && t.indexOf("\n") < 0) tr = typeChar(this.context(), t);
      else tr = insertText(this.context(), t, "input");
      changed = this.dispatch(tr) || changed;
    }
    return { handled: true, changed };
  }
}
