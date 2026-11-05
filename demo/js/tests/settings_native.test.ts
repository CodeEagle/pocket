import { strict as assert } from "node:assert";
import { backIconPoint } from "./navigation_geometry.ts";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  textOp,
  textOps,
  type DrawOp,
  type Frame,
  type JsonObject,
} from "./native_session.ts";

const width = 390;
const height = 844;

function rootColor(frame: Frame): number | undefined {
  const frameWidth = frame.width ?? width;
  const frameHeight = frame.height ?? height;
  return (frame.ops ?? []).find((op) =>
    op.type === "rect" && op.x === 0 && op.y === 0 && op.w === frameWidth && op.h === frameHeight,
  )?.color;
}

function rectContains(rect: DrawOp, point: { x: number; y: number }): boolean {
  return rect.type === "rect" &&
    typeof rect.x === "number" && typeof rect.y === "number" &&
    typeof rect.w === "number" && typeof rect.h === "number" &&
    point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

function buttonRect(frame: Frame, label: string): DrawOp {
  const point = center(textOp(frame, label), label);
  // Rounded native shapes are painted as atlas corners plus center strips, so
  // no single draw op necessarily covers the text. Reconstruct the extent
  // from the nearby rect strips instead of depending on one implementation
  // detail of the compositor.
  const candidates = (frame.ops ?? [])
    .filter((op) => op.type === "rect" && typeof op.x === "number" && typeof op.y === "number" &&
      typeof op.w === "number" && typeof op.h === "number" && typeof op.color === "number")
    .filter((op) => (op.w ?? 0) <= 330 && (op.h ?? 0) <= 60)
    .filter((op) => {
      const dx = Math.max((op.x ?? 0) - point.x, point.x - ((op.x ?? 0) + (op.w ?? 0)), 0);
      const dy = Math.max((op.y ?? 0) - point.y, point.y - ((op.y ?? 0) + (op.h ?? 0)), 0);
      return dx <= 24 && dy <= 28;
    });
  assert.ok(candidates.length > 0, "frame is missing a button shape for " + label);
  const x = Math.min(...candidates.map((op) => op.x!));
  const y = Math.min(...candidates.map((op) => op.y!));
  const right = Math.max(...candidates.map((op) => op.x! + op.w!));
  const bottom = Math.max(...candidates.map((op) => op.y! + op.h!));
  return { type: "rect", color: candidates[0]!.color, x, y, w: right - x, h: bottom - y };
}

function accentControlRect(frame: Frame, label: string): DrawOp {
  const point = center(textOp(frame, label), label);
  const candidates = (frame.ops ?? [])
    .filter((op) => rectContains(op, point))
    .filter((op) => (op.h ?? 0) >= 2 && (op.h ?? 0) <= 40 && (op.w ?? 0) <= 180)
    .sort((a, b) => (a.w! * a.h!) - (b.w! * b.h!));
  assert.ok(candidates.length > 0, "frame is missing an accent control rect for " + label);
  return candidates[0]!;
}

function navAccentColor(frame: Frame, label: string): number | undefined {
  const frameHeight = frame.height ?? height;
  const labelOp = textOp(frame, label, (op) => (op.y ?? 0) > frameHeight - 90);
  const point = center(labelOp, label);
  const colors = (frame.ops ?? [])
    .filter((op) => op.type === "rect" && typeof op.color === "number")
    .filter((op) => (op.y ?? 0) >= frameHeight - 100 && (op.y ?? 0) <= frameHeight)
    .filter((op) => (op.x ?? 0) <= point.x + 14 && (op.x ?? 0) + (op.w ?? 0) >= point.x - 14)
    .filter((op) => (op.w ?? 0) <= 28 && (op.h ?? 0) <= 28)
    .map((op) => op.color!);
  if (colors.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const color of colors) counts.set(color, (counts.get(color) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

async function run(): Promise<void> {
  const artifacts = readNativeArtifacts("POCKET_SETTINGS");
  const first = new NativeSession(artifacts, { width, height, deadlineMs: 25_000 });
  let firstClosed = false;
  let restored: NativeSession | undefined;
  try {
  let frame = await first.boot();

  const navBottom = (op: DrawOp): boolean => (op.y ?? 0) > (frame.height ?? height) - 90;
  textOp(frame, "Settings", navBottom);
  textOp(frame, "Home", navBottom);
  textOp(frame, "UI", navBottom);
  textOp(frame, "Host", navBottom);

  frame = await first.tap("Settings", frame, navBottom);
  frame = await first.settle(frame);
  textOp(frame, "Appearance");
  textOp(frame, "Theme");
  textOp(frame, "Dark");
  textOp(frame, "Accent color");
  textOp(frame, "Interface density");

  const lightRoot = rootColor(frame);
  const blueNav = navAccentColor(frame, "Settings");
  const blueAccentRect = accentControlRect(frame, "Blue");
  assert.equal(typeof lightRoot, "number", "Settings must paint a root canvas rect");
  assert.equal(typeof blueNav, "number", "Settings nav icon must paint a measurable rect");
  assert.equal(typeof blueAccentRect.color, "number", "Blue accent control must paint a measurable rect");

  frame = await first.tap("Dark", frame);
  frame = await first.settle(frame, 8);
  const darkRoot = rootColor(frame);
  assert.notEqual(darkRoot, lightRoot, "Dark selection must change the painted root canvas color");
  assert.equal(darkRoot, 0xff0e1728, "Dark selection must use the shared dark canvas token");

  frame = await first.tap("Violet", frame);
  frame = await first.settle(frame, 8);
  const violetNav = navAccentColor(frame, "Settings");
  const violetAccentRect = accentControlRect(frame, "Violet");
  assert.notEqual(violetNav, blueNav, "Violet must change the active Settings navigation rect color");
  assert.notEqual(violetAccentRect.color, blueAccentRect.color, "Violet must change the accent control rect color");

  frame = await first.tap("Teal", frame);
  frame = await first.settle(frame, 8);
  const tealNav = navAccentColor(frame, "Settings");
  const tealAccentRect = accentControlRect(frame, "Teal");
  assert.notEqual(tealNav, violetNav, "Teal must change the active Settings navigation rect color");
  assert.notEqual(tealAccentRect.color, violetAccentRect.color, "Teal must change the accent control rect color");

  frame = await first.tap("Comfortable", frame);
  frame = await first.settle(frame, 4);
  // Reset is below the initial viewport. Reveal it with the real
  // ScrollablePage pointer gesture before measuring the density-dependent
  // outlined button shape.
  frame = await first.drag({ x: 180, y: 600 }, { x: 180, y: 450 }, 1);
  frame = await first.settle(frame, 8);
  textOp(frame, "Reset appearance");
  const comfortableHeight = buttonRect(frame, "Reset appearance").h!;
  frame = await first.drag({ x: 180, y: 300 }, { x: 180, y: 600 }, 1);
  frame = await first.settle(frame, 8);
  textOp(frame, "Compact");
  frame = await first.tap("Compact", frame);
  frame = await first.settle(frame, 4);
  frame = await first.drag({ x: 180, y: 600 }, { x: 180, y: 450 }, 1);
  frame = await first.settle(frame, 8);
  textOp(frame, "Reset appearance");
  const compactHeight = buttonRect(frame, "Reset appearance").h!;
  assert.ok(comfortableHeight > compactHeight, `Comfortable control height ${comfortableHeight} must exceed Compact ${compactHeight}`);
  assert.ok(comfortableHeight >= 44, "Comfortable density must keep touch-sized controls");
  // Rounded-patch raster bounds include one antialias row, so the 36px
  // compact token measures at most 38px in the emitted rect union.
  assert.ok(compactHeight <= 38, `Compact density must use desktop-sized controls (measured ${compactHeight})`);

  const savedAppearance = clone(first.storage.appearance) as JsonObject | undefined;
  const persistedStorage = clone(first.storage) as Record<string, any>;
  assert.deepEqual(savedAppearance, { version: 1, dark: true, accent: "teal", density: "desktop" }, "settings changes must be persisted through platform.storage.set");
  assert.ok(first.storageGets.some((params) => params.key === "appearance"), "boot must request platform.storage.get for appearance");
  assert.ok(first.storageSets.some((params) => params.key === "appearance"), "user settings must request platform.storage.set for appearance");

  frame = await first.tap("Reset appearance", frame);
  frame = await first.settle(frame, 12);
  assert.match(textOf(frame), /Reset appearance\?/);
  textOp(frame, "Reset");
  frame = await first.tap("Reset", frame);
  frame = await first.settle(frame, 12);
  assert.equal(rootColor(frame), 0xfff5f6fa, "Reset must restore the light root canvas");
  frame = await first.drag({ x: 180, y: 300 }, { x: 180, y: 600 }, 1);
  frame = await first.settle(frame, 8);
  textOp(frame, "Light");
  assert.deepEqual(first.storage.appearance, { version: 1, dark: false, accent: "blue", density: "auto" }, "Reset must persist the default appearance");

  // Reach the secondary Mobile UI through the painted Home card. The root
  // bottom nav is intentionally not used as a state shortcut here.
  frame = await first.tap("Home", frame, navBottom);
  frame = await first.settle(frame);
  frame = await first.tap("Mobile UI", frame);
  frame = await first.settle(frame);
  textOp(frame, "Mobile UI");
  textOp(frame, "Overview");
  textOp(frame, "Feedback");
  textOp(frame, "Controls");
  textOp(frame, "Data");
  const backPoint = backIconPoint(frame);
  assert.equal(textOps(frame, "Home").some((op) => (op.y ?? 0) > (frame.height ?? height) - 90), false, "secondary Mobile UI must hide the root bottom navigation");
  assert.equal(textOps(frame, "Settings").some((op) => (op.y ?? 0) > (frame.height ?? height) - 90), false, "secondary Mobile UI must hide the Settings nav tab");

  frame = await first.tapPoint(backPoint);
  frame = await first.settle(frame);
  assert.match(textOf(frame), /Made to feel native\./, "Mobile UI Back must return to Home");
  textOp(frame, "Settings", navBottom);
  await first.quit();
  firstClosed = true;

  // A fresh native guest receives the saved value only through the storage
  // response; it is not primed with a demo state event. Reuse the host-side
  // persisted map captured after set and before the later reset interaction.
  restored = new NativeSession(artifacts, { width, height, storage: persistedStorage, deadlineMs: 25_000 });
  frame = await restored.boot();
  assert.ok(restored.storageGets.some((params) => params.key === "appearance"), "fresh guest must read persisted appearance");
  assert.equal(rootColor(frame), 0xff0e1728, "fresh guest must restore the persisted dark canvas");
  frame = await restored.tap("Settings", frame, (op) => (op.y ?? 0) > (frame.height ?? height) - 90);
  frame = await restored.settle(frame);
  assert.equal(navAccentColor(frame, "Settings"), tealNav, "fresh guest must restore the persisted Teal navigation accent");
  frame = await restored.drag({ x: 180, y: 600 }, { x: 180, y: 450 }, 1);
  frame = await restored.settle(frame, 8);
  textOp(frame, "Reset appearance");
  assert.equal(buttonRect(frame, "Reset appearance").h, compactHeight, "fresh guest must restore Compact density");
  await restored.quit();
  restored = undefined;

  console.log(
    `settings_native: native Settings/theme/accent/density/reset/secondary-nav/persistence regression passed ` +
    `(bytecode=${artifacts.bytecodePath})`,
  );
  } finally {
    if (!firstClosed) first.forceKill();
    restored?.forceKill();
  }
}

await run();

