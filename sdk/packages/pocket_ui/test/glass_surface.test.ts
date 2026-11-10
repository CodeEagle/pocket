import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = mkdtempSync(join(tmpdir(), "pocket-ui-glass-surface-"));
const nodeModulesRoot = join(testRoot, "node_modules");
const solidPackageRoot = join(nodeModulesRoot, "solid-js");
const solidRuntimePath = join(import.meta.dir, "../../../.cache/pocketjs/node_modules/solid-js/dist/solid.js");
const mobileSourcePath = join(import.meta.dir, "../src/mobile.tsx");
const isolatedSourceRoot = join(testRoot, "src");
const isolatedMobileSourcePath = join(isolatedSourceRoot, "mobile.tsx");
const runnerPath = join(testRoot, "runner.ts");

mkdirSync(solidPackageRoot, { recursive: true });
mkdirSync(isolatedSourceRoot, { recursive: true });
writeFileSync(join(solidPackageRoot, "package.json"), JSON.stringify({
  name: "solid-js",
  version: "1.9.14-test",
  type: "module",
  exports: { ".": "./solid.js" },
}));
// Use the pinned runtime directly. The shim avoids Bun's Node condition
// selecting Solid's server build while keeping the production import intact.
writeFileSync(join(solidPackageRoot, "solid.js"), `export * from ${JSON.stringify(solidRuntimePath)};\n`);
// The isolated copy keeps package resolution local to this child process; the
// repository's source tree is not modified just to select the pinned runtime.
writeFileSync(isolatedMobileSourcePath, readFileSync(mobileSourcePath));
writeFileSync(join(isolatedSourceRoot, "legacy.ts"), readFileSync(join(import.meta.dir, "../src/legacy.ts")));
writeFileSync(join(isolatedSourceRoot, "route.tsx"), readFileSync(join(import.meta.dir, "../src/route.tsx")));
writeFileSync(join(isolatedSourceRoot, "ui.tsx"), `
import { createContext } from "solid-js";
export const ContourConsumedContext = createContext(() => false);
export const SafeAreaScaffold = (props: any) => ({ type: "scaffold", props });
export const SafeAreaScaffoldContext = createContext({
  hasScaffold: false,
  reservedActions: 0,
  reservedLeadingActions: 0,
  geometry: () => ({ width: 390, height: 669, safeArea: { top: 0, right: 0, bottom: 0, left: 0 }, keyboardInset: 0, reservedRegions: [] }),
  topRightContentReserve: () => 0,
  topRightReserveForBand: () => 0,
  sideReservesForBand: () => ({ left: 0, right: 0 }),
});
export const ScrollablePageContext = createContext({
  offset: () => 0,
  max: () => 0,
});
export const ScrollContourItem = (props: any) => ({ type: "scroll-contour-item", props });
export const useScrollContourReserve = () => ({ leftReserve: () => 0, nodeRef: () => {}, reserve: () => 0, reserves: () => ({ left: 0, right: 0 }), syncLayout: () => false });
`);
writeFileSync(join(isolatedSourceRoot, "responsive.ts"), readFileSync(join(import.meta.dir, "../src/responsive.ts")));
writeFileSync(join(isolatedSourceRoot, "host.ts"), readFileSync(join(import.meta.dir, "../src/host.ts")));
writeFileSync(join(isolatedSourceRoot, "display.ts"), readFileSync(join(import.meta.dir, "../src/display.ts")));
writeFileSync(join(isolatedSourceRoot, "motion.ts"), readFileSync(join(import.meta.dir, "../src/motion.ts")));
writeFileSync(join(isolatedSourceRoot, "accessibility.ts"), readFileSync(join(import.meta.dir, "../src/accessibility.ts")));

