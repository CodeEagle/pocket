import { test, expect, mock } from "bun:test";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("wrap-text-test-fragment"),
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
}));
mock.module("solid-js", () => ({
  For: () => undefined,
  Show: () => undefined,
  children: (value: unknown) => value,
  createContext: (value?: unknown) => ({ value }),
  createEffect: () => undefined,
  createMemo: (value: () => unknown) => value,
  createSignal: (value: unknown) => [() => value, () => undefined],
  onCleanup: () => undefined,
  onMount: () => undefined,
  untrack: (value: () => unknown) => value(),
  useContext: () => undefined,
}));
mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({}) }));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: () => undefined,
  Focusable: () => undefined,
  Modal: () => undefined,
  Portal: () => undefined,
  Text: () => undefined,
  View: () => undefined,
}));
mock.module("@pocketjs/framework/solid/lifecycle", () => ({
  onFrame: () => undefined,
}));
mock.module("@pocketjs/framework/clock", () => ({
  after: () => () => {},
  simulationHz: () => 60,
  virtualNow: () => 0,
}));
mock.module("../src/legacy.ts", () => ({
  buildLiquidGlassRecipe: () => ({}),
}));
mock.module("../src/ui.tsx", () => ({
  ContourConsumedContext: {},
  SafeAreaScaffold: () => undefined,
  SafeAreaScaffoldContext: {},
  ScrollContourItem: () => undefined,
  ScrollablePageContext: {},
  useScrollContourReserve: () => undefined,
}));
mock.module("../src/route.tsx", () => ({ useRouteActive: () => true }));
mock.module("../src/motion.ts", () => ({
  MOBILE_MOTION: {
    control: 240,
    overlay: 260,
    presentation: 320,
    selection: 220,
    state: 250,
  },
  motionEaseInOut: (value: number) => value,
  motionEaseOut: (value: number) => value,
  stepMotionSpring: () => 0,
}));
mock.module("../src/accessibility.ts", () => ({
  useAccessibilityPreferences: () => ({}),
}));

const { wrapTextLines } = await import("../src/mobile.tsx");

type WrapBridge = (text: string, fontSlot: number, maxWidth: number) => number[];

function setWrapBridge(wrapText: WrapBridge | undefined): () => void {
  const global = globalThis as typeof globalThis & {
    ui?: { wrapText?: WrapBridge };
  };
  const previous = global.ui;
  if (wrapText) global.ui = { wrapText };
  else delete global.ui;
  return () => {
    if (previous) global.ui = previous;
    else delete global.ui;
  };
}

test("wrapTextLines measures each explicit paragraph and preserves blank breaks", () => {
  const calls: string[] = [];
  const restore = setWrapBridge((text, fontSlot, maxWidth) => {
    calls.push(`${fontSlot}/${maxWidth}/${text}`);
    return text === "abcdefghij" ? [4, 8] : [5, 10];
  });
  try {
    expect(
      wrapTextLines("abcdefghij\n\nklmnopqrst", 42, 180, 2),
    ).toBe("abcd\nefgh\nij\n\nklmno\npqrst");
    expect(calls).toEqual([
      "2/180/abcdefghij",
      "2/180/klmnopqrst",
    ]);
  } finally {
    restore();
  }
});

test("wrapTextLines retains authored short lines and wraps long Chinese paragraphs", () => {
  const calls: string[] = [];
  const restore = setWrapBridge((text) => {
    calls.push(text);
    return text.startsWith("第二段") ? [3, 6, 9] : [];
  });
  try {
    expect(
      wrapTextLines("一行短句\n\n第二段文字很长需要换行\n末行", 42, 240, 2),
    ).toBe("一行短句\n\n第二段\n文字很\n长需要\n换行\n末行");
    expect(calls).toEqual(["一行短句", "第二段文字很长需要换行", "末行"]);
  } finally {
    restore();
  }
});

test("wrapTextLines fallback wraps each paragraph without collapsing explicit spacing", () => {
  const restore = setWrapBridge(undefined);
  try {
    const wrapped = wrapTextLines(
      "Short first line\n\nLong Chinese passage without spaces 中文测试\nLast line",
      10,
      0,
    );
    expect(wrapped.split("\n").filter((line) => line.length === 0)).toHaveLength(1);
    expect(wrapped.startsWith("Short\nfirst line\n\n")).toBe(true);
    expect(wrapped.endsWith("\nLast line")).toBe(true);
    expect(wrapped.split("\n").every((line) => line.length <= 10)).toBe(true);
  } finally {
    restore();
  }
});
