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
    onCleanup: () => {},
    onMount: () => {},
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
  mock.module("@pocketjs/framework/kinetics", () => ({ bindDpadScroll: () => ({}), createScroller: () => ({}) }));
  mock.module("@pocketjs/framework/solid/lifecycle", () => ({ onFrame: () => {} }));
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
    View: () => null,
  }));

  const emitted: Array<{ type: string; name: string; payload: any }> = [];
  (globalThis as any).pocket = {
    getLayout: (_id: number) => ({ x: 0, y: 0, width: 300, height: 48 }),
    _emit: (line: string) => {
      emitted.push(JSON.parse(line));
      return true;
    },
  };

  const { deliverTextInputEvent, InputField } = await import("../src/ui.tsx");

  const [draft, setDraft] = mockSolid.createSignal("");

  InputField({
    value: draft,
    onInput: (v: string) => setDraft(v),
  });

  // Open the input field
  assert.ok(pressInput, "InputField should provide an onPress handler to focus/open");
  pressInput();

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, "textInput.open");
  assert.equal(emitted[0].payload.revision, 0);
  assert.equal(emitted[0].payload.jsRevision, 1);
  const inputId = emitted[0].payload.id;

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
}
