import { test as bunTest } from "bun:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TRANSITION_MODES,
  buildLiquidGlassRecipe,
  computeTransitionDescriptor,
} from "@pocket/ui/legacy";
import {
  availableDisplayPanes,
  avoidDisplayOcclusions,
  bottomBarInsets,
  DISPLAY_UI_SAFETY_GAP,
  deriveResponsiveLayout,
  displayPane,
  pageInsets,
  parseDisplayGeometry,
  reservedInsets,
} from "@pocket/ui/responsive";
import { initialDemoState, reduceDemoState } from "../state.ts";

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    bunTest(name, fn);
  } catch {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch((err) => {
        console.error(`Failed test: ${name}`, err);
        process.exit(1);
      });
    }
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("transition modes and shared glass recipe library", () => {
  assert.deepEqual(TRANSITION_MODES, [
    "IOS_SPRING_PARALLAX",
    "SHARED_AXIS_Z",
    "LIQUID_GLASS_MORPH",
    "PORTAL_EXPAND",
  ]);

  for (const mode of TRANSITION_MODES) {
    const start = computeTransitionDescriptor(mode, 0, false, 360);
    const end = computeTransitionDescriptor(mode, 1, false, 360);
    const reverseStart = computeTransitionDescriptor(mode, 0, true, 360);
    assert.equal(start.easedT, 0);
    assert.equal(end.easedT, 1);
    assert.equal(start.inScale, 1);
    assert.equal(end.inTx, 0);
    assert.equal(reverseStart.outTx, 0);
    const clamped = computeTransitionDescriptor(mode, 2, false, 360);
    assert.equal(clamped.easedT, 1);
  }

  const rounded = buildLiquidGlassRecipe({ shape: "rounded", tintOpacity: 0.3 });
  const pill = buildLiquidGlassRecipe({ shape: "pill", focused: true, nested: true, warp: true });
  assert.equal(rounded.shape, "rounded");
  assert.equal(pill.shape, "pill");
  assert.ok(pill.blurSigma > 0);
  assert.notEqual(pill.blurSigma, rounded.blurSigma);
  assert.ok(pill.shadowBlur > rounded.shadowBlur);
  assert.ok(pill.sample.totalRefraction !== 0);
  assert.equal(rounded.bgStops.length, rounded.bgColors.length);
  assert.ok(rounded.tintOpacity <= 0.65);
});

