import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Payload contract for the multi-line InputField. The single-line default must
// stay byte-identical for existing callers; multi-line only adds metadata.
const testDir = dirname(fileURLToPath(import.meta.url));
const effects: (() => void)[] = [];
const contextValues = new Map<object, unknown>();
let pressInput: (() => void) | undefined;
let nextNodeId = 500;

const mockSolid = {
  createSignal: <T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => void] => {
    let val = initial;
    return [
      () => val,
      (next) => {
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
  onCleanup: () => {},
  untrack: <T>(fn: () => T): T => fn(),
  onMount: (callback: () => void) => callback(),
  For: () => null,
  Show: () => null,
};

const { mock } = await import("bun:test");
mock.module("react/jsx-dev-runtime", () => ({
  jsxDEV: (tag: any, props: any) => (typeof tag === "function" ? tag(props) : { tag, props }),
}));
mock.module("solid-js", () => mockSolid);
mock.module("@pocketjs/framework/clock", () => ({ simulationHz: () => 60, virtualNow: () => 0 }));
mock.module(join(testDir, "../../src/route.tsx"), () => ({ useRouteActive: () => () => true }));
mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({ cancel: () => {} }) }));
mock.module("@pocketjs/framework/host", () => ({ getOps: () => ({ hitTestBounds: () => 0 }) }));
mock.module("@pocketjs/framework/kinetics", () => ({ bindDpadScroll: () => ({}), createScroller: () => ({}) }));
mock.module("@pocketjs/framework/solid/lifecycle", () => ({ onFrame: () => {} }));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: () => null,
  Focusable: (props: any) => {
    const node = { id: 101, type: 0, parent: null, children: [] as any[] };
    props?.nodeRef?.(node);
    pressInput = () => props?.onPress?.();
    return node;
  },
  Grid: () => null,
  Modal: () => null,
  Portal: () => null,
  Text: () => null,
  View: (props: any) => {
    const node = { id: ++nextNodeId, type: 0, parent: null, children: [] as any[] };
    props?.ref?.(node);
    return node;
  },
}));

const emitted: Array<{ name: string; payload: any }> = [];
(globalThis as any).pocket = {
  getLayout: () => ({ x: 0, y: 200, width: 300, height: 48 }),
  _emitValue: (packet: { name: string; payload: any }) => {
    emitted.push(packet);
    return true;
  },
};

const { InputField, getActiveTextInputSession } = await import("../../src/ui.tsx");

function openWith(extra: Record<string, unknown>): any {
  emitted.length = 0;
  const [value] = mockSolid.createSignal("");
  InputField({ value, onInput: () => {}, ...extra });
  pressInput!();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, "textInput.open");
  const payload = emitted[0].payload;
  getActiveTextInputSession()?.close();
  return payload;
}

// Default: exactly the historical single-line metadata.
const single = openWith({});
assert.equal(single.keyboardType, "text");
assert.equal(single.action, "done");
assert.equal(single.maxLines, 1);
assert.equal(Object.hasOwn(single, "minLines"), false);
const keys = Object.keys(single);
assert.ok(keys.indexOf("keyboardType") < keys.indexOf("action") && keys.indexOf("action") < keys.indexOf("maxLines"));
assert.equal(JSON.stringify(openWith({ multiline: false, maxLines: 9, minLines: 3 })).includes('"minLines"'), false);

// Unbounded multi-line: explicit null maxLines.
const unbounded = openWith({ multiline: true });
assert.equal(unbounded.keyboardType, "multiline");
assert.equal(unbounded.action, "newline");
assert.equal(unbounded.maxLines, null);
assert.equal(Object.hasOwn(unbounded, "maxLines"), true);
assert.equal(Object.hasOwn(unbounded, "minLines"), false);

// Bounded, with a minimum (clamped to the maximum).
const bounded = openWith({ multiline: true, maxLines: 6, minLines: 3 });
assert.equal(bounded.maxLines, 6);
assert.equal(bounded.minLines, 3);
assert.equal(openWith({ multiline: true, maxLines: 2, minLines: 5 }).minLines, 2);
// Invalid numbers fall back to unbounded / omitted.
const invalid = openWith({ multiline: true, maxLines: 0, minLines: Number.NaN });
assert.equal(invalid.maxLines, null);
assert.equal(Object.hasOwn(invalid, "minLines"), false);

console.log("input_field_multiline.test: single-line payload unchanged; multiline payload passed");