writeFileSync(runnerPath, `
import { strict as assert } from "node:assert";
import { mock } from "bun:test";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("glass-test-fragment"),
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  jsxDEV: (type, props) => ({ type, props }),
}));
mock.module("@pocketjs/framework/gesture", () => ({
  createGesture: () => ({}),
}));
mock.module("@pocketjs/framework/clock", () => ({
  simulationHz: () => 60,
  virtualNow: () => 0,
}));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: (props) => ({ type: "compositor", props }),
  Focusable: (props) => ({ type: "focusable", props }),
  Modal: (props) => ({ type: "modal", props }),
  Portal: (props) => ({ type: "portal", props }),
  Text: (props) => ({ type: "text", props }),
  View: (props) => ({ type: "view", props }),
}));
mock.module("@pocketjs/framework/solid/lifecycle", () => ({
  onFrame: () => () => {},
}));

const { createRoot, createSignal, untrack } = await import("solid-js");
const { GlassSurface } = await import(${JSON.stringify(isolatedMobileSourcePath)});

const registrations = [];
const releases = [];
const flush = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); };
const bridge = {
  registerSurface: (id, kind, payload) => {
    assert.equal(kind, "glass");
    assert.equal(typeof payload, "object", "surface bridge emits the typed descriptor object directly");
    registrations.push({ id, payload });
    return true;
  },
  releaseSurface: (id) => releases.push(id),
};
globalThis.pocket = bridge;

let firstDispose;
let setPressed;
createRoot((dispose) => {
  firstDispose = dispose;
  const [pressed, updatePressed] = createSignal(false);
  setPressed = updatePressed;
  GlassSurface({
    get shape() { return "rounded"; },
    get pressed() { return pressed(); },
  });
});
await flush();
assert.equal(registrations.length, 1, "the initial effect must register once");
assert.deepEqual(registrations[0].payload, {
  radius: 22,
  blur: 7.5,
  effect: "glass",
  opacity: 1,
  edgeIntensity: 0.015,
  rimIntensity: 0.05,
  baseIntensity: 0.01,
  tintOpacity: 0.16,
  materialTint: 0xfff2f2f7,
  materialStrength: 0,
  cornerBoost: 0.02,
  rippleEffect: 0.08,
  warp: true,
  pressed: false,
  shape: "rounded",
}, "default glass keeps the optical recipe and full alpha");
setPressed(false);
await flush();
assert.equal(registrations.length, 1, "an unchanged payload must remain deduplicated");
setPressed(true);
await flush();
assert.equal(registrations.length, 2, "a changed payload must update the existing surface");
assert.notEqual(registrations[0].payload, registrations[1].payload);
setPressed(true);
await flush();
assert.equal(registrations.length, 2, "the updated payload must also be deduplicated");
const firstId = registrations[0].id;
firstDispose();
assert.deepEqual(releases, [firstId], "dispose must release the component's own id");

let blurDispose;
let setBlurOpacity;
createRoot((dispose) => {
  blurDispose = dispose;
  const [opacity, updateOpacity] = createSignal(0);
  setBlurOpacity = updateOpacity;
  GlassSurface({
    effect: "blur",
    tintOpacity: 0,
    get opacity() { return opacity(); },
  });
});
await flush();
assert.equal(registrations.length, 3, "a blur surface must register its initial payload");
const blurInitial = registrations[2].payload;
assert.equal(blurInitial.effect, "blur");
assert.equal(blurInitial.opacity, 0);
assert.equal(blurInitial.tintOpacity, 0);
assert.equal(blurInitial.radius, 0, "a full-viewport blur must not round its corners");
assert.equal(blurInitial.edgeIntensity, 0, "a backdrop blur must not add an optical rim");
setBlurOpacity(0.5);
await flush();
assert.equal(registrations.length, 4, "opacity changes must update the registered blur in place");
assert.equal(registrations[3].payload.opacity, 0.5);
const blurId = registrations[2].id;
blurDispose();
assert.deepEqual(releases, [firstId, blurId]);

let secondDispose;
createRoot((dispose) => {
  secondDispose = dispose;
  GlassSurface({ shape: "rounded", pressed: true });
});
await flush();
assert.equal(registrations.length, 5, "a new instance must register despite a matching payload");
assert.notEqual(firstId, registrations[4].id, "surface ids must remain instance-local");
secondDispose();
assert.deepEqual(releases, [firstId, blurId, registrations[4].id]);

const attempts = [];
let failFirstAttempt = true;
const retryBridge = {
  registerSurface: (id, kind) => {
    assert.equal(kind, "glass");
    const bridge = failFirstAttempt ? "fail" : "retry";
    attempts.push({ bridge, id });
    failFirstAttempt = false;
    return bridge !== "fail";
  },
  releaseSurface: (id) => releases.push(id),
};
globalThis.pocket = retryBridge;
let retryDispose;
let setRetryPressed;
createRoot((dispose) => {
  retryDispose = dispose;
  const [pressed, updatePressed] = createSignal(false);
  setRetryPressed = updatePressed;
  GlassSurface({
    get shape() { return "pill"; },
    get pressed() { return pressed(); },
  });
});
await flush();
assert.deepEqual(attempts.map((attempt) => attempt.bridge), ["fail"]);
setRetryPressed(true);
await flush();
assert.deepEqual(attempts.map((attempt) => attempt.bridge), ["fail", "retry"], "a changed payload must retry after failure");
setRetryPressed(true);
await flush();
assert.deepEqual(attempts.map((attempt) => attempt.bridge), ["fail", "retry"], "the retried payload must then deduplicate");
retryDispose();

globalThis.pocket = bridge;
let materialDispose;
let setMaterial;
createRoot((dispose) => {
  materialDispose = dispose;
  const [material, update] = createSignal("regular");
  setMaterial = update;
  GlassSurface({
    get material() { return material(); },
    shape: "pill", radius: 36, blur: () => 3, warp: false,
  });
});
await flush();
assert.equal(registrations.at(-1).payload.radius, 36);
assert.equal(registrations.at(-1).payload.blur, 3);
assert.equal(registrations.at(-1).payload.warp, false);
setMaterial("clear");
await flush();
assert.equal(registrations.at(-1).payload.tintOpacity, 0.04);
assert.equal(registrations.at(-1).payload.rippleEffect, 0);
materialDispose();

const { AccessibilityPreferencesContext, DEFAULT_ACCESSIBILITY_PREFERENCES } = await import(${JSON.stringify(join(isolatedSourceRoot, "accessibility.ts"))});
let preferencesDispose;
let updatePreferences;
createRoot((dispose) => {
  preferencesDispose = dispose;
  const [preferences, update] = createSignal(DEFAULT_ACCESSIBILITY_PREFERENCES);
  updatePreferences = update;
  AccessibilityPreferencesContext.Provider({
    value: preferences,
    get children() { return untrack(() => GlassSurface({ shape: "pill" })); },
  });
});
await flush();
const preferenceSurface = registrations.at(-1).id;
const registeredBeforeReduction = registrations.length;
updatePreferences({ ...DEFAULT_ACCESSIBILITY_PREFERENCES, reduceTransparency: true });
await flush();
assert.equal(registrations.length, registeredBeforeReduction, "reduced transparency must not register another GPU surface");
assert.equal(releases.at(-1), preferenceSurface, "reduced transparency releases the optical provider");
updatePreferences(DEFAULT_ACCESSIBILITY_PREFERENCES);
await flush();
assert.equal(registrations.length, registeredBeforeReduction + 1);
assert.equal(registrations.at(-1).id, preferenceSurface, "restoring material reuses the component's own identity");
preferencesDispose();

console.log(JSON.stringify({ registrations: registrations.length, attempts: attempts.length, releases: releases.length }));
`);

test("GlassSurface uses the real pinned Solid runtime for registration lifecycle", () => {
  try {
    const result = spawnSync("bun", [runnerPath], {
      cwd: join(import.meta.dir, "../../../../"),
      env: { ...process.env, NODE_PATH: nodeModulesRoot },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    assert.deepEqual(JSON.parse(output ?? "{}"), { registrations: 9, attempts: 2, releases: 7 });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
