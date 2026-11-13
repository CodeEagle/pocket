/**
 * CodeView: Pocket-native, virtualised code editor UI over the pure core (index.ts).
 * See sdk/docs/CODE_VIEW.md. Only host node types view/text are used.
 *
 * Rendering: one `InlineText` leaf per visible line (coloured token runs in one Core text
 * leaf), rows live in a ring of `slots` recycled nodes (slot = line % slots), so scrolling
 * by one line re-renders one row. Rows, gutter numbers, selection/match/caret rectangles
 * sit in content layers that are translated (paint only) by the scroll offset.
 */
import { Index, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { after, virtualNow } from "@pocketjs/framework/clock";
import { onTextEvent } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { Focusable, Text, View, type NodeMirror } from "@pocketjs/framework/solid/components";
import { InlineText, inlineFontSlot, type InlineTextRef } from "../inline-text.tsx";
import { subscribeHostEvents } from "../display.ts";
import { createPocketClipboardClient } from "../clipboard.ts";
import type { HostBridge } from "../host.ts";
import { CodeEditor, type EditorIntent, type RawTextEvent } from "./editor.ts";
import { TokenCache, languageForPath, type Language } from "./tokenizer.ts";
import { darkTheme, lightTheme, type TokenTheme } from "./theme.ts";
import { columnToX, gutterWidth, scrollToReveal, visibleRange, xToColumn } from "./viewport.ts";
import { lookupKey, parseKey, type Platform } from "./keymap.ts";
import { single, rangeFrom, rangeTo } from "./selection.ts";
import { wordLeft, wordRight } from "./buffer.ts";
import { FindModel } from "./find.ts";
import { RawTextSession } from "./raw-text.ts";
import {
  ClickTracker, SEVERITY_COLORS, buildLineModel, calibrate, diagnosticsByLine, displayToSourceCol, hexToAbgr, makeMetrics,
  matchesInRange, slotLine, sourceColX, spansForLines, type CalibratedMetrics, type CodeDiagnostic, type LineModel,
} from "./view-model.ts";

export type { CodeDiagnostic } from "./view-model.ts";

export interface CodeViewDebug {
  /** Total nodes created by CodeView components (rows, gutter, rects, bar). */
  nodesMounted: number;
  /** Currently alive. */
  nodesLive: number;
  /** Line render models built (== rows whose InlineText content changed). */
  linesBuilt: number;
  /** Colour runs produced by those builds. */
  runsCreated: number;
  /** Lines built by the last handled input event / the last scroll step. */
  lastEditLines: number;
  lastScrollLines: number;
  /** Guest wall time (ms, Date.now) of the last input event and the total over all. */
  lastEditMs: number;
  editMsTotal: number;
  edits: number;
  slots: number;
  firstLine: number;
  lastLine: number;
  scrollTop: number;
  scrollLeft: number;
  calibrated: boolean;
  monospace: boolean;
  charWidth: number;
  focused: boolean;
  rawDismiss: string | null;
  /** Last outbound host event and whether the host accepted it. */
  lastEmit?: string;
}

export interface CodeViewHandle {
  readonly editor: CodeEditor;
  readonly find: FindModel;
  debug: CodeViewDebug;
  focus(): void;
  blur(): void;
  /** Re-read the editor after the app mutated it directly. */
  refresh(): void;
  scrollToLine(line: number): void;
  openFind(): void;
}

export interface CodeClipboard { readText(): Promise<string | null>; writeText(text: string): Promise<void> }

export interface CodeViewProps {
  /** An editor instance (preferred) ... */
  editor?: CodeEditor;
  /** ... or controlled text: CodeView owns an editor and reports changes. */
  value?: string;
  onChange?: (text: string) => void;
  /** File path for the language (extension) when `language` is not given. */
  path?: string;
  language?: Language;
  theme?: "light" | "dark" | TokenTheme;
  /** Fixed size in px; otherwise fills the parent (w-full h-full) and is measured. */
  width?: number;
  height?: number;
  lineHeight?: number;
  tabSize?: number;
  readOnly?: boolean;
  gutter?: boolean;
  diagnostics?: readonly CodeDiagnostic[];
  platform?: Platform;
  /** Called for every clipboard/find/save intent; return false to skip the built-in handling. */
  onIntent?: (intent: EditorIntent) => boolean | void;
  /**
   * Offered every key-down of the main text area before the editor handles it. `owned` is true when the editor's own keymap
   * maps the key (Cmd+S, Cmd+F, Esc, arrows ...). Return true to consume the key; the editor then never sees it. An app shell
   * uses this for its global shortcuts without taking editor-scoped keys away (see studio/docs/ARCHITECTURE.md, keymap).
   */
  onKeyDown?: (key: string, owned: boolean) => boolean | void;
  onCursorChange?: (c: { line: number; column: number; offset: number; anchor: number; selections: number }) => void;
  /** A host bridge (clipboard.readText/writeText) or a ready client. Without one an internal clipboard is used. */
  host?: HostBridge;
  clipboard?: CodeClipboard;
  /** Measured-width override: `charWidth` skips calibration; `measure(cp)` returns cell widths. */
  charWidth?: number;
  measure?: (codePoint: number) => number;
  /** Override the inline font slot (default: the baked "body" slot). */
  fontSlot?: number;
  /** Touch mode: a drag in the text pans instead of selecting. */
  dragScrolls?: boolean;
  /** Raw session id (unique per CodeView). */
  id?: string;
  debug?: Partial<CodeViewDebug>;
  ref?: (h: CodeViewHandle) => void;
}

// Referenced indirectly on purpose: the compiler bakes inline font slots only for an APP-side
// `inlineFontSlot(` callsite, and plain consumers must not pay for them (INLINE_TEXT_IMPLEMENTATION.md).
const slotOf: (role: "body") => number = inlineFontSlot;
const OVERSCAN = 4;
const TOKEN_BUDGET_MS = 60;
const PAD_LEFT = 8;
const EMPTY_MODEL: LineModel = { display: "", colMap: [0], runs: [] };
let nextViewId = 1;

type Rect = { x: number; y: number; w: number; h: number; color: string };
type Field = "editor" | "query" | "replace";

interface LayoutRect { x: number; y: number; w: number; h: number }
function layoutOf(node: NodeMirror | undefined): LayoutRect | undefined {
  const g = (globalThis as any).pocket?.getLayout;
  if (!node || typeof g !== "function") return undefined;
  try {
    const r = g(node.id);
    if (!r || typeof r !== "object") return undefined;
    const w = Number(r.width ?? r.w), h = Number(r.height ?? r.h);
    if (!(w > 0) || !(h > 0)) return undefined;
    return { x: Number(r.x), y: Number(r.y), w, h };
  } catch { return undefined; }
}

export function CodeView(props: CodeViewProps): JSX.Element {
  const viewId = props.id ?? `code-view-${nextViewId++}`;
  const editor: CodeEditor = props.editor ?? new CodeEditor(props.value ?? "", { platform: props.platform });
  if (props.platform) editor.platform = props.platform;
  const platform = (): Platform => props.platform ?? editor.platform;
  const dbg: CodeViewDebug = Object.assign({
    nodesMounted: 0, nodesLive: 0, linesBuilt: 0, runsCreated: 0, lastEditLines: 0, lastScrollLines: 0, lastEditMs: 0, editMsTotal: 0, edits: 0,
    slots: 0, firstLine: 0, lastLine: 0, scrollTop: 0, scrollLeft: 0, calibrated: false, monospace: true, charWidth: 9, focused: false, rawDismiss: null,
  } as CodeViewDebug, props.debug);
  const track = (): void => { dbg.nodesMounted++; dbg.nodesLive++; onCleanup(() => { dbg.nodesLive--; }); };

  const [rev, setRev] = createSignal(0);
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  const [vp, setVp] = createSignal({ w: props.width ?? 360, h: props.height ?? 480 });
  const [focused, setFocused] = createSignal(false);
  const [caretOn, setCaretOn] = createSignal(true);
  const [cal, setCal] = createSignal<CalibratedMetrics | null>(null);
  const [findOpen, setFindOpen] = createSignal(false);
  const [field, setField] = createSignal<Field>("editor");
  const [tipLine, setTipLine] = createSignal(-1);
  const [fieldRev, setFieldRev] = createSignal(0);

  const lh = (): number => props.lineHeight ?? 20;
  const tabSize = (): number => props.tabSize ?? 4;
  const theme = (): TokenTheme => typeof props.theme === "object" ? props.theme : props.theme === "light" ? lightTheme : darkTheme;
  const showGutter = (): boolean => props.gutter !== false;
  const fontSlot = (): number => {
    if (props.fontSlot !== undefined) return props.fontSlot;
    try { return slotOf("body"); } catch { throw new Error("CodeView: pass fontSlot={inlineFontSlot(\"body\")} from the app so the compiler bakes the inline font slots"); }
  };
  const lang = (): Language => props.language ?? (props.path ? languageForPath(props.path) : "plain");

  // --- calibrated metrics -------------------------------------------------
  const calib = (): { charWidth: number; spaceCells: number; cjkCells: number } => {
    if (props.charWidth) return { charWidth: props.charWidth, spaceCells: 1, cjkCells: 2 };
    return cal() ?? { charWidth: 9, spaceCells: 1, cjkCells: 2 };
  };
  const nbsp = (): boolean => !!cal()?.nbsp;
  const metrics = createMemo(() => makeMetrics(lh(), calib(), props.measure, 8, PAD_LEFT));
  const cw = (): number => metrics().charWidth;
  const gutterW = createMemo(() => (showGutter() ? gutterWidth(Math.max(1, (rev(), editor.buffer.lineCount)), metrics()) : 0));
  const textW = (): number => Math.max(1, vp().w - gutterW());

  // --- tokens ---------------------------------------------------------------
  let tokenCache: TokenCache | null = null;
  // A large file is tokenized over several turns (the guest has a 250 ms budget per turn); rows past the
  // tokenized prefix are uncoloured until the cache catches up, then repaint.
  let tokenTimer = false, disposed = false;
  const scheduleTokens = (): void => {
    if (tokenTimer || !tokenCache?.pending) return;
    tokenTimer = true;
    after(0.016, () => {
      tokenTimer = false;
      if (disposed || !tokenCache) return;
      const before = tokenCache.valid;
      tokenCache.advance(i => editor.buffer.line(i), TOKEN_BUDGET_MS);
      if (tokenCache.valid !== before) { setRev(v => v + 1); }
      scheduleTokens();
    });
  };
  onCleanup(() => { disposed = true; (tokenCache as any)?.detach?.(); });
  const cache = createMemo(() => {
    const l = lang();
    tokenCache = new TokenCache(l);
    tokenCache.attach(editor.buffer, TOKEN_BUDGET_MS);
    scheduleTokens();
    return tokenCache;
  });

  // --- text change tracking (maxLen, onChange) -----------------------------
  let textDirty = false, maxLenDirty = true, maxLen = 0;
  const offBuf = editor.buffer.onChange(c => {
    textDirty = true;
    if (c.newLineCount !== undefined && c.oldLineCount !== c.newLineCount) maxLenDirty = true;
    else maxLenDirty = true;
  });
  onCleanup(offBuf);
  const longest = (): number => {
    if (maxLenDirty) { let m = 0; const b = editor.buffer; for (let i = 0; i < b.lineCount; i++) { const n = b.lineLength(i); if (n > m) m = n; } maxLen = m; maxLenDirty = false; }
    return maxLen;
  };

  // --- per-line render models (shared by rows and overlays) -----------------
  const models = new Map<number, { text: string; tok: number[] | undefined; th: TokenTheme; nb: boolean; tab: number; model: LineModel }>();
  const getModel = (l: number): LineModel => {
    const b = editor.buffer;
    if (l < 0 || l >= b.lineCount) return EMPTY_MODEL;
    const text = b.line(l), tok = cache().line(l), th = theme(), nb = nbsp(), tab = tabSize();
    const hit = models.get(l);
    if (hit && hit.text === text && hit.tok === tok && hit.th === th && hit.nb === nb && hit.tab === tab) return hit.model;
    const model = buildLineModel(text, tok, th, tab, nb);
    dbg.linesBuilt++; dbg.runsCreated += model.runs.length;
    models.set(l, { text, tok, th, nb, tab, model });
    return model;
  };
  const textOfModel = (l: number): string => getModel(l).display;

  // --- visible window --------------------------------------------------------
  const lineCount = (): number => (rev(), editor.buffer.lineCount);
  const range = createMemo(() => visibleRange(lineCount(), lh(), vp().h, scrollTop(), OVERSCAN));
  const slots = createMemo(() => Math.max(1, Math.ceil(vp().h / lh()) + 2 * OVERSCAN + 2));
  createEffect(() => {
    const r = range();
    dbg.slots = slots(); dbg.firstLine = r.first; dbg.lastLine = r.last;
    for (const k of models.keys()) if (k < r.first - 20 || k >= r.last + 20) models.delete(k);
  });

  const maxTop = (): number => Math.max(0, lineCount() * lh() - vp().h);
  const maxLeft = (): number => Math.max(0, longest() * cw() + 2 * PAD_LEFT + 2 - textW());
  const setScroll = (top: number, left: number): void => {
    const t = Math.min(Math.max(0, top), maxTop()), l = Math.min(Math.max(0, left), maxLeft());
    const before = dbg.linesBuilt;
    batch(() => { setScrollTop(t); setScrollLeft(l); });
    dbg.scrollTop = t; dbg.scrollLeft = l; dbg.lastScrollLines = dbg.linesBuilt - before;
  };

  // --- root geometry ------------------------------------------------------------
  let rootNode: NodeMirror | undefined;
  const rootRect = (): LayoutRect | undefined => layoutOf(rootNode);
  const measureRoot = (): LayoutRect | undefined => {
    const r = rootRect();
    if (r && (r.w !== vp().w || r.h !== vp().h) && props.width === undefined && props.height === undefined) setVp({ w: r.w, h: r.h });
    return r;
  };
  onFrame(() => { measureRoot(); }, { continuous: false });

  // --- calibration (one hidden InlineText, removed afterwards) ----------------
  const [calibrating, setCalibrating] = createSignal(!props.charWidth);
  const [calSource, setCalSource] = createSignal("0");
  const calRef: InlineTextRef = { current: null };
  const measureStr = (s: string): number => {
    setCalSource(s);
    const lay = calRef.current?.getLayout();
    return lay?.links?.[0]?.rects?.[0]?.width ?? 0;
  };
  onMount(() => {
    if (!calibrating()) return;
    let tries = 0;
    const attempt = (): void => {
      if (!calibrating()) return;
      const result = calibrate({ digit: measureStr("0".repeat(20)), space: measureStr(" ".repeat(20)), nbsp: measureStr(" ".repeat(20)), cjk: measureStr("你".repeat(10)) });
      if (result) {
        batch(() => { setCal(result); setCalibrating(false); });
        dbg.calibrated = true; dbg.monospace = result.monospace; dbg.charWidth = result.charWidth;
      } else if (++tries < 50) after(0.03, attempt);
      else setCalibrating(false);
    };
    after(0.03, attempt);
  });
  if (props.charWidth) { dbg.calibrated = true; dbg.charWidth = props.charWidth; }

  // --- caret blink (virtual-clock deadline, no frame loop) --------------------
  let cancelBlink: (() => void) | undefined;
  const restartBlink = (): void => {
    cancelBlink?.(); cancelBlink = undefined;
    setCaretOn(true);
    if (!focused()) return;
    const tick = (): void => { cancelBlink = after(0.5, () => { setCaretOn(v => !v); tick(); }); };
    tick();
  };
  onCleanup(() => { cancelBlink?.(); });

  // --- find ------------------------------------------------------------------
  const find = new FindModel(editor);
  const qEd = new CodeEditor("", { platform: platform() });
  const rEd = new CodeEditor("", { platform: platform() });
  const fieldEditor = (f: Field): CodeEditor => (f === "query" ? qEd : f === "replace" ? rEd : editor);
  const syncFind = (): void => { find.query = qEd.buffer.getText(); find.replacement = rEd.buffer.getText(); find.refresh(); };

  // --- clipboard --------------------------------------------------------------
  let internalClip = "";
  const clip = (): CodeClipboard | undefined => props.clipboard ?? (props.host ? createPocketClipboardClient(props.host) : undefined);

  // --- cursor reporting ----------------------------------------------------------
  let lastCursorKey = "";
  const reportCursor = (): void => {
    const r = editor.selection.ranges[editor.selection.primary];
    const key = `${r.anchor}:${r.head}:${editor.selection.ranges.length}`;
    if (key === lastCursorKey) return;
    lastCursorKey = key;
    const p = editor.buffer.positionAt(r.head);
    props.onCursorChange?.({ line: p.line, column: p.column, offset: r.head, anchor: r.anchor, selections: editor.selection.ranges.length });
  };

  const caretXY = (off: number): { line: number; x: number } => {
    const p = editor.buffer.positionAt(off);
    return { line: p.line, x: sourceColX(getModel(p.line), p.column, metrics()) + PAD_LEFT };
  };

  const reveal = (): void => {
    const r = editor.selection.ranges[editor.selection.primary];
    const { line, x } = caretXY(r.head);
    const top = scrollToReveal(line, lh(), vp().h, scrollTop());
    let left = scrollLeft();
    if (x < left + 4) left = Math.max(0, x - 24);
    else if (x + 2 * cw() > left + textW()) left = x + 2 * cw() - textW() + 8;
    if (top !== scrollTop() || left !== scrollLeft()) setScroll(top, left);
  };

  const afterEdit = (t0: number, reveal_: boolean): void => {
    const before = dbg.linesBuilt;
    const textChanged = textDirty;
    batch(() => {
      if (textChanged) { textDirty = false; setTipLine(-1); }
      if (findOpen() && textChanged) find.refresh();
      else if (findOpen()) find.syncCurrent();
      setRev(v => v + 1);
      if (reveal_) reveal();
    });
    dbg.lastEditLines = dbg.linesBuilt - before;
    restartBlink();
    reportCursor();
    if (textChanged) {
      props.onChange?.(editor.buffer.getText());
    }
    const ms = Date.now() - t0;
    dbg.lastEditMs = ms; dbg.editMsTotal += ms; dbg.edits++;
  };

  // --- intents -------------------------------------------------------------------
  const openFind = (): void => {
    batch(() => {
      const r = editor.selection.ranges[editor.selection.primary];
      if (r.anchor !== r.head) {
        const t = editor.buffer.getRange(rangeFrom(r), rangeTo(r));
        if (t.indexOf("\n") < 0) { qEd.buffer.setText(t); qEd.selection = single(t.length); }
      }
      setFindOpen(true); setField("query"); setFieldRev(v => v + 1);
      syncFind();
      setRev(v => v + 1);
    });
    ensureSession();
  };
  const closeFind = (): void => { batch(() => { setFindOpen(false); setField("editor"); setRev(v => v + 1); }); };

  const handleIntent = (intent: EditorIntent, ed: CodeEditor): void => {
    if (props.onIntent?.(intent) === false) return;
    const t0 = Date.now();
    switch (intent.type) {
      case "clipboard.write": {
        internalClip = intent.text;
        const c = clip();
        if (c) c.writeText(intent.text).catch(() => { /* internal clipboard keeps the text */ });
        break;
      }
      case "clipboard.read": {
        const apply = (text: string | null): void => {
          let t = text ?? internalClip;
          if (ed !== editor) t = t.replace(/\r?\n/g, " ");
          if (props.readOnly && ed === editor) return;
          if (ed.paste(t)) { if (ed === editor) afterEdit(Date.now(), true); else { syncFind(); setFieldRev(v => v + 1); setRev(v => v + 1); } }
        };
        const c = clip();
        if (!c) apply(null); else c.readText().then(apply, () => apply(null));
        break;
      }
      case "find": openFind(); break;
      case "findNext": case "findPrev":
        if (!findOpen()) openFind();
        else { if (intent.type === "findNext") find.next(); else find.prev(); afterEdit(t0, true); }
        break;
      case "save": break;
    }
  };

  // --- raw text input ----------------------------------------------------------------
  let shiftHeld = false;
  const READONLY_OK = /^(copy|selectAll|find|findNext|findPrev|save|cursor.*|select.*)$/;

  const handleField = (f: Exclude<Field, "editor">, ev: RawTextEvent): void => {
    const ed = fieldEditor(f);
    const t0 = Date.now();
    if (ev.kind === "keyDown") {
      const k = parseKey(ev.key);
      const id = lookupKey(ev.key, platform());
      if (props.onKeyDown?.(ev.key, id !== null) === true) return;
      if (k.key === "Escape") { closeFind(); restartBlink(); return; }
      if (k.key === "Enter" && !k.control && !k.meta && !k.alt) {
        if (f === "query") { if (k.shift) find.prev(); else find.next(); } else find.replaceOne();
        afterEdit(t0, true); setFieldRev(v => v + 1);
        return;
      }
      if (k.key === "Tab") { setField(f === "query" ? "replace" : "query"); return; }
      if (id === "find") { setField("query"); setFieldRev(v => v + 1); return; }
      if (id === "findNext") { find.next(); afterEdit(t0, true); return; }
      if (id === "findPrev") { find.prev(); afterEdit(t0, true); return; }
      if (id === "newline" || id === "save" || id === "indent" || id === "outdent" || id === "toggleLineComment" || id === "indentLines") return;
      const out = ed.handleInput(ev);
      if (out.intent) handleIntent(out.intent, ed);
    } else if (ev.kind === "commit") {
      ed.handleInput({ kind: "commit", text: ev.text.replace(/\r?\n/g, " ") });
    } else if (ev.kind !== "keyUp") ed.handleInput(ev);
    batch(() => { syncFind(); setFieldRev(v => v + 1); setRev(v => v + 1); });
    restartBlink();
    dbg.lastEditMs = Date.now() - t0;
  };

  const handleMain = (ev: RawTextEvent): void => {
    const t0 = Date.now();
    if (ev.kind === "keyDown" || ev.kind === "keyUp") {
      const pk = parseKey(ev.key);
      if (pk.key === "Shift") shiftHeld = ev.kind === "keyDown";
    }
    if (ev.kind === "keyUp") return;
    if (ev.kind === "keyDown") {
      const pk = parseKey(ev.key);
      if (props.onKeyDown?.(ev.key, lookupKey(ev.key, platform()) !== null) === true) return;
      if (pk.key === "Escape" && findOpen() && editor.selection.ranges.length === 1) { closeFind(); return; }
      if (props.readOnly) { const id = lookupKey(ev.key, platform()); if (!id || !READONLY_OK.test(id)) return; }
    } else if (props.readOnly) return;
    const out = editor.handleInput(ev);
    if (out.intent) handleIntent(out.intent, editor);
    if (out.handled || out.changed) afterEdit(t0, true);
  };

  const onRaw = (ev: RawTextEvent): void => { if (field() === "editor") handleMain(ev); else handleField(field() as Exclude<Field, "editor">, ev); };

  const emit = (name: string, payload: Record<string, unknown>): boolean => {
    const e = (globalThis as any).pocket?._emitValue;
    const ok = typeof e === "function" && e({ type: "event", name, payload }) === true;
    dbg.lastEmit = name + ":" + ok;
    return ok;
  };
  const session = new RawTextSession({
    id: viewId,
    emit,
    subscribeText: h => onTextEvent(h as any),
    subscribeHost: l => subscribeHostEvents(ev => l({ method: ev.method, params: ev.params as Record<string, unknown> })),
    onEvent: onRaw,
    onState: (open, reason) => {
      setFocused(open); dbg.focused = open; if (!open) dbg.rawDismiss = reason ?? null; else dbg.rawDismiss = null;
      restartBlink();
    },
  });
  onCleanup(() => session.dispose());

  /** Caret rect in guest viewport coordinates for the IME. */
  const imeRect = (): { x: number; y: number; w: number; h: number } => {
    const r = rootRect() ?? { x: 0, y: 0, w: vp().w, h: vp().h };
    const f = field();
    if (f === "editor") {
      const head = editor.selection.ranges[editor.selection.primary].head;
      const { line, x } = caretXY(head);
      return { x: r.x + gutterW() + x - scrollLeft(), y: r.y + line * lh() - scrollTop(), w: 2, h: lh() };
    }
    const ed = fieldEditor(f);
    const col = ed.buffer.positionAt(ed.selection.ranges[ed.selection.primary].head).column;
    const g = barGeom();
    const fx = g.x + g.fieldX + 4 + col * cw();
    return { x: r.x + fx, y: r.y + (f === "query" ? g.row1 : g.row2), w: 2, h: lh() };
  };
  const ensureSession = (): void => { session.open(imeRect()); };
  createEffect(() => { if (focused()) { rev(); scrollTop(); scrollLeft(); field(); fieldRev(); vp(); gutterW(); session.update(imeRect()); } });

  // --- pointer ------------------------------------------------------------------------
  const clicks = new ClickTracker();
  type Drag = { mode: "select" | "pan" | "gutter" | "pending"; anchorFrom: number; anchorTo: number; unit: 1 | 2 | 3; x0: number; y0: number; moved: boolean };
  let drag: Drag | null = null;

  const hitAt = (x: number, y: number): { line: number; column: number; offset: number } => {
    const b = editor.buffer;
    let line = Math.floor((y + scrollTop()) / lh());
    line = line < 0 ? 0 : line >= b.lineCount ? b.lineCount - 1 : line;
    const model = getModel(line);
    const dcol = xToColumn(model.display, x - gutterW() - PAD_LEFT + scrollLeft(), metrics());
    const column = Math.min(displayToSourceCol(model, dcol), b.lineLength(line));
    return { line, column, offset: b.offsetAt(line, column) };
  };
  const wordAt = (offset: number): { from: number; to: number } => {
    const b = editor.buffer; const p = b.positionAt(offset); const t = b.line(p.line);
    if (t.length === 0) return { from: offset, to: offset };
    const to = wordRight(t, p.column), from = wordLeft(t, to);
    return { from: b.offsetAt(p.line, from), to: b.offsetAt(p.line, to) };
  };
  const lineAt = (offset: number): { from: number; to: number } => {
    const b = editor.buffer; const l = b.positionAt(offset).line;
    return { from: b.lineStart(l), to: l < b.lineCount - 1 ? b.lineStart(l + 1) : b.lineEnd(l) };
  };
  const unitRange = (off: number, unit: 1 | 2 | 3): { from: number; to: number } => (unit === 1 ? { from: off, to: off } : unit === 2 ? wordAt(off) : lineAt(off));

  const barGeom = (): { x: number; w: number; h: number; row1: number; row2: number; fieldX: number; fieldW: number } => {
    const h = lh() * 2 + 18, w = Math.min(vp().w - 8, Math.max(300, cw() * 38));
    return { x: vp().w - w - 4, w, h, row1: 6, row2: 6 + lh() + 6, fieldX: 6, fieldW: Math.max(60, w - 6 - cw() * 20) };
  };
  const inBar = (x: number, y: number): boolean => { if (!findOpen()) return false; const g = barGeom(); return x >= g.x && x <= g.x + g.w && y >= 0 && y <= g.h + 4; };

  const sel = (a: number, h: number): void => { editor.setSelection(single(a, h)); };

  createGesture({
    region: { rect: () => { const r = rootRect(); return r ?? { x: 0, y: 0, w: vp().w, h: vp().h }; } },
    onDown(c) {
      const r = measureRoot() ?? { x: 0, y: 0, w: vp().w, h: vp().h };
      const x = c.x - r.x, y = c.y - r.y;
      drag = null;
      if (inBar(x, y)) return;
      const t0 = Date.now();
      if (x < gutterW()) { drag = { mode: "gutter", anchorFrom: 0, anchorTo: 0, unit: 1, x0: c.x, y0: c.y, moved: false }; return; }
      const n = clicks.register(c.x, c.y, virtualNow());
      const unit = n as 1 | 2 | 3;
      const hit = hitAt(x, y);
      batch(() => { if (field() !== "editor") { setField("editor"); setFieldRev(v => v + 1); } });
      if (props.dragScrolls) { drag = { mode: "pending", anchorFrom: hit.offset, anchorTo: hit.offset, unit, x0: c.x, y0: c.y, moved: false }; ensureSession(); return; }
      const u = unitRange(hit.offset, unit);
      if (unit === 1 && shiftHeld) {
        const a = editor.selection.ranges[editor.selection.primary].anchor;
        sel(a, hit.offset); drag = { mode: "select", anchorFrom: a, anchorTo: a, unit: 1, x0: c.x, y0: c.y, moved: false };
      } else {
        if (unit === 1) sel(hit.offset, hit.offset); else sel(u.from, u.to);
        drag = { mode: "select", anchorFrom: u.from, anchorTo: u.to, unit, x0: c.x, y0: c.y, moved: false };
      }
      ensureSession();
      afterEdit(t0, false);
    },
    onMove(c) {
      if (!drag) return;
      const r = rootRect() ?? { x: 0, y: 0, w: vp().w, h: vp().h };
      const d = drag;
      if (!d.moved && Math.abs(c.x - d.x0) + Math.abs(c.y - d.y0) < 6) return;
      d.moved = true;
      if (d.mode === "gutter" || (d.mode === "pending")) { setScroll(scrollTop() - c.fdy, scrollLeft() - c.fdx); return; }
      const x = c.x - r.x, y = c.y - r.y;
      // edge auto-scroll while dragging a selection
      if (y < 0) setScroll(scrollTop() + y * 0.5, scrollLeft());
      else if (y > vp().h) setScroll(scrollTop() + (y - vp().h) * 0.5, scrollLeft());
      const hit = hitAt(x, Math.min(Math.max(y, 0), vp().h - 1));
      const u = unitRange(hit.offset, d.unit);
      if (d.unit === 1) sel(d.anchorFrom, hit.offset);
      else if (hit.offset < d.anchorFrom) sel(d.anchorTo, u.from);
      else sel(d.anchorFrom, u.to);
      afterEdit(Date.now(), false);
    },
    onUp(c) {
      const d = drag; drag = null;
      if (!d || d.moved) return;
      const r = rootRect() ?? { x: 0, y: 0, w: vp().w, h: vp().h };
      const t0 = Date.now();
      if (d.mode === "gutter") {
        const hit = hitAt(c.x - r.x + gutterW(), c.y - r.y);
        const lu = lineAt(hit.offset);
        sel(lu.from, lu.to);
        setTipLine(hit.line);
        afterEdit(t0, false);
      } else if (d.mode === "pending") {
        sel(d.anchorFrom, d.anchorFrom); afterEdit(t0, false);
      }
    },
    onCancel() { drag = null; },
  });

  // wheel / trackpad
  const offScroll = subscribeHostEvents(ev => {
    if (ev.method !== "input.scroll") return;
    const p = ev.params as Record<string, unknown>;
    if (p.phase !== "update") return;
    const r = rootRect(); const x = Number(p.x), y = Number(p.y);
    if (r && Number.isFinite(x) && Number.isFinite(y) && (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h)) return;
    const dy = Number(p.deltaY) || 0, dx = Number(p.deltaX) || 0;
    if (dx !== 0 || dy !== 0) setScroll(scrollTop() + dy, scrollLeft() + dx);
  });
  onCleanup(offScroll);

  // --- handle --------------------------------------------------------------------------
  const handle: CodeViewHandle = {
    editor, find, debug: dbg,
    focus: ensureSession,
    blur: () => session.close(),
    refresh: () => { textDirty = true; afterEdit(Date.now(), true); },
    scrollToLine: (l: number) => setScroll(l * lh(), scrollLeft()),
    openFind,
  };
  props.ref?.(handle);

  // --- layers -------------------------------------------------------------------------------
  const layers = createMemo(() => {
    rev(); fieldRev();
    const r = range(), b = editor.buffer, h = lh();
    const th = theme();
    const bands: Rect[] = [], matches: Rect[] = [], selRects: Rect[] = [], under: Rect[] = [], carets: Rect[] = [];
    const contentW = Math.max(textW(), longest() * cw() + 2 * PAD_LEFT + 40) + scrollLeft();
    const head = editor.selection.ranges[editor.selection.primary].head;
    const headLine = b.positionAt(head).line;
    const diag = diagnosticsByLine(props.diagnostics);
    for (let l = r.first; l < r.last; l++) {
      const d = diag.get(l);
      if (d) bands.push({ x: 0, y: l * h, w: contentW, h, color: SEVERITY_COLORS[d[0].severity] + "26" });
    }
    if (focused() && field() === "editor" && editor.selection.ranges.every(x => x.anchor === x.head)) bands.push({ x: 0, y: headLine * h, w: contentW, h, color: th.foreground + "12" });
    const startOff = b.lineStart(r.first), endOff = r.last < b.lineCount ? b.lineStart(r.last) : b.length + 1;
    const rectsFor = (rs: { from: number; to: number }[], color: (i: number) => string, out: Rect[]): void => {
      const spans = spansForLines(rs, r.first, r.last, o => b.lineAt(o), l => b.lineStart(l), l => b.lineLength(l), b.lineCount);
      let i = 0;
      for (const s of spans) {
        const m = getModel(s.line);
        const x0 = sourceColX(m, s.fromCol, metrics()), x1 = sourceColX(m, s.toCol, metrics()) + (s.eol ? cw() : 0);
        out.push({ x: PAD_LEFT + x0, y: s.line * h, w: Math.max(1, x1 - x0), h, color: color(i++) });
      }
    };
    if (findOpen() && find.matches.length) {
      const vis = matchesInRange(find.matches, startOff, endOff);
      const cur = find.current >= 0 ? find.matches[find.current] : null;
      rectsFor(vis, () => "#e3b34166", matches);
      if (cur) rectsFor([cur], () => "#f0883e99", matches);
    }
    const ranges = editor.selection.ranges.map(x => ({ from: rangeFrom(x), to: rangeTo(x) })).filter(x => x.to > x.from).sort((a, c) => a.from - c.from);
    rectsFor(ranges, () => th.selection, selRects);
    const mk = editor.marked;
    if (mk) {
      const tmp: Rect[] = []; rectsFor([mk], () => th.marked, tmp);
      for (const t of tmp) under.push({ x: t.x, y: t.y + h - 2, w: t.w, h: 2, color: th.marked });
    }
    if (focused() && caretOn() && field() === "editor") {
      for (const rg of editor.selection.ranges) {
        const p = b.positionAt(rg.head);
        if (p.line < r.first || p.line >= r.last) continue;
        carets.push({ x: PAD_LEFT + sourceColX(getModel(p.line), p.column, metrics()), y: p.line * h, w: 2, h, color: th.caret });
      }
    }
    return { bands, matches, sel: selRects, under, carets };
  });

  const diagMarks = createMemo(() => {
    rev();
    const r = range(), out: Rect[] = [];
    const diag = diagnosticsByLine(props.diagnostics);
    for (let l = r.first; l < r.last; l++) { const d = diag.get(l); if (d) out.push({ x: 4, y: l * lh() + (lh() - 8) / 2, w: 8, h: 8, color: SEVERITY_COLORS[d[0].severity] }); }
    return out;
  });

  const tip = createMemo(() => {
    rev();
    const head = editor.buffer.positionAt(editor.selection.ranges[editor.selection.primary].head);
    const line = tipLine() >= 0 ? tipLine() : head.line;
    const d = diagnosticsByLine(props.diagnostics).get(line);
    if (!d) return null;
    return { text: `${d[0].severity} Ln ${line + 1}${d[0].column !== undefined ? ":" + (d[0].column + 1) : ""}  ${d[0].message}`, color: SEVERITY_COLORS[d[0].severity] };
  });

  // --- row components -------------------------------------------------------------------
  const Row = (p: { k: number }): JSX.Element => {
    track();
    const line = createMemo(() => { const r = range(); return slotLine(p.k, slots(), r.first, r.last); });
    const model = createMemo(() => { rev(); theme(); nbsp(); tabSize(); const l = line(); return l < 0 ? EMPTY_MODEL : getModel(l); });
    const fg = createMemo(() => hexToAbgr(theme().foreground));
    const width = createMemo(() => Math.max(8, columnToX(model().display, model().display.length, metrics()) + 2 * cw() + 4));
    const runs = createMemo(() => model().runs);
    return (
      <InlineText
        source={model().display}
        runs={runs()}
        revealCodepoints={1 << 30}
        style={{ posType: 1, insetL: PAD_LEFT, insetT: Math.max(0, line()) * lh(), width: width(), fontSlot: fontSlot(), textColor: fg(), display: line() < 0 ? 1 : 0 }}
      />
    );
  };

  const GutterRow = (p: { k: number }): JSX.Element => {
    track();
    const line = createMemo(() => { const r = range(); return slotLine(p.k, slots(), r.first, r.last); });
    const label = createMemo(() => { const l = line(); return l < 0 ? "" : String(l + 1); });
    const active = createMemo(() => { rev(); return line() >= 0 && line() === editor.buffer.positionAt(editor.selection.ranges[editor.selection.primary].head).line; });
    return (
      <Text style={{ posType: 1, insetL: Math.max(14, gutterW() - 8 - label().length * cw()), insetT: Math.max(0, line()) * lh(), fontSlot: fontSlot(), textColor: hexToAbgr(active() ? theme().gutterActive : theme().gutter), display: line() < 0 ? 1 : 0 }}>{label()}</Text>
    );
  };

  const PoolRect = (p: { r: () => Rect }): JSX.Element => {
    track();
    return <View style={{ posType: 1, insetL: p.r().x, insetT: p.r().y, width: p.r().w, height: p.r().h, bgColor: p.r().color }} />;
  };
  const Pool = (p: { items: () => Rect[] }): JSX.Element => <Index each={p.items()}>{(r) => <PoolRect r={r} />}</Index>;

  const slotIdx = createMemo(() => Array.from({ length: slots() }, (_, i) => i));

  // --- find bar ---------------------------------------------------------------------------------
  const FieldBox = (p: { f: Exclude<Field, "editor">; y: () => number; w: () => number }): JSX.Element => {
    track();
    const ed = fieldEditor(p.f);
    const g = barGeom;
    const text = createMemo(() => { fieldRev(); return ed.buffer.getText(); });
    const caretX = createMemo(() => { fieldRev(); return 4 + ed.buffer.positionAt(ed.selection.ranges[ed.selection.primary].head).column * cw(); });
    const active = (): boolean => field() === p.f;
    return (
      <Focusable
        debugName={"CodeFind-" + p.f}
        onPress={() => { batch(() => { setField(p.f); setFieldRev(v => v + 1); }); ensureSession(); }}
        style={{ posType: 1, insetL: g().fieldX, insetT: p.y(), width: p.w(), height: lh() + 2, bgColor: theme().background, borderColor: active() ? theme().caret : theme().gutter, borderWidth: 1, radius: 3 }}
      >
        <Text style={{ posType: 1, insetL: 4, insetT: 1, fontSlot: fontSlot(), textColor: hexToAbgr(theme().foreground) }}>{text()}</Text>
        <Show when={active() && focused() && caretOn()}><View style={{ posType: 1, insetL: caretX(), insetT: 1, width: 2, height: lh(), bgColor: theme().caret }} /></Show>
      </Focusable>
    );
  };
  const Btn = (p: { x: () => number; y: () => number; w: number; label: string; on: () => void; active?: () => boolean; name: string }): JSX.Element => {
    track();
    return (
      <Focusable debugName={"CodeFind-" + p.name} onPress={p.on}
        style={{ posType: 1, insetL: p.x(), insetT: p.y(), width: p.w, height: lh() + 2, bgColor: p.active?.() ? theme().selection : theme().gutter + "33", radius: 3 }}>
        <Text style={{ posType: 1, insetL: 4, insetT: 1, fontSlot: fontSlot(), textColor: hexToAbgr(theme().foreground) }}>{p.label}</Text>
      </Focusable>
    );
  };
  const FindBar = (): JSX.Element => {
    track();
    const g = barGeom;
    const act = (fn: () => void) => () => { const t0 = Date.now(); fn(); afterEdit(t0, true); setFieldRev(v => v + 1); };
    const bw = cw() * 3 + 8;
    return (
      <View style={{ posType: 1, insetL: g().x, insetT: 0, width: g().w, height: g().h, bgColor: theme().background, borderColor: theme().gutter, borderWidth: 1, radius: 4 }}>
        <FieldBox f="query" y={() => g().row1} w={() => g().fieldW} />
        <Text style={{ posType: 1, insetL: g().fieldX + g().fieldW + 4, insetT: g().row1 + 1, fontSlot: fontSlot(), textColor: hexToAbgr(theme().gutter) }}>{(rev(), fieldRev(), find.label())}</Text>
        <Btn name="prev" x={() => g().w - 4 * bw - 4} y={() => g().row1} w={bw - 4} label=" ^" on={act(() => find.prev())} />
        <Btn name="next" x={() => g().w - 3 * bw - 4} y={() => g().row1} w={bw - 4} label=" v" on={act(() => find.next())} />
        <Btn name="case" x={() => g().w - 2 * bw - 4} y={() => g().row1} w={bw - 4} label="Aa" active={() => (rev(), !!find.options.caseSensitive)} on={act(() => { find.options = { ...find.options, caseSensitive: !find.options.caseSensitive }; find.refresh(); })} />
        <Btn name="close" x={() => g().w - bw - 4} y={() => g().row1} w={bw - 4} label=" x" on={() => closeFind()} />
        <FieldBox f="replace" y={() => g().row2} w={() => g().fieldW} />
        <Btn name="replace" x={() => g().fieldX + g().fieldW + 4} y={() => g().row2} w={cw() * 7 + 8} label="Replace" on={act(() => { if (!props.readOnly) find.replaceOne(); })} />
        <Btn name="all" x={() => g().fieldX + g().fieldW + 4 + cw() * 7 + 12} y={() => g().row2} w={cw() * 3 + 8} label="All" on={act(() => { if (!props.readOnly) find.replaceAll(); })} />
      </View>
    );
  };

  // --- render ---------------------------------------------------------------------------------------
  return (
    <View
      nodeRef={(n: NodeMirror) => { rootNode = n; }}
      debugName="CodeView"
      style={{ overflow: 1, width: props.width ?? -1, height: props.height ?? -1, bgColor: theme().background, ...(props.width === undefined && props.height === undefined ? { grow: 1 } : {}) }}
    >
      <Show when={showGutter()}>
        <View style={{ overflow: 1, posType: 1, insetL: 0, insetT: 0, width: gutterW(), height: vp().h, bgColor: theme().background }}>
          <View style={{ posType: 1, insetL: 0, insetT: 0, width: gutterW(), height: Math.max(1, lineCount() * lh()), translateY: -scrollTop() }}>
            <Index each={slotIdx()}>{(k) => <GutterRow k={k()} />}</Index>
            <Pool items={diagMarks} />
          </View>
        </View>
      </Show>
      <View style={{ overflow: 1, posType: 1, insetL: gutterW(), insetT: 0, width: textW(), height: vp().h }}>
        <View style={{ posType: 1, insetL: 0, insetT: 0, width: Math.max(textW(), longest() * cw() + 4 * PAD_LEFT), height: Math.max(1, lineCount() * lh()), translateX: -scrollLeft(), translateY: -scrollTop() }}>
          <Pool items={() => layers().bands} />
          <Pool items={() => layers().matches} />
          <Pool items={() => layers().sel} />
          <Index each={slotIdx()}>{(k) => <Row k={k()} />}</Index>
          <Pool items={() => layers().under} />
          <Pool items={() => layers().carets} />
        </View>
      </View>
      <Show when={tip()}>
        <View style={{ posType: 1, insetL: 0, insetT: Math.max(0, vp().h - lh() - 6), width: vp().w, height: lh() + 6, bgColor: theme().gutter + "ee" }}>
          <Text style={{ posType: 1, insetL: 8, insetT: 3, fontSlot: fontSlot(), textColor: hexToAbgr(theme().background) }}>{tip()!.text}</Text>
        </View>
      </Show>
      <Show when={findOpen()}><FindBar /></Show>
      <Show when={calibrating()}>
        <InlineText ref={calRef} source={calSource()} runs={calSource() ? [{ start: 0, end: Array.from(calSource()).length, linkId: "m" }] : []} revealCodepoints={1 << 30}
          style={{ posType: 1, insetL: 0, insetT: 0, width: 4000, fontSlot: fontSlot(), textColor: 0x00000000, display: 0 }} />
      </Show>
    </View>
  );
}
