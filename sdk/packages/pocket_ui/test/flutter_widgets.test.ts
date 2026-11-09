import { strict as assert } from "node:assert";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const testDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(testDir, "../src/flutter-widgets.tsx"), "utf8");

for (const name of [
  "FlutterDivider",
  "FlutterLinearProgressIndicator",
  "FlutterChip",
  "FlutterIconButton",
  "FlutterFloatingActionButton",
  "FlutterNavigationDestination",
]) {
  assert.match(source, new RegExp(`export function ${name}`));
}

assert.match(source, /from "@pocketjs\/framework\/solid\/components"/);
assert.match(source, /Focusable/);
assert.match(source, /<View/);
assert.match(source, /<Text/);
assert.match(source, /scaleX: value/);
assert.match(source, /originX: -0\.5/);
assert.match(source, /value: number/);
assert.match(source, /focusable=\{!disabled\(\)\}/);
assert.match(source, /export const Divider = FlutterDivider/);
assert.match(source, /export const NavigationDestination = FlutterNavigationDestination/);

// Compile an independent consumer fixture through the pinned guest pipeline.
// This keeps the SDK test self-contained and verifies that public exports are
// consumable without importing demo internals.
// build_guest materializes @pocket/ui under the consumer's node_modules. Keep
// the consumer outside the package source tree: otherwise copying the SDK
// package would recursively copy its own fixture into itself.
const fixture = join(testDir, "fixture");
const consumer = mkdtempSync(join(tmpdir(), "pocket-ui-flutter-widgets-"));
cpSync(fixture, consumer, { recursive: true });
const buildGuest = join(testDir, "../../../scripts/build_guest.ts");
const retainedOutdir = process.env.POCKET_WIDGET_FIXTURE_OUTDIR;
const output = retainedOutdir ?? mkdtempSync(join(tmpdir(), "pocket-ui-flutter-widgets-build-"));
try {
  const build = spawnSync("bun", [buildGuest, `--project-root=${consumer}`, `--outdir=${output}`], {
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  assert.match(`${build.stdout}\n${build.stderr}`, /QuickJS bytecode|PocketJS build: done/);
} finally {
  rmSync(consumer, { recursive: true, force: true });
  if (!retainedOutdir) rmSync(output, { recursive: true, force: true });
}

if (retainedOutdir) console.log(`flutter_widgets.test: retained fixture artifacts at ${retainedOutdir}`);

console.log("flutter_widgets.test: public Flutter vocabulary adapters and independent guest consumer passed");

// Unit test for F9: IME same-ID out-of-order stale echo protection
{
  const effects: (() => void)[] = [];
  const cleanupCallbacks: Array<() => void> = [];
  const frameCallbacks: Array<() => void> = [];
  let scrollOffset = 0;
  let scrollMax = Number.POSITIVE_INFINITY;
  let scrollerOptions: any;
  let layoutQueryCount = 0;
  let zeroWidthContent = false;
  let zeroWidthViewport = false;
  const viewportWidth = 180;
  let nextViewNodeId = 1000;
  let viewportNodeId = 0;
  let contentNodeId = 0;
  let pressInput: (() => void) | undefined;
  let inputPressCount = 0;
  const contextValues = new Map<object, unknown>();
  const nodeMirrors = new Map<number, any>();
  const attachNode = (parent: any, child: any): void => {
    if (!parent || !child || typeof child !== "object" || typeof child.id !== "number") return;
    const oldIndex = child.parent?.children?.indexOf(child) ?? -1;
    if (oldIndex >= 0) child.parent.children.splice(oldIndex, 1);
    child.parent = parent;
    parent.children.push(child);
  };

  const mockSolid = {
    createSignal: <T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => void] => {
      let val = initial;
      return [
        () => val,
        (next: T | ((prev: T) => T)) => {
          val = typeof next === "function" ? (next as any)(val) : next;
          for (const effect of effects) effect();
        },
      ];
    },
    createEffect: (fn: () => void) => {
      effects.push(fn);
      fn();
    },
    createMemo: (fn: () => any) => () => fn(),
    createContext: <T>(defaultValue: T) => {
      const context: any = { defaultValue };
      context.Provider = (props: any) => {
        contextValues.set(context, props.value);
        return props.children;
      };
      return context;
    },
    useContext: (context: any) => contextValues.has(context) ? contextValues.get(context) : context?.defaultValue,
    children: (fn: any) => fn,
    onCleanup: (callback: () => void) => {
      cleanupCallbacks.push(callback);
    },
    untrack: <T>(fn: () => T): T => fn(),
    onMount: (callback: () => void) => callback(),
    For: () => null,
    Show: () => null,
  };

  const { mock } = await import("bun:test");
  mock.module("react/jsx-dev-runtime", () => ({
    jsxDEV: (tag: any, props: any) => {
      if (typeof tag === "function") return tag(props);
      return { tag, props };
    },
  }));
  mock.module("solid-js", () => mockSolid);
  mock.module("@pocketjs/framework/clock", () => ({ simulationHz: () => 60, virtualNow: () => 0 }));
  mock.module(join(testDir, "../src/route.tsx"), () => ({
    useRouteActive: () => () => true,
  }));
  mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({ cancel: () => {} }) }));
  mock.module("@pocketjs/framework/host", () => ({
    getOps: () => ({ hitTestBounds: () => viewportNodeId }),
  }));
  mock.module("@pocketjs/framework/kinetics", () => ({
    bindDpadScroll: () => ({}),
    createScroller: (options: any) => {
      scrollerOptions = options;
      return {
        offset: () => scrollOffset,
        state: () => "idle",
        stop: () => {},
        beginDrag: () => {},
        drag: () => {},
        endDrag: () => {},
        step: () => {},
        scrollTo: (to: number) => {
          scrollOffset = Math.max(0, Math.min(scrollMax, to));
        },
        scrollBy: (delta: number) => {
          scrollOffset = Math.max(0, Math.min(scrollMax, scrollOffset + delta));
        },
      };
    },
  }));
  mock.module("@pocketjs/framework/solid/lifecycle", () => ({
    onFrame: (callback: () => void) => {
      frameCallbacks.push(callback);
    },
  }));
  mock.module("@pocketjs/framework/solid/components", () => ({
    CompositorSurface: () => null,
    Focusable: (props: any) => {
      const node = { id: 101, type: 0, parent: null, children: [] as any[] };
      nodeMirrors.set(node.id, node);
      attachNode(nodeMirrors.get(contentNodeId), node);
      props?.nodeRef?.(node);
      pressInput = () => {
        inputPressCount += 1;
        props?.onPress?.();
      };
      return node;
    },
    Grid: () => null,
    Modal: () => null,
    Portal: () => null,
    Text: () => null,
    View: (props: any) => {
      const id = ++nextViewNodeId;
      if (props?.class === "flex-1 w-full overflow-hidden") viewportNodeId = id;
      if (props?.class === "flex-col w-full shrink-0") contentNodeId = id;
      const node = { id, type: 0, parent: null, children: [] as any[] };
      nodeMirrors.set(id, node);
      const children = Array.isArray(props?.children) ? props.children : [props?.children];
      for (const child of children) attachNode(node, child);
      props?.ref?.(node);
      return node;
    },
  }));

  const emitted: Array<{ type: string; name: string; payload: any }> = [];
  let emissionMode: "success" | "false" | "throw" = "success";
  const mockEmitValue = (packet: { type: string; name: string; payload: any }): boolean => {
    if (emissionMode === "false") return false;
    if (emissionMode === "throw") throw new Error("mock bridge emission failure");
    emitted.push(packet);
    return true;
  };
  let inputLayout: any = { x: 0, y: 200, width: 300, height: 48 };
  (globalThis as any).pocket = {
    getLayout: (id: number) => {
      if (id === 101) return inputLayout;
      if (id === viewportNodeId) {
        return {
          x: 0,
          y: 0,
          width: zeroWidthViewport ? 0 : viewportWidth,
          height: 400,
        };
      }
      if (id === contentNodeId) {
        return {
          x: 0,
          y: 0,
          width: zeroWidthContent ? 0 : viewportWidth,
          height: zeroWidthContent ? 900 : 400,
        };
      }
      layoutQueryCount += 1;
      if (zeroWidthContent) {
        // ScrollablePage queries the viewport then the content canvas. Keep
        // the viewport valid while injecting a retained content width of 0;
        // the content height must still update the kinetic extent.
        return layoutQueryCount % 2 === 1
          ? { x: 0, y: 0, width: viewportWidth, height: 400 }
          : { x: 0, y: 0, width: 0, height: 900 };
      }
      return { x: 0, y: 0, width: viewportWidth, height: 400 };
    },
    _emitValue: mockEmitValue,
  };

  const { deliverTextInputEvent, InputField, ScrollablePage, getActiveTextInputSession } = await import("../src/ui.tsx");

  const [draft, setDraft] = mockSolid.createSignal("");

  // Mount the SDK page scroller before the input. The fallback test below
  // models a retained layout node being temporarily unavailable during a
  // Duo/keyboard resize while the last overlay rect is still valid.
  ScrollablePage({ children: null });
  InputField({
    value: draft,
    onInput: (v: string) => setDraft(v),
  });

  // The native resize path dispatches this existing event synchronously,
  // before PocketView requests its delta=0 frame. Verify that the page
  // measurement is refreshed without waiting for onFrame, even with no input
  // session open yet.
  (globalThis as any).ui = { __viewport: { w: 300, h: 250 } };
  const receiveViewport = (globalThis as any).__pocketEvent as ((packet: Record<string, unknown>) => void) | undefined;
  assert.ok(receiveViewport, "ScrollablePage should subscribe to display.viewport");
  receiveViewport!({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 250 },
  });
  assert.equal(scrollerOptions.max(), 150, "resize event must refresh the page extent before frame(0)");
  console.log("flutter_widgets.test: display.viewport synchronous measurement passed");

  // Desktop wheel/trackpad events use the same logical viewport coordinates
  // and feed the existing page Scroller. They never synthesize pointer taps.
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 36, phase: "update", source: "wheel" },
  });
  assert.equal(scrollOffset, 36, "wheel delta should update the page scroller immediately");
  frameCallbacks.forEach((callback) => callback());
  assert.equal(scrollOffset, 36, "the next guest frame must retain the input-driven scroll offset");
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 400, y: 100, deltaX: 0, deltaY: 18, phase: "update", source: "wheel" },
  });
  assert.equal(scrollOffset, 36, "wheel input outside the ScrollablePage viewport must be ignored");
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 400, y: 100, deltaX: 0, deltaY: 18, phase: "start", source: "trackpad" },
  });
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 18, phase: "update", source: "trackpad" },
  });
  assert.equal(scrollOffset, 36, "a trackpad sequence started outside a page must stay unclaimed");
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 0, phase: "end", source: "trackpad" },
  });
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 12, phase: "update", source: "trackpad" },
  });
  assert.equal(scrollOffset, 36, "trackpad updates without a start must not acquire a page");
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 12, phase: "start", source: "trackpad" },
  });
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 12, phase: "update", source: "trackpad" },
  });
  assert.equal(scrollOffset, 48, "trackpad update delta should use the same positive-down scroll direction");
  frameCallbacks.forEach((callback) => callback());
  receiveViewport!({
    type: "event",
    name: "input.scroll",
    payload: { x: 40, y: 100, deltaX: 0, deltaY: 0, phase: "end", source: "trackpad" },
  });
  assert.equal(inputPressCount, 0, "desktop scroll must not dispatch a click handler");
  assert.equal(emitted.length, 0, "desktop scroll before focus must not open an IME session");
  console.log("flutter_widgets.test: wheel/trackpad routing and guest frame offset passed");

  // Open the input field
  assert.ok(pressInput, "InputField should provide an onPress handler to focus/open");
  pressInput();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, "textInput.open");
  assert.equal(emitted[0].payload.revision, 0);
  assert.equal(emitted[0].payload.jsRevision, 1);
  const inputId = emitted[0].payload.id;
  const inputEditingSession = emitted[0].payload.editingSession;
  assert.equal(typeof inputEditingSession, "string");
  const inputColorKeys = [
    "textColor",
    "placeholderColor",
    "fillColor",
    "borderColor",
    "focusedBorderColor",
  ];
  for (const key of inputColorKeys) {
    assert.equal(emitted[0].payload[key], "transparent", `textInput.open ${key} must stay transparent until attachment`);
  }

  // An explicit controlled-value change while the native overlay is mounted
  // but before its attach ACK must not reveal native glyphs or its fill/border.
  setDraft("before-ack");
  assert.equal(emitted.length, 2);
  const beforeAckUpdate = emitted[1];
  assert.equal(beforeAckUpdate.name, "textInput.update");
  assert.equal(beforeAckUpdate.payload.text, "before-ack");
  assert.equal(beforeAckUpdate.payload.jsRevision, 2);
  for (const key of inputColorKeys) {
    assert.equal(beforeAckUpdate.payload[key], "transparent", `pre-ACK update ${key} must stay transparent`);
  }
  emissionMode = "false";
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      // This mount ACK was created before the controlled value update above.
      jsRevision: 1,
    }),
    false,
    "a failed appearance handoff must remain retryable",
  );
  assert.equal(emitted.length, 2, "a rejected restore must not be recorded as emitted");
  emissionMode = "throw";
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      jsRevision: 1,
    }),
    false,
    "a thrown appearance handoff must preserve the Guest fallback",
  );
  assert.equal(emitted.length, 2);
  const pocketBridge = (globalThis as any).pocket;
  delete pocketBridge._emitValue;
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      jsRevision: 1,
    }),
    false,
    "a missing bridge emitter must preserve the Guest fallback",
  );
  assert.equal(emitted.length, 2);
  pocketBridge._emitValue = mockEmitValue;
  emissionMode = "success";
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      jsRevision: 1,
    }),
    true,
    "the current native overlay attachment acknowledgement should be accepted",
  );
  assert.equal(emitted.length, 3, "a valid ACK should emit one appearance-only restore");
  const appearanceRestore = emitted[2];
  assert.equal(appearanceRestore.name, "textInput.update");
  assert.equal(appearanceRestore.payload.id, inputId);
  assert.equal(appearanceRestore.payload.editingSession, inputEditingSession);
  assert.equal(appearanceRestore.payload.jsRevision, 2);
  const restoredInputColors = ["#09090B", "#71717A", "#ffffff", "#E4E4E7", "#18181B"];
  inputColorKeys.forEach((key, index) => {
    assert.equal(appearanceRestore.payload[key], restoredInputColors[index]);
  });
  for (const key of [
    "text",
    "selectionBase",
    "selectionExtent",
    "composingBase",
    "composingExtent",
    "rect",
    "clip",
  ]) {
    assert.equal(Object.hasOwn(appearanceRestore.payload, key), false, `appearance restore must omit ${key}`);
  }
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      jsRevision: 1,
    }),
    true,
    "a duplicate current-session mount ACK remains accepted",
  );
  assert.equal(emitted.length, 3, "a duplicate ACK must not resend the appearance restore");
  emissionMode = "false";
  pressInput();
  assert.equal(
    getActiveTextInputSession()?.isOpen(),
    true,
    "a failed refresh must retain an already attached native editor session",
  );
  emissionMode = "success";
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      jsRevision: 1,
    }),
    true,
    "a failed refresh must retain the existing appearance handoff",
  );
  assert.equal(emitted.length, 3, "a ready session does not resend appearance on a duplicate ACK");
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: `${inputEditingSession}:stale`,
      revision: 0,
      jsRevision: 1,
    }),
    false,
    "an opened acknowledgement from another editing session must be rejected",
  );
  assert.equal(emitted.length, 3, "a stale-session ACK must not emit a restore");

  // A transient zero-width viewport must use the retained pane width. The
  // live host width is the full Duo window (300 here), so accepting it would
  // expand the input clip across the sibling pane and emit a false overlay
  // resize. The retained content node may still report its height normally.
  zeroWidthViewport = true;
  layoutQueryCount = 0;
  frameCallbacks.forEach((callback) => callback());
  assert.equal(emitted.length, 3, "zero-width viewport must retain the pane clip");
  assert.equal(scrollerOptions.max(), 150, "zero-width viewport must retain its height");
  zeroWidthViewport = false;

  // A host may deliver a layout frame before publishing its live viewport
  // snapshot. The retained pane geometry must still be usable; the missing
  // optional global must not widen the clip or drop the scroll extent.
  const savedUi = (globalThis as any).ui;
  (globalThis as any).ui = {};
  zeroWidthViewport = true;
  frameCallbacks.forEach((callback) => callback());
  assert.equal(emitted.length, 3, "missing live viewport must retain the pane clip");
  assert.equal(scrollerOptions.max(), 150, "missing live viewport must retain page extent");
  zeroWidthViewport = false;
  (globalThis as any).ui = savedUi;

  zeroWidthContent = true;
  layoutQueryCount = 0;
  frameCallbacks.forEach((callback) => callback());
  assert.equal(
    scrollerOptions.max(),
    650,
    "a zero-width retained content node must still contribute its measured height",
  );
  zeroWidthContent = false;

  // The real core reports transforms through DrawOps while getLayout may
  // briefly return no record during a retained-tree relayout. The emitted
  // open rect is already visual (y=200). It must not be translated a second
  // time from the stale fallback when the page offset is 50.
  scrollOffset = 50;
  inputLayout = undefined;
  frameCallbacks.forEach((callback) => callback());
  assert.equal(
    emitted.length,
    3,
    "a transiently missing layout must retain the last visual overlay rect",
  );

  // Restore the committed layout and verify that a real raw layout still
  // receives exactly one page translation (200 - 50 = 150).
  inputLayout = { x: 0, y: 200, width: 300, height: 48 };
  frameCallbacks.forEach((callback) => callback());
  assert.equal(emitted.length, 4);
  assert.equal(emitted[3].name, "textInput.update");
  assert.equal(emitted[3].payload.rect.y, 150);
  console.log("flutter_widgets.test: zero-width content and visual fallback regressions passed");
  // Keep the original IME ordering assertions focused on the open/edit lane;
  // the layout-only event was fully asserted above.
  emitted.splice(3, 1);

  // A resize-time ensureVisible correction is not a user scroll. Limit the
  // mock scroller so the correction remains partially clipped; the next
  // frame must not close the still-focused input merely because the offset
  // changed during that automatic correction.
  frameCallbacks.forEach((callback) => callback());
  scrollMax = 60;
  (globalThis as any).ui = { __viewport: { w: 300, h: 100 } };
  receiveViewport!({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 100 },
  });
  frameCallbacks.forEach((callback) => callback());
  assert.equal(
    emitted.some((event) => event.name === "textInput.close"),
    false,
    "automatic resize scrolling must not be treated as a user scroll",
  );
  assert.equal(
    getActiveTextInputSession()?.isOpen(),
    true,
    "ensureVisible must not spuriously trigger focus loss or close on subsequent frame tick",
  );
  console.log("flutter_widgets.test: ensureVisible focus preservation on subsequent frame passed");
  scrollMax = Number.POSITIVE_INFINITY;
  (globalThis as any).ui = { __viewport: { w: 300, h: 250 } };
  receiveViewport!({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 250 },
  });
  frameCallbacks.forEach((callback) => callback());
  emitted.splice(1);

  // 1) textInput.edit with revision: 1, text: "ab"
  const handled1 = deliverTextInputEvent("textInput.edit", {
    id: inputId,
    revision: 1,
    text: "ab",
    selectionBase: 2,
    selectionExtent: 2,
  });
  assert.equal(handled1, true);
  assert.equal(draft(), "ab");
  assert.equal(emitted.length, 1);

  // 2) textInput.edit with revision: 2, text: "abc"
  const handled2 = deliverTextInputEvent("textInput.edit", {
    id: inputId,
    revision: 2,
    text: "abc",
    selectionBase: 3,
    selectionExtent: 3,
  });
  assert.equal(handled2, true);
  assert.equal(draft(), "abc");
  assert.equal(emitted.length, 1);

  // 3) Stale echo arrives: textInput.edit with revision: 1, text: "ab"
  const handledStale = deliverTextInputEvent("textInput.edit", {
    id: inputId,
    revision: 1,
    text: "ab",
    selectionBase: 2,
    selectionExtent: 2,
  });
  assert.equal(handledStale, false, "Stale revision must be rejected by deliverTextInputEvent");
  assert.equal(draft(), "abc", "Draft must stay 'abc' despite stale revision 1 echo");
  assert.equal(emitted.length, 1);

  // 4) Explicit JS signal update: setDraft("reset")
  setDraft("reset");
  assert.equal(draft(), "reset");
  // sendUpdate should have emitted textInput.update with incremented jsRevision (3) and lastNativeRevision (2)
  assert.equal(emitted.length, 2);
  const updateEvent = emitted[1];
  assert.equal(updateEvent.name, "textInput.update");
  assert.equal(updateEvent.payload.text, "reset");
  assert.equal(updateEvent.payload.revision, 2);
  assert.equal(updateEvent.payload.jsRevision, 3);
  assert.equal(updateEvent.payload.force, true);

  console.log("flutter_widgets.test: IME out-of-order stale echo protection passed");

  // A disposed page may still be reachable through a host callback captured
  // before its parent restored the bridge. The observer must be inert after
  // cleanup rather than updating a detached signal or calling onChange.
  const staleViewportReceiver = (globalThis as any).__pocketEvent as ((packet: Record<string, unknown>) => void) | undefined;
  assert.ok(staleViewportReceiver);
  const emittedBeforeCleanup = emitted.length;
  for (const cleanup of cleanupCallbacks.splice(0).reverse()) cleanup();
  assert.equal(
    deliverTextInputEvent("textInput.opened", {
      id: inputId,
      editingSession: inputEditingSession,
      revision: 0,
      jsRevision: 1,
    }),
    false,
    "an acknowledgement after InputField unmount must not reopen its visual overlay state",
  );
  staleViewportReceiver!({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 220 },
  });
  assert.equal(emitted.length, emittedBeforeCleanup + 1, "input cleanup may emit one close event");
  console.log("flutter_widgets.test: display observer cleanup guard passed");
}