test("display geometry and duo responsive layouts", () => {
  const duoGeometryFixture = JSON.parse(
    readFileSync(join(root, "tests/fixtures/duo_geometry.json"), "utf8"),
  ) as { source?: string; capturedAt?: string; samples?: unknown[] };
  const duoGeometrySamples = duoGeometryFixture.samples ?? [];
  assert.match(duoGeometryFixture.source ?? "", /DeviceHub/);
  assert.equal(duoGeometryFixture.capturedAt, "2026-11-02");

  let state = initialDemoState();
  state = reduceDemoState(state, { type: "navigate", route: "mobile" });
  state = reduceDemoState(state, { type: "navigate", route: "transitions" });
  assert.deepEqual(state.routeStack, ["home", "mobile", "transitions"]);
  state = reduceDemoState(state, { type: "popRoute" });
  assert.equal(state.route, "mobile");
  const duoGeometry = parseDisplayGeometry({
    width: 390,
    height: 669,
    safeArea: { top: 4, right: 0, bottom: 8, left: 0 },
    reservedRegions: [{
      id: "hinge",
      kind: "division",
      frame: { left: 190, top: 0, width: 10, height: 669 },
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      active: true,
    }],
  });
  const duoLayout = deriveResponsiveLayout(duoGeometry);
  assert.equal(duoLayout.mode, "wide");
  assert.equal(duoLayout.navigation, "rail");
  assert.equal(duoLayout.railSide, "right");
  assert.equal(duoGeometrySamples.length, 3);
  const realDuoWide = parseDisplayGeometry(duoGeometrySamples[0]);
  const realDuoFolded = parseDisplayGeometry(duoGeometrySamples[1]);
  const realDuoClosed = parseDisplayGeometry(duoGeometrySamples[2]);
  const realDuoWideInsets = reservedInsets(realDuoWide);
  assert.equal(realDuoWideInsets.top, 0, "central division must not consume the full top edge");
  assert.equal(realDuoWideInsets.bottom, 34);
  assert.equal(realDuoWideInsets.right, 84);
  assert.equal(pageInsets(realDuoWide).right, 0, "open Duo corner projection is released for Page body");
  assert.equal(deriveResponsiveLayout(realDuoWide).mode, "wide");
  assert.equal(deriveResponsiveLayout(realDuoWide).railSide, "right");
  assert.equal(realDuoWide.reservedRegions.filter((region) => region.kind === "division").length, 1);
  const widePanes = availableDisplayPanes(realDuoWide);
  assert.equal(widePanes.length, 2);
  assert.equal(widePanes[0]?.width, 455.5);
  assert.equal(displayPane(realDuoWide, "right").left, 495.5);
  assert.equal(deriveResponsiveLayout(realDuoFolded).mode, "wide");
  assert.equal(reservedInsets(realDuoFolded).top, 0, "small top-right occlusion must not become global top padding");
  assert.equal(reservedInsets(realDuoFolded).right, 84);
  assert.equal(pageInsets(realDuoFolded).right, 0, "inactive open Duo division still identifies Page topology");
  assert.equal(deriveResponsiveLayout(realDuoClosed).mode, "narrow");
  assert.equal(deriveResponsiveLayout(realDuoClosed).navigation, "bottom");
  assert.equal(reservedInsets(realDuoClosed).right, 84);
  assert.equal(pageInsets(realDuoClosed).right, 84, "folded Duo keeps the global right safe area");
  assert.deepEqual(bottomBarInsets(realDuoWide), { top: 0, right: 0, bottom: 34, left: 0 });
  assert.deepEqual(bottomBarInsets(realDuoFolded), { top: 0, right: 0, bottom: 34, left: 0 });
  assert.deepEqual(bottomBarInsets(realDuoClosed), { top: 0, right: 0, bottom: 34, left: 0 });

  const cornerTarget = { left: realDuoWide.width - 52, top: 8, width: 44, height: 44 };
  const cornerWithoutGlobalRight = parseDisplayGeometry({
    ...duoGeometrySamples[0] as Record<string, unknown>,
    safeArea: { ...realDuoWide.safeArea, right: 0 },
  });
  const localCorner = avoidDisplayOcclusions(cornerWithoutGlobalRight, cornerTarget, { prefer: "horizontal" });
  assert.equal(localCorner.offsetX, -76, "right=0 open Duo must move only the intersecting close target");
  assert.equal(localCorner.offsetY, 0);
  assert.equal(avoidDisplayOcclusions(cornerWithoutGlobalRight, { left: 0, top: 200, width: 951, height: 400 }).offsetX, 0, "open Duo body remains full width");
  assert.equal(avoidDisplayOcclusions(realDuoWide, { left: 455, top: 8, width: 44, height: 44 }).offsetX, 0, "division is not an occlusion");
  const openClose = avoidDisplayOcclusions(realDuoWide, { left: realDuoWide.width - 52 - realDuoWide.safeArea.right, top: 8, width: 44, height: 44 }, { prefer: "horizontal" });
  const openToolbar = avoidDisplayOcclusions(realDuoWide, { left: realDuoWide.width - 60, top: 8, width: 60, height: 56 }, { prefer: "horizontal" });
  const closeLeft = realDuoWide.width - 52 - realDuoWide.safeArea.right + openClose.offsetX;
  const toolbarContentRight = realDuoWide.width - (60 - openToolbar.offsetX + DISPLAY_UI_SAFETY_GAP);
  assert.equal(openClose.offsetY, 0, "open close remains at the top");
  assert.ok(toolbarContentRight + 1.1 < closeLeft, `open toolbar/header must stay left of close target: ${toolbarContentRight} >= ${closeLeft}`);
  const rotatedDuo = parseDisplayGeometry(duoGeometrySamples[2], realDuoWide);
  assert.equal(pageInsets(rotatedDuo).right, 84, "rotation to folded geometry restores global right safe area");
  assert.equal(avoidDisplayOcclusions(rotatedDuo, { left: 330, top: 8, width: 44, height: 44 }).offsetX, 0, "folded Duo keeps the native right safe area once");

  const transientKeyboardGeometry = parseDisplayGeometry({
    width: 951,
    height: 669,
    safeArea: { top: 0, right: 0, bottom: 34, left: 0 },
    reservedRegions: [],
  });
  assert.equal(deriveResponsiveLayout(transientKeyboardGeometry).mode, "wide");
  assert.equal(deriveResponsiveLayout(transientKeyboardGeometry).railSide, "right");
});

