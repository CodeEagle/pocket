import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

test("Apple semantic store uses the pinned Solid runtime in an isolated fixture", () => {
  const testRoot = mkdtempSync(join(tmpdir(), "pocket-ui-semantics-"));
  const nodeModulesRoot = join(testRoot, "node_modules");
  const solidRoot = join(nodeModulesRoot, "solid-js");
  const frameworkRoot = join(nodeModulesRoot, "@pocketjs", "framework");
  const sourceRoot = join(testRoot, "src");
  const runnerPath = join(testRoot, "runner.ts");
  const solidRuntimePath = join(
    import.meta.dir,
    "../../../.cache/pocketjs/node_modules/solid-js/dist/solid.js",
  );

  mkdirSync(solidRoot, { recursive: true });
  mkdirSync(join(frameworkRoot, "solid"), { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(solidRoot, "package.json"), JSON.stringify({
    name: "solid-js",
    version: "1.9.14-test",
    type: "module",
    exports: { ".": "./solid.js" },
  }));
  writeFileSync(join(solidRoot, "solid.js"), `export * from ${JSON.stringify(solidRuntimePath)};\n`);
  writeFileSync(join(frameworkRoot, "package.json"), JSON.stringify({
    name: "@pocketjs/framework",
    version: "0.0.0-test",
    type: "module",
    exports: {
      "./solid/lifecycle": "./solid/lifecycle.js",
      "./solid/components": "./solid/components.js",
    },
  }));
  writeFileSync(join(frameworkRoot, "solid", "components.js"), "export {};\n");
  writeFileSync(join(frameworkRoot, "solid", "lifecycle.js"), `
const hooks = [];
export function onFrame(callback, options = {}) { hooks.push({ callback, options }); }
export function runFrame() { for (const hook of [...hooks]) hook.callback(0); }
export function continuousHint() {
  const value = hooks[0]?.options?.continuous;
  return typeof value === "function" ? value() : value ?? true;
}
export function resetFrames() { hooks.length = 0; }
`);
  writeFileSync(join(sourceRoot, "semantics.ts"), readFileSync(join(import.meta.dir, "../src/semantics.ts")));
  writeFileSync(join(sourceRoot, "host.ts"), readFileSync(join(import.meta.dir, "../src/host.ts")));
  writeFileSync(runnerPath, `
import { strict as assert } from "node:assert";
import { createRoot, createSignal } from "solid-js";
import { continuousHint, resetFrames, runFrame } from "@pocketjs/framework/solid/lifecycle";
import {
  ACCESSIBILITY_ACTION_EVENT,
  ACCESSIBILITY_SNAPSHOT_EVENT,
  createAppleSemanticsStore,
  MAX_APPLE_SEMANTIC_CONTROLS,
} from ${JSON.stringify(join(sourceRoot, "semantics.ts"))};

class Bridge {
  sent = [];
  listeners = new Set();
  emit(method, params = {}) { this.sent.push({ method, params }); return true; }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  deliver(params) {
    const event = { id: "semantics-test", method: ACCESSIBILITY_ACTION_EVENT, params, raw: params };
    for (const listener of [...this.listeners]) listener(event);
  }
}
const node = (id) => ({ id, type: 0, parent: null, children: [] });
const snapshots = (bridge) => bridge.sent.filter((event) => event.method === ACCESSIBILITY_SNAPSHOT_EVENT).map((event) => event.params);
let layoutReads = 0;
globalThis.pocket = { getLayout: (id) => {
  layoutReads++;
  if (id !== 7) return undefined;
  return layoutReads < 3 ? undefined : { x: 10, y: 20, width: 80, height: 40 };
} };

resetFrames();
const bridge = new Bridge();
let disposeRoot;
let store;
let activateCount = 0;
createRoot((dispose) => {
  disposeRoot = dispose;
  const [route, setRoute] = createSignal(true);
  store = createAppleSemanticsStore({
    bridge,
    routeActive: route,
    visualRect: (_node, rect) => ({ ...rect, y: rect.y - 5 }),
    clipRect: () => ({ x: 0, y: 0, width: 200, height: 100 }),
  });
  const bind = store.register({
    id: "apple.save", label: "Save", role: "button", selected: false,
    disabled: false, checked: false, onActivate: () => { activateCount++; },
  });
  bind(node(7));
  globalThis.setRoute = setRoute;
});

assert.equal(continuousHint(), true);
runFrame();
assert.equal(snapshots(bridge).length, 0, "pre-commit read must not publish an empty tree");
runFrame();
assert.equal(snapshots(bridge).length, 0, "the bounded admission retry stays passive until layout commits");
runFrame();
assert.deepEqual(snapshots(bridge)[0], {
  generation: 1,
  controls: [{ guestId: "apple.save", nativeId: 7, label: "Save", role: "button",
    selected: false, disabled: false, enabled: true, checked: false,
    rect: { x: 10, y: 15, width: 80, height: 40 } }],
});
assert.equal(continuousHint(), false, "initial admission parks after the committed read");
runFrame();
assert.equal(snapshots(bridge).length, 1, "identical committed frames deduplicate");
bridge.deliver({ action: "activate", guestId: "apple.save", generation: 1 });
assert.equal(activateCount, 1);
bridge.deliver({ action: "activate", guestId: "apple.save", generation: 0 });
assert.equal(activateCount, 1, "stale generation is rejected");
globalThis.setRoute(false);
runFrame();
assert.deepEqual(snapshots(bridge).at(-1).controls, []);
globalThis.setRoute(true);
runFrame();
assert.equal(activateCount, 1, "hidden route cannot activate a semantic node");

assert.throws(() => {
  for (let index = 0; index < MAX_APPLE_SEMANTIC_CONTROLS; index++) {
    store.register({ id: "extra." + index, label: "Extra " + index });
  }
}, RangeError);
disposeRoot();
store.dispose();
assert.deepEqual(snapshots(bridge).at(-1).controls, []);
console.log(JSON.stringify({ snapshots: snapshots(bridge).length, layoutReads }));
`);

  try {
    const result = spawnSync("bun", [runnerPath], {
      cwd: join(import.meta.dir, "../../../../"),
      env: { ...process.env, NODE_PATH: nodeModulesRoot },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    assert.deepEqual(JSON.parse(output ?? "{}"), { snapshots: 4, layoutReads: 5 });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
