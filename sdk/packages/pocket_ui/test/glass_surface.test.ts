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

writeFileSync(runnerPath, `
import { strict as assert } from "node:assert";
import { mock } from "bun:test";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("glass-test-fragment"),
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  jsxDEV: (type, props) => ({ type, props }),
}));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: (props) => ({ type: "compositor", props }),
  Focusable: (props) => ({ type: "focusable", props }),
  Modal: (props) => ({ type: "modal", props }),
  Text: (props) => ({ type: "text", props }),
  View: (props) => ({ type: "view", props }),
}));

const { createRoot, createSignal } = await import("solid-js");
const { GlassSurface } = await import(${JSON.stringify(isolatedMobileSourcePath)});

const registrations = [];
const releases = [];
const bridge = {
  registerSurface: (id, kind, payload) => {
    assert.equal(kind, "glass");
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
assert.equal(registrations.length, 1, "the initial effect must register once");
setPressed(false);
assert.equal(registrations.length, 1, "an unchanged payload must remain deduplicated");
setPressed(true);
assert.equal(registrations.length, 2, "a changed payload must update the existing surface");
assert.notEqual(registrations[0].payload, registrations[1].payload);
setPressed(true);
assert.equal(registrations.length, 2, "the updated payload must also be deduplicated");
const firstId = registrations[0].id;
firstDispose();
assert.deepEqual(releases, [firstId], "dispose must release the component's own id");

let secondDispose;
createRoot((dispose) => {
  secondDispose = dispose;
  GlassSurface({ shape: "rounded", pressed: true });
});
assert.equal(registrations.length, 3, "a new instance must register despite a matching payload");
assert.notEqual(firstId, registrations[2].id, "surface ids must remain instance-local");
secondDispose();
assert.deepEqual(releases, [firstId, registrations[2].id]);

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
assert.deepEqual(attempts.map((attempt) => attempt.bridge), ["fail"]);
setRetryPressed(true);
assert.deepEqual(attempts.map((attempt) => attempt.bridge), ["fail", "retry"], "a changed payload must retry after failure");
setRetryPressed(true);
assert.deepEqual(attempts.map((attempt) => attempt.bridge), ["fail", "retry"], "the retried payload must then deduplicate");
retryDispose();

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
    assert.deepEqual(JSON.parse(output ?? "{}"), { registrations: 3, attempts: 2, releases: 3 });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