test("partial display geometry updates and clears", () => {
  let state = initialDemoState();
  const completeGeometry = parseDisplayGeometry({
    width: 951,
    height: 669,
    safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
    keyboardInset: 28,
    reservedRegions: [{
      id: "hinge",
      kind: "division",
      frame: { left: 455.5, top: 0, width: 40, height: 669 },
      margins: { top: 0, right: 20, bottom: 0, left: 20 },
      active: true,
    }],
  });
  const sameSizePartial = parseDisplayGeometry({ width: 951, height: 669 }, completeGeometry);
  assert.deepEqual(sameSizePartial.safeArea, completeGeometry.safeArea);
  assert.equal(sameSizePartial.keyboardInset, 28);
  assert.equal(sameSizePartial.reservedRegions.length, 1);
  for (const height of [600, 540, 480]) {
    const heightOnly = parseDisplayGeometry({ width: 951, height }, completeGeometry);
    assert.equal(deriveResponsiveLayout(heightOnly).railSide, "right");
    assert.equal(heightOnly.reservedRegions.length, 1);
    for (const pane of availableDisplayPanes(heightOnly)) {
      assert.ok(pane.left >= 0 && pane.top >= 0);
      assert.ok(pane.left + pane.width <= heightOnly.width);
      assert.ok(pane.top + pane.height <= heightOnly.height);
    }
  }
  const leftDivisionGeometry = parseDisplayGeometry({
    ...completeGeometry,
    reservedRegions: [{
      id: "hinge-left",
      kind: "division",
      frame: { left: 700, top: 0, width: 40, height: 669 },
      margins: { top: 0, right: 20, bottom: 0, left: 20 },
      active: true,
    }],
  });
  for (const height of [600, 540, 480]) {
    const heightOnly = parseDisplayGeometry({ width: 951, height }, leftDivisionGeometry);
    assert.equal(deriveResponsiveLayout(heightOnly).railSide, "left");
    assert.equal(heightOnly.reservedRegions.length, 1);
    for (const pane of availableDisplayPanes(heightOnly)) {
      assert.ok(pane.left >= 0 && pane.top >= 0);
      assert.ok(pane.left + pane.width <= heightOnly.width);
      assert.ok(pane.top + pane.height <= heightOnly.height);
    }
  }
  const resizedPartial = parseDisplayGeometry({ width: 466, height: 678 }, completeGeometry);
  assert.deepEqual(resizedPartial.safeArea, completeGeometry.safeArea);
  assert.equal(resizedPartial.reservedRegions.length, 0);
  const explicitClear = parseDisplayGeometry({
    width: 951,
    height: 669,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    keyboardInset: 0,
    reservedRegions: [],
  }, completeGeometry);
  assert.deepEqual(explicitClear.safeArea, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(explicitClear.keyboardInset, 0);
  assert.equal(explicitClear.reservedRegions.length, 0);
  const occlusionGeometry = parseDisplayGeometry({
    width: 390,
    height: 669,
    reservedRegions: [{
      id: "camera-cutout",
      kind: "occlusion",
      frame: { left: 0, top: 0, width: 390, height: 24 },
      margins: { top: 4, right: 0, bottom: 0, left: 0 },
      active: true,
    }],
  });
  assert.equal(reservedInsets(occlusionGeometry).top, 28);
  state = reduceDemoState(state, { type: "setTransitionMode", mode: "LIQUID_GLASS_MORPH" });
  assert.equal(state.transitionMode, "LIQUID_GLASS_MORPH");
});

test("source-backed mobile controls, transitions, and contracts", () => {
  const sdkRoot = join(root, "../../sdk");
  const appSource = readFileSync(join(root, "app.tsx"), "utf8");
  const mobileSource = readFileSync(join(sdkRoot, "packages/pocket_ui/src/mobile.tsx"), "utf8");
  const pageSource = readFileSync(join(root, "mobile-pages.tsx"), "utf8");
  const uiSource = readFileSync(join(sdkRoot, "packages/pocket_ui/src/ui.tsx"), "utf8");
  const responsiveSource = readFileSync(join(sdkRoot, "packages/pocket_ui/src/responsive.ts"), "utf8");
  const displaySource = readFileSync(join(sdkRoot, "packages/pocket_ui/src/display.ts"), "utf8");
  const packageSource = readFileSync(join(sdkRoot, "packages/pocket_ui/src/index.ts"), "utf8");
  const legacySource = readFileSync(join(sdkRoot, "packages/pocket_ui/src/legacy.ts"), "utf8");
  const docsSource = readFileSync(join(sdkRoot, "docs/UI_REUSE.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { permissions?: { optional?: string[] } };

  for (const label of ["Mobile UI", "Transitions", "Hardware"]) assert.match(appSource, new RegExp(label));
  assert.doesNotMatch(appSource, /LiquidGlassPage|route === "glass"|route: "glass"|label="Liquid Glass"/);
  assert.doesNotMatch(pageSource, /LiquidGlassPage|Liquid Glass|buildLiquidGlassRecipe|glassShapes|GlassSurface/);
  for (const label of ["MobileAppBar", "MobileCard", "MobileListTile", "MobileSwitch", "MobileStepper", "MobileDialog", "InputField", "GlassSurface", "FilledButton", "ElevatedButton", "hardware.camera.preview.start", "hardware.weather.current"]) {
    assert.match(pageSource + mobileSource + uiSource, new RegExp(label.replace(".", "\\.")));
  }
  assert.match(mobileSource, /registerSurface/);
  assert.match(mobileSource, /blur: current\.blurSigma/);
  assert.match(mobileSource, /CompositorSurface/);
  assert.match(mobileSource, /releaseSurface/);
  assert.match(mobileSource, /<SafeAreaScaffold/);
  assert.doesNotMatch(mobileSource, /"flex-1 w-full " \+ props\.class/);
  assert.match(pageSource, /computeTransitionDescriptor/);
  assert.match(pageSource, /TRANSITION_MODES\.filter/);
  assert.match(pageSource, /LIQUID_GLASS_MORPH/);
  assert.match(appSource, /routeTransitionDuration/);
  assert.match(appSource, /setRouteTransition/);
  assert.match(appSource, /onFrame\(\(\) =>/);
  assert.match(displaySource, /ui\?: \{ __viewport/);
  assert.match(appSource, /wideLayout/);
  assert.match(appSource, /availableDisplayPanes/);
  assert.match(appSource, /contentPaneStyle/);
  assert.doesNotMatch(appSource, /width: wide\(\) \? 640/);
  assert.doesNotMatch(appSource, /badge="JS-owned"/);
  assert.match(appSource, /contentWidth/);
  assert.match(appSource, /mobileDark/);
  assert.match(appSource, /flex-1 flex-col h-full overflow-hidden/);
  assert.match(uiSource, /export const TabBar = NavigationBar/);
  assert.match(appSource, /createDisplayGeometry/);
  assert.match(displaySource, /display\.viewport/);
  assert.match(displaySource, /onCleanup/);
  assert.match(displaySource, /previous\?\.\(line\)|forwardHostPacket\(previous,\s*packet\)/);
  assert.match(displaySource, /parseDisplayGeometry/);
  assert.match(mobileSource, /PlatformTextureSurface/);
  assert.match(mobileSource, /radius\?: number/);
  assert.match(mobileSource, /Number\.isFinite/);
  assert.match(mobileSource, /radius: platformTextureRadius\(props\.radius\)/);
  assert.match(mobileSource, /registerSurface\(id, "platformTexture", payload\(\)\) !== false/);
  assert.match(mobileSource, /<Show when=\{typeof props\.open === "function"/);
  assert.match(mobileSource, /focusable=\{!props\.disabled\}/);
  assert.match(pageSource, /hardware\.camera\.preview\.start/);
  assert.match(pageSource, /previewReady/);
  assert.match(pageSource, /hardware\.photos\.delete/);
  assert.match(pageSource, /hardware\.weather\.current/);
  assert.match(appSource, /glassRenderer/);
  assert.match(responsiveSource, /reservedRegions/);
  assert.match(responsiveSource, /deriveResponsiveLayout/);
  assert.match(responsiveSource, /availableDisplayPanes/);
  assert.match(responsiveSource, /displayPane/);
  assert.match(responsiveSource, /division/);
  assert.match(responsiveSource, /occlusion/);
  assert.match(packageSource, /export \* from "\.\/display\.ts"/);
  assert.match(packageSource, /export \* from "\.\/ui\.tsx"/);
  assert.match(packageSource, /export \* from "\.\/responsive\.ts"/);
  assert.match(legacySource, /computeTransitionDescriptor/);
  assert.doesNotMatch(packageSource + uiSource + mobileSource + legacySource, /guest\//);
  assert.match(docsSource, /pocket_syslib_flutter_ui\.js/);
  assert.match(docsSource, /does not call that[\s\S]*fallback native glass/);
  assert.ok(manifest.permissions?.optional?.includes("hardware.camera"));
  assert.ok(manifest.permissions?.optional?.includes("hardware.network"));
});
