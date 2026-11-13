/**
 * Guest side of the raw text session (STUDIO_TEXT_INPUT.md section D).
 *
 * Pure and dependency-injected so it runs in bun unit tests and in QuickJS:
 *  - `emit(name, payload)` sends `textInput.rawOpen/rawUpdate/rawClose` to the host
 *    (in a guest: `pocket._emitValue({type:"event", name, payload})`).
 *  - `subscribeText(handler)` is the framework `onTextEvent` (events: key / commit /
 *    composition / compositionEnd); the handler is registered only while the session is open.
 *  - `subscribeHost(listener)` delivers host events (`textInput.rawOpened`, `textInput.rawDismiss`).
 *
 * Mutual exclusion: the host keeps at most one raw or InputField session and answers the
 * older one with `rawDismiss {reason:"replaced"}`; additionally one module level slot closes
 * a previous guest session locally when a second one opens, so two editors never both think
 * they own the IME.
 */
import type { RawTextEvent } from "./editor.ts";

export interface RawRect { x: number; y: number; w: number; h: number }

/** Framework `TextEvent` shape (framework/src/text-input.ts). */
export type FrameworkTextEvent =
  | { kind: "key"; key: string; pressed: boolean; repeat: boolean }
  | { kind: "commit"; text: string }
  | { kind: "composition"; text: string; selectionStart: number; selectionEnd: number }
  | { kind: "compositionEnd" };

export interface RawHostEvent { method: string; params: Record<string, unknown> }

export interface RawTextSessionOptions {
  id: string;
  emit: (name: string, payload: Record<string, unknown>) => boolean;
  subscribeText: (handler: (e: FrameworkTextEvent) => boolean | void) => () => void;
  subscribeHost?: (listener: (e: RawHostEvent) => void) => () => void;
  /** Normalised event (keyDown / keyUp / composition / compositionEnd / commit). */
  onEvent: (e: RawTextEvent) => void;
  /** Open state changed; `reason` is the host dismiss reason when the host closed it. */
  onState?: (open: boolean, reason?: string) => void;
}

let activeSession: RawTextSession | null = null;

/** Convert a framework text event to the editor's raw event. */
export function normalizeTextEvent(e: FrameworkTextEvent): RawTextEvent | null {
  switch (e.kind) {
    case "key": return { kind: e.pressed ? "keyDown" : "keyUp", key: e.key, repeat: e.repeat };
    case "commit": return { kind: "commit", text: e.text };
    case "composition": return { kind: "composition", text: e.text, selectionStart: e.selectionStart, selectionEnd: e.selectionEnd };
    case "compositionEnd": return { kind: "compositionEnd" };
  }
  return null;
}

export class RawTextSession {
  private opened = false;
  private acked = false;
  private offText: (() => void) | null = null;
  private offHost: (() => void) | null = null;
  private lastRect: RawRect | null = null;
  /** Last host dismiss reason ("unavailable" when raw input is not enabled). */
  lastDismiss: string | null = null;

  constructor(private o: RawTextSessionOptions) {}

  get isOpen(): boolean { return this.opened; }
  /** The host confirmed the attachment (`rawOpened`). */
  get isAcked(): boolean { return this.acked; }

  /** Open (or move the caret rect of) the session. Returns false when the host refused the emit. */
  open(rect: RawRect): boolean {
    if (this.opened) return this.update(rect);
    if (activeSession && activeSession !== this) activeSession.localClose("replaced");
    let ok = false;
    try { ok = this.o.emit("textInput.rawOpen", { id: this.o.id, rect }); } catch { ok = false; }
    if (!ok) return false;
    this.opened = true; this.acked = false; this.lastDismiss = null; this.lastRect = rect;
    activeSession = this;
    this.offText = this.o.subscribeText(e => {
      if (!this.opened) return false;
      const n = normalizeTextEvent(e);
      if (!n) return false;
      this.o.onEvent(n);
      return true;
    });
    if (!this.offHost && this.o.subscribeHost) this.offHost = this.o.subscribeHost(ev => this.onHost(ev));
    this.o.onState?.(true);
    return true;
  }

  /** Move the IME caret rectangle; a no-op when unchanged. */
  update(rect: RawRect): boolean {
    if (!this.opened) return false;
    const l = this.lastRect;
    if (l && l.x === rect.x && l.y === rect.y && l.w === rect.w && l.h === rect.h) return true;
    let ok = false;
    try { ok = this.o.emit("textInput.rawUpdate", { id: this.o.id, rect }); } catch { ok = false; }
    if (ok) this.lastRect = rect;
    return ok;
  }

  close(): void {
    if (!this.opened) return;
    try { this.o.emit("textInput.rawClose", { id: this.o.id }); } catch { /* host gone */ }
    this.teardown();
    this.o.onState?.(false, "closed");
  }

  dispose(): void { this.close(); this.offHost?.(); this.offHost = null; }

  private onHost(ev: RawHostEvent): void {
    if (String(ev.params.id) !== this.o.id) return;
    if (ev.method === "textInput.rawOpened") { if (this.opened) this.acked = true; }
    else if (ev.method === "textInput.rawDismiss") {
      const reason = typeof ev.params.reason === "string" ? ev.params.reason : "platform";
      this.lastDismiss = reason;
      if (this.opened) { this.teardown(); this.o.onState?.(false, reason); }
    }
  }

  private localClose(reason: string): void {
    if (!this.opened) return;
    this.lastDismiss = reason;
    this.teardown();
    this.o.onState?.(false, reason);
  }

  private teardown(): void {
    this.opened = false; this.acked = false; this.lastRect = null;
    this.offText?.(); this.offText = null;
    if (activeSession === this) activeSession = null;
  }
}
