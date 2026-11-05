import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import type { HostEvent } from "../src/host.ts";
import type {
  AppleSemanticRect,
} from "../src/semantics.ts";

const frameCallbacks: Array<() => void> = [];
const frameContinuousHints: Array<() => boolean> = [];
let activeCleanups: Array<() => void> | undefined;
let activeEffect: (() => void) | undefined;

mock.module("@pocketjs/framework/solid/lifecycle", () => ({
  onFrame(callback: () => void, options: { continuous?: boolean | (() => boolean) } = {}): void {
    frameCallbacks.push(callback);
    const hint = options.continuous;
    frameContinuousHints.push(typeof hint === "function" ? hint : () => hint ?? true);
  },
}));
mock.module("solid-js", () => ({
  createContext<T>(fallback: T) {
    const context: { value: T; Provider: (props: { value: T; children: unknown }) => unknown } = {
      value: fallback,
      Provider: (props) => {
        context.value = props.value;
        return props.children;
      },
    };
    return context;
  },
  createEffect(callback: () => void): void {
    const run = () => {
      const previous = activeEffect;
      activeEffect = run;
      try { callback(); } finally { activeEffect = previous; }
    };
    run();
  },
  createSignal<T>(initial: T): [() => T, (next: T) => void] {
    let value = initial;
    const subscribers = new Set<() => void>();
    const read = () => {
      if (activeEffect) subscribers.add(activeEffect);
      return value;
    };
    return [read, (next: T) => {
      if (Object.is(value, next)) return;
      value = next;
      for (const subscriber of [...subscribers]) subscriber();
    }];
  },
  onCleanup(callback: () => void): void { activeCleanups?.push(callback); },
  useContext<T>(context: { value: T }): T { return context.value; },
  createRoot<T>(callback: (dispose: () => void) => T): T {
    const previous = activeCleanups;
    const cleanups: Array<() => void> = [];
    activeCleanups = cleanups;
    let disposed = false;
    const value = callback(() => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of [...cleanups].reverse()) cleanup();
    });
    activeCleanups = previous;
    return value;
  },
}));

const { createRoot, createSignal } = await import("solid-js");

const {
  ACCESSIBILITY_ACTION_EVENT,
  ACCESSIBILITY_SNAPSHOT_EVENT,
  createAppleSemanticsStore,
  MAX_APPLE_SEMANTIC_CONTROLS,
} = await import("../src/semantics.ts");

class SemanticsBridge {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly listeners = new Set<(event: HostEvent) => void>();

