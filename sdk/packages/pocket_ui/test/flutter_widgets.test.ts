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
    createContext: () => ({}),
    useContext: () => ({}),
    children: (fn: any) => fn,
    onCleanup: (callback: () => void) => {
      cleanupCallbacks.push(callback);
    },
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
  mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({}) }));
  mock.module("@pocketjs/framework/kinetics", () => ({
    bindDpadScroll: () => ({}),
    createScroller: (options: any) => {
      scrollerOptions = options;
      return {
        offset: () => scrollOffset,
        stop: () => {},
        beginDrag: () => {},
        drag: () => {},
        endDrag: () => {},
        step: () => {},
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
      props?.nodeRef?.({ id: 101 });
      pressInput = props?.onPress;
      return null;
    },
    Grid: () => null,
    Modal: () => null,
    Text: () => null,
    View: (props: any) => {
      const id = ++nextViewNodeId;
      if (props?.class === "flex-1 w-full overflow-hidden") viewportNodeId = id;
      if (props?.class === "flex-col w-full shrink-0") contentNodeId = id;
      props?.ref?.({ id });
      return null;
    },
  }));

  const emitted: Array<{ type: string; name: string; payload: any }> = [];
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
    _emit: (line: string) => {
      emitted.push(JSON.parse(line));
      return true;
    },
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
  const receiveViewport = (globalThis as any).__pocketEvent as ((line: string) => void) | undefined;
  assert.ok(receiveViewport, "ScrollablePage should subscribe to display.viewport");
  receiveViewport!(JSON.stringify({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 250 },
  }));
  assert.equal(scrollerOptions.max(), 150, "resize event must refresh the page extent before frame(0)");
  console.log("flutter_widgets.test: display.viewport synchronous measurement passed");

  // Open the input field
  assert.ok(pressInput, "InputField should provide an onPress handler to focus/open");
  pressInput();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, "textInput.open");
  assert.equal(emitted[0].payload.revision, 0);
  assert.equal(emitted[0].payload.jsRevision, 1);
  const inputId = emitted[0].payload.id;

  // A transient zero-width viewport must use the retained pane width. The
  // live host width is the full Duo window (300 here), so accepting it would
  // expand the input clip across the sibling pane and emit a false overlay
  // resize. The retained content node may still report its height normally.
  zeroWidthViewport = true;
  layoutQueryCount = 0;
  frameCallbacks.forEach((callback) => callback());
  assert.equal(emitted.length, 1, "zero-width viewport must retain the pane clip");
  assert.equal(scrollerOptions.max(), 150, "zero-width viewport must retain its height");
  zeroWidthViewport = false;

  // A host may deliver a layout frame before publishing its live viewport
  // snapshot. The retained pane geometry must still be usable; the missing
  // optional global must not widen the clip or drop the scroll extent.
  const savedUi = (globalThis as any).ui;
  (globalThis as any).ui = {};
  zeroWidthViewport = true;
  frameCallbacks.forEach((callback) => callback());
  assert.equal(emitted.length, 1, "missing live viewport must retain the pane clip");
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
    1,
    "a transiently missing layout must retain the last visual overlay rect",
  );

  // Restore the committed layout and verify that a real raw layout still
  // receives exactly one page translation (200 - 50 = 150).
  inputLayout = { x: 0, y: 200, width: 300, height: 48 };
  frameCallbacks.forEach((callback) => callback());
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].name, "textInput.update");
  assert.equal(emitted[1].payload.rect.y, 150);
  console.log("flutter_widgets.test: zero-width content and visual fallback regressions passed");
  // Keep the original IME ordering assertions focused on the open/edit lane;
  // the layout-only event was fully asserted above.
  emitted.splice(1, 1);

  // A resize-time ensureVisible correction is not a user scroll. Limit the
  // mock scroller so the correction remains partially clipped; the next
  // frame must not close the still-focused input merely because the offset
  // changed during that automatic correction.
  frameCallbacks.forEach((callback) => callback());
  scrollMax = 60;
  (globalThis as any).ui = { __viewport: { w: 300, h: 100 } };
  receiveViewport!(JSON.stringify({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 100 },
  }));
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
  receiveViewport!(JSON.stringify({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 250 },
  }));
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
  // sendUpdate should have emitted textInput.update with incremented jsRevision (2) and lastNativeRevision (2)
  assert.equal(emitted.length, 2);
  const updateEvent = emitted[1];
  assert.equal(updateEvent.name, "textInput.update");
  assert.equal(updateEvent.payload.text, "reset");
  assert.equal(updateEvent.payload.revision, 2);
  assert.equal(updateEvent.payload.jsRevision, 2);
  assert.equal(updateEvent.payload.force, true);

  console.log("flutter_widgets.test: IME out-of-order stale echo protection passed");

  // A disposed page may still be reachable through a host callback captured
  // before its parent restored the bridge. The observer must be inert after
  // cleanup rather than updating a detached signal or calling onChange.
  const staleViewportReceiver = (globalThis as any).__pocketEvent as ((line: string) => void) | undefined;
  assert.ok(staleViewportReceiver);
  const emittedBeforeCleanup = emitted.length;
  for (const cleanup of cleanupCallbacks.splice(0).reverse()) cleanup();
  staleViewportReceiver!(JSON.stringify({
    type: "event",
    name: "display.viewport",
    payload: { width: 300, height: 220 },
  }));
  assert.equal(emitted.length, emittedBeforeCleanup + 1, "input cleanup may emit one close event");
  console.log("flutter_widgets.test: display observer cleanup guard passed");
}
