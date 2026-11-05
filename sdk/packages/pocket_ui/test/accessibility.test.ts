import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import { createHostBridge } from "../src/host.ts";

let activeCleanups: Array<() => void> | undefined;
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
  createSignal<T>(initial: T): [() => T, (next: T) => void] {
    let value = initial;
    return [() => value, (next: T) => { value = next; }];
  },
  onMount(callback: () => void): void { callback(); },
  onCleanup(callback: () => void): void { activeCleanups?.push(callback); },
  useContext<T>(context: { value: T }): T { return context.value; },
  createRoot<T>(callback: (dispose: () => void) => T): T {
    const previous = activeCleanups;
    const cleanups: Array<() => void> = [];
    activeCleanups = cleanups;
    let disposed = false;
    const result = callback(() => {
      if (disposed) return;
      disposed = true;
      for (const cleanup of [...cleanups].reverse()) cleanup();
    });
    activeCleanups = previous;
    return result;
  },
}));

const { createRoot } = await import("solid-js");
const {
  ACCESSIBILITY_PREFERENCES_EVENT,
  createAccessibilityPreferences,
  DEFAULT_ACCESSIBILITY_PREFERENCES,
  parseAccessibilityPreferences,
} = await import("../src/accessibility.ts");

function event(payload: Record<string, unknown>): Record<string, unknown> {
  return { type: "event", name: ACCESSIBILITY_PREFERENCES_EVENT, payload };
}

test("accessibility preference events update one signal and replay the latest fact", async () => {
  const host = createHostBridge(() => true);
  let disposeFirst!: () => void;
  let first!: () => ReturnType<typeof parseAccessibilityPreferences>;
  createRoot((dispose) => {
    disposeFirst = dispose;
    first = createAccessibilityPreferences({ bridge: host });
  });
  await Promise.resolve();

  host.handle(event({
    reduceMotion: true,
    increaseContrast: true,
    textScale: 1.25,
    accessibleNavigation: true,
    reduceTransparency: null,
  }));
  assert.deepEqual(first(), {
    reduceMotion: true,
    increaseContrast: true,
    textScale: 1.25,
    accessibleNavigation: true,
    reduceTransparency: null,
  });

  let disposeSecond!: () => void;
  let second!: () => ReturnType<typeof parseAccessibilityPreferences>;
  createRoot((dispose) => {
    disposeSecond = dispose;
    second = createAccessibilityPreferences({ bridge: host });
  });
  await Promise.resolve();
  assert.deepEqual(second(), first(), "a later guest must replay the bridge's latest snapshot");

  disposeSecond();
  disposeFirst();
  host.dispose();
});

test("malformed or unavailable host fields keep bounded defaults and explicit unknown transparency", () => {
  assert.deepEqual(parseAccessibilityPreferences(undefined), DEFAULT_ACCESSIBILITY_PREFERENCES);
  assert.deepEqual(parseAccessibilityPreferences({
    reduceMotion: "yes",
    highContrast: true,
    textScale: 99,
    accessibleNavigation: 1,
    reduceTransparency: "unknown",
  }), {
    reduceMotion: false,
    increaseContrast: true,
    textScale: 8,
    accessibleNavigation: false,
    reduceTransparency: null,
  });
});