  emit(method: string, params: Record<string, unknown> = {}): boolean {
    this.sent.push({ method, params });
    return true;
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  deliver(params: Record<string, unknown>): void {
    const event = {
      id: "semantics-test",
      method: ACCESSIBILITY_ACTION_EVENT,
      params,
      raw: params,
    } as unknown as HostEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

const node = (id: number) => ({
  id,
  type: 0,
  parent: null,
  children: [],
});

function snapshots(bridge: SemanticsBridge): Array<Record<string, unknown>> {
  return bridge.sent
    .filter((event) => event.method === ACCESSIBILITY_SNAPSHOT_EVENT)
    .map((event) => event.params);
}

function resetFrames(): void {
  frameCallbacks.splice(0, frameCallbacks.length);
  frameContinuousHints.splice(0, frameContinuousHints.length);
}

function runFrame(): void {
  for (const callback of [...frameCallbacks]) callback();
}

test("explicit Apple controls publish committed geometry once and JS owns activate", async () => {
  resetFrames();
  const bridge = new SemanticsBridge();
  let layout: AppleSemanticRect = { x: 10, y: 20, width: 80, height: 40 };
  let getLayoutCalls = 0;
  const previousPocket = (globalThis as typeof globalThis & { pocket?: unknown }).pocket;
  (globalThis as typeof globalThis & { pocket?: unknown }).pocket = {
    getLayout: (id: number) => {
      getLayoutCalls++;
      return id === 7 ? layout : undefined;
    },
  };

  let disposeRoot!: () => void;
  let setRoute!: (value: boolean) => void;
  let setSelected!: (value: boolean) => void;
  let activateCount = 0;
  let store!: ReturnType<typeof createAppleSemanticsStore>;
  createRoot((dispose) => {
    disposeRoot = dispose;
    const [route, updateRoute] = createSignal(true);
    const [selected, updateSelected] = createSignal(false);
    setRoute = updateRoute;
    setSelected = updateSelected;
    store = createAppleSemanticsStore({
      bridge,
      routeActive: route,
      visualRect: (_current, committed) => ({
        ...committed,
        y: committed.y - 5,
      }),
      clipRect: () => ({ x: 0, y: 0, width: 200, height: 100 }),
    });
    const bind = store.register({
      id: "apple.save",
      label: "Save",
      role: "button",
      selected,
      disabled: false,
      checked: false,
      onActivate: () => { activateCount++; },
    });
    bind(node(7));
  });

  await Promise.resolve();
  runFrame();
  const first = snapshots(bridge);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.generation, 1);
  assert.deepEqual(first[0]!.controls, [{
    guestId: "apple.save",
    nativeId: 7,
    label: "Save",
    role: "button",
    selected: false,
    disabled: false,
    enabled: true,
    checked: false,
    rect: { x: 10, y: 15, width: 80, height: 40 },
  }]);
  const callsAfterFirst = getLayoutCalls;
  runFrame();
  assert.equal(snapshots(bridge).length, 1, "identical frames are deduplicated");
  assert.equal(getLayoutCalls, callsAfterFirst + 1, "passive hook rechecks committed layout on work frames");

  layout = { x: 12, y: 21, width: 80, height: 40 };
  runFrame();
  assert.equal(snapshots(bridge).length, 2);
  assert.deepEqual((snapshots(bridge)[1]!.controls as Array<Record<string, unknown>>)[0]!.rect, {
    x: 12, y: 16, width: 80, height: 40,
  });

  const generation = snapshots(bridge)[1]!.generation;
  bridge.deliver({ action: "activate", guestId: "apple.save", generation });
  assert.equal(activateCount, 1);
  setSelected(true);
  await Promise.resolve();
  runFrame();
  assert.equal(snapshots(bridge).length, 3);
  assert.equal((snapshots(bridge)[2]!.controls as Array<Record<string, unknown>>)[0]!.selected, true);

  setRoute(false);
  await Promise.resolve();
  runFrame();
  assert.equal((snapshots(bridge)[3]!.controls as unknown[]).length, 0, "hidden route removes controls");
  bridge.deliver({ action: "activate", guestId: "apple.save", generation: snapshots(bridge)[3]!.generation });
  assert.equal(activateCount, 1, "hidden route cannot activate a stale semantic node");

  setRoute(true);
  await Promise.resolve();
  runFrame();
  const visibleGeneration = snapshots(bridge).at(-1)!.generation;
  bridge.deliver({ action: "activate", guestId: "apple.save", generation: visibleGeneration - 1 });
  assert.equal(activateCount, 1, "stale generation is rejected");
  bridge.deliver({ action: "activate", guestId: "apple.save", generation: visibleGeneration });
  assert.equal(activateCount, 2);

  disposeRoot();
  store.dispose();
  assert.deepEqual((snapshots(bridge).at(-1)!.controls as unknown[]), [], "provider cleanup clears host overlay");
  (globalThis as typeof globalThis & { pocket?: unknown }).pocket = previousPocket;
  resetFrames();
});

test("Apple semantic registration is bounded and rejects duplicate stable ids", () => {
  resetFrames();
  const bridge = new SemanticsBridge();
  let disposeRoot!: () => void;
  createRoot((dispose) => {
    disposeRoot = dispose;
    const store = createAppleSemanticsStore({ bridge });
    for (let index = 0; index < MAX_APPLE_SEMANTIC_CONTROLS; index++) {
      store.register({ id: `apple.${index}`, label: `Item ${index}` });
    }
    assert.throws(() => store.register({ id: "apple.overflow", label: "Overflow" }), RangeError);
    assert.throws(() => store.register({ id: "apple.0", label: "Duplicate" }), /already registered/);
    store.dispose();
  });
  disposeRoot();
  resetFrames();
});

test("static first layout gets bounded admission retries and then parks", () => {
  resetFrames();
  const bridge = new SemanticsBridge();
  let reads = 0;
  const previousPocket = (globalThis as typeof globalThis & { pocket?: unknown }).pocket;
  (globalThis as typeof globalThis & { pocket?: unknown }).pocket = {
    getLayout: () => {
      reads++;
      return reads < 3 ? undefined : { x: 1, y: 2, width: 20, height: 10 };
    },
  };
  let disposeRoot!: () => void;
  let store!: ReturnType<typeof createAppleSemanticsStore>;
  createRoot((dispose) => {
    disposeRoot = dispose;
    store = createAppleSemanticsStore({ bridge });
    store.register({ id: "apple.initial", label: "Initial" })(node(9));
  });

  assert.equal(frameContinuousHints[0]?.(), true);
  runFrame();
  assert.equal(frameContinuousHints[0]?.(), true);
  runFrame();
  assert.equal(frameContinuousHints[0]?.(), true);
  runFrame();
  assert.deepEqual(snapshots(bridge), [
    {
      generation: 1,
      controls: [{
        guestId: "apple.initial",
        nativeId: 9,
        label: "Initial",
        role: "button",
        selected: false,
        disabled: false,
        enabled: true,
        rect: { x: 1, y: 2, width: 20, height: 10 },
      }],
    },
  ]);
  assert.equal(frameContinuousHints[0]?.(), false, "the bounded wake hint parks after admission");
  runFrame();
  assert.equal(reads, 4, "passive hook still measures a later delivered work frame");

  disposeRoot();
  store.dispose();
  (globalThis as typeof globalThis & { pocket?: unknown }).pocket = previousPocket;
  resetFrames();
});
