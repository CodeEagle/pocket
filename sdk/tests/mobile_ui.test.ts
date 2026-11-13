import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transformFile } from "../.cache/pocketjs/framework/compiler/jsx-plugin.ts";

test("GlassSurface updates Surface style.radius dynamically and PlatformTextureSurface uses single-effect registration with recovery", async () => {
  const testRoot = mkdtempSync(join(tmpdir(), "pocket-ui-mobile-test-"));
  const nodeModulesRoot = join(testRoot, "node_modules");
  const solidPackageRoot = join(nodeModulesRoot, "solid-js");
  const solidRuntimePath = join(import.meta.dir, "../.cache/pocketjs/node_modules/solid-js/dist/solid.js");
  const solidUniversalPath = join(import.meta.dir, "../.cache/pocketjs/node_modules/solid-js/universal/dist/universal.js");
  const mobileSourcePath = join(import.meta.dir, "../packages/pocket_ui/src/mobile.tsx");
  const legacySourcePath = join(import.meta.dir, "../packages/pocket_ui/src/legacy.ts");
  const isolatedSourceRoot = join(testRoot, "src");
  const isolatedMobilePath = join(isolatedSourceRoot, "mobile.js");
  const runnerPath = join(testRoot, "runner.ts");

  try {
    mkdirSync(solidPackageRoot, { recursive: true });
    mkdirSync(isolatedSourceRoot, { recursive: true });
    writeFileSync(join(solidPackageRoot, "package.json"), JSON.stringify({
      name: "solid-js",
      version: "1.9.14-test",
      type: "module",
      exports: {
        ".": "./solid.js",
        "./universal": "./universal.js",
      },
    }));
    writeFileSync(join(solidPackageRoot, "solid.js"), `export * from ${JSON.stringify(solidRuntimePath)};\n`);
    writeFileSync(join(solidPackageRoot, "universal.js"), `export * from ${JSON.stringify(solidUniversalPath)};\n`);

    const transformed = await transformFile(
      mobileSourcePath,
      readFileSync(mobileSourcePath, "utf8"),
      "solid",
    );
    writeFileSync(isolatedMobilePath, transformed.code);
    writeFileSync(join(isolatedSourceRoot, "legacy.ts"), readFileSync(legacySourcePath));
writeFileSync(join(isolatedSourceRoot, "ui.tsx"), `
import { createContext } from "solid-js";
import { View } from "@pocketjs/framework/solid/components";
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
export const ScrollContourItem = (props: any) => View(props);
export const useScrollContourReserve = () => ({ leftReserve: () => 0, nodeRef: () => {}, reserve: () => 0, reserves: () => ({ left: 0, right: 0 }), syncLayout: () => false });
`);
    for (const file of ["responsive.ts", "host.ts", "display.ts", "motion.ts", "accessibility.ts", "route.tsx"]) {
      writeFileSync(join(isolatedSourceRoot, file), readFileSync(join(import.meta.dir, "../packages/pocket_ui/src", file)));
    }

    writeFileSync(runnerPath, `
import { strict as assert } from "node:assert";
import { mock } from "bun:test";
import { createEffect, createRoot, createSignal } from "solid-js";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("surface-test-fragment"),
  jsx: (type, props) => typeof type === "function" ? type(props) : ({ type, props }),
  jsxs: (type, props) => typeof type === "function" ? type(props) : ({ type, props }),
  jsxDEV: (type, props) => typeof type === "function" ? type(props) : ({ type, props }),
}));
mock.module("@pocketjs/framework/gesture", () => ({ createGesture: () => ({}) }));
mock.module("@pocketjs/framework/clock", () => ({ simulationHz: () => 60, virtualNow: () => 0 }));
mock.module("@pocketjs/framework/solid/lifecycle", () => ({ onFrame: () => () => {} }));

const compositorNodes = [];
const viewNodes = [];

mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: (props) => {
    const node = { type: "surface", package: undefined, class: undefined, style: undefined };
    createEffect(() => {
      node.package = props.package;
      node.class = props.class;
      node.style = props.style;
    });
    compositorNodes.push(node);
    return node;
  },
  Focusable: (props) => ({ type: "focusable", props }),
  Modal: (props) => ({ type: "modal", props }),
  Portal: (props) => ({ type: "portal", props }),
  Text: (props) => ({ type: "text", props }),
  View: (props) => {
    const node = { type: "view", class: undefined, style: undefined, children: undefined };
    createEffect(() => {
      node.class = props.class;
      node.style = props.style;
      node.children = props.children;
    });
    viewNodes.push(node);
    return node;
  },
}));

const { GlassSurface, PlatformTextureSurface } = await import(${JSON.stringify(isolatedMobilePath)});

// 1. GlassSurface updates Surface style.radius and outer View class reactively
const glassRegistrations = [];
globalThis.pocket = {
  registerSurface: (id, kind, payload) => {
    assert.equal(kind, "glass");
    glassRegistrations.push({ id, payload });
    return true;
  },
  releaseSurface: () => {},
};

let disposeGlass;
let setShape;
let setCustomClass;
createRoot((dispose) => {
  disposeGlass = dispose;
  const [shape, updateShape] = createSignal("rounded");
  const [customClass, updateClass] = createSignal("glass-shell-a");
  setShape = updateShape;
  setCustomClass = updateClass;
  GlassSurface({
    get shape() { return shape(); },
    get class() { return customClass(); },
  });
});

assert.equal(glassRegistrations.length, 1);
assert.equal(compositorNodes.length, 1);
const glassSurfaceNode = compositorNodes[0];
const outerGlassView = viewNodes[0];
assert.equal(outerGlassView.class, "glass-shell-a");
const initialRadius = glassSurfaceNode.style?.radius;
assert.equal(initialRadius, glassRegistrations[0].payload.radius);

setShape("pill");
assert.equal(glassRegistrations.length, 2);
const updatedRadius = glassRegistrations[1].payload.radius;
assert.notEqual(updatedRadius, initialRadius);
assert.equal(glassSurfaceNode.style?.radius, updatedRadius, "Surface node style.radius must update reactively when shape changes");

setCustomClass("glass-shell-b");
assert.equal(outerGlassView.class, "glass-shell-b", "GlassSurface outer View class must update reactively");
disposeGlass();

// 2. PlatformTextureSurface registers once on mount, updates on prop change, and recovers from initial false registration
const textureRegistrations = [];
const textureReleases = [];
globalThis.pocket = {
  registerSurface: (id, kind, payload) => {
    assert.equal(kind, "platformTexture");
    textureRegistrations.push({ id, payload });
    return true;
  },
  releaseSurface: (id) => textureReleases.push(id),
};

let disposeTexture;
let setRadius;
createRoot((dispose) => {
  disposeTexture = dispose;
  const [radius, updateRadius] = createSignal(12);
  setRadius = updateRadius;
  PlatformTextureSurface({
    textureId: 7,
    sourceWidth: 1920,
    sourceHeight: 1080,
    get radius() { return radius(); },
  });
});

assert.equal(textureRegistrations.length, 1, "PlatformTextureSurface must call registerSurface once on mount");
setRadius(12);
assert.equal(textureRegistrations.length, 1, "unchanged PlatformTextureSurface payload must remain deduplicated");
setRadius(28);
assert.equal(textureRegistrations.length, 2, "changed PlatformTextureSurface prop must update registration");
assert.equal(textureRegistrations[1].payload.radius, 28);
disposeTexture();
assert.equal(textureReleases.length, 1);

const retryAttempts = [];
let failFirst = true;
globalThis.pocket = {
  registerSurface: (id, kind, payload) => {
    assert.equal(kind, "platformTexture");
    const ok = !failFirst;
    failFirst = false;
    retryAttempts.push({ id, ok, payload });
    return ok;
  },
  releaseSurface: (id) => textureReleases.push(id),
};

const surfaceCountBeforeRetry = compositorNodes.length;
let disposeRetry;
let setRetryTextureId;
createRoot((dispose) => {
  disposeRetry = dispose;
  const [textureId, updateTextureId] = createSignal(10);
  setRetryTextureId = updateTextureId;
  PlatformTextureSurface({
    get textureId() { return textureId(); },
    sourceWidth: 640,
    sourceHeight: 480,
  });
});

assert.deepEqual(retryAttempts.map((item) => item.ok), [false]);
assert.equal(compositorNodes.length, surfaceCountBeforeRetry, "failed initial registration must render fallback");

setRetryTextureId(11);
assert.deepEqual(retryAttempts.map((item) => item.ok), [false, true], "prop update after initial false registration must retry and recover");
assert.equal(compositorNodes.length, surfaceCountBeforeRetry + 1, "recovered registration must mount CompositorSurface");
disposeRetry();

console.log(JSON.stringify({
  glassRegistrations: glassRegistrations.length,
  textureRegistrations: textureRegistrations.length,
  retryAttempts: retryAttempts.length,
}));
`);

    const result = spawnSync("bun", [runnerPath], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, NODE_PATH: nodeModulesRoot },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    assert.deepEqual(JSON.parse(output ?? "{}"), {
      glassRegistrations: 2,
      textureRegistrations: 2,
      retryAttempts: 2,
    });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
