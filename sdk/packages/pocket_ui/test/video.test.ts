import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testRoot = mkdtempSync(join(tmpdir(), "pocket-ui-video-"));
const nodeModulesRoot = join(testRoot, "node_modules");
const solidPackageRoot = join(nodeModulesRoot, "solid-js");
const solidRuntimePath = join(import.meta.dir, "../../../.cache/pocketjs/node_modules/solid-js/dist/solid.js");
const videoSourcePath = join(testRoot, "video.tsx");
const runnerPath = join(testRoot, "runner.ts");

mkdirSync(solidPackageRoot, { recursive: true });
writeFileSync(join(solidPackageRoot, "package.json"), JSON.stringify({
  name: "solid-js",
  version: "1.9.14-test",
  type: "module",
  exports: { ".": "./solid.js" },
}));
writeFileSync(join(solidPackageRoot, "solid.js"), `export * from ${JSON.stringify(solidRuntimePath)};\n`);
writeFileSync(videoSourcePath, readFileSync(join(import.meta.dir, "../src/video.tsx")));
writeFileSync(runnerPath, `
import { strict as assert } from "node:assert";
import { mock } from "bun:test";

mock.module("react/jsx-dev-runtime", () => ({
  Fragment: Symbol.for("video-test-fragment"),
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
  jsxDEV: (type, props) => ({ type, props }),
}));
mock.module("@pocketjs/framework/solid/components", () => ({
  CompositorSurface: (props) => ({ type: "compositor", props }),
  Show: (props) => (typeof props.when === "function" ? props.when() : props.when) ? props.children : props.fallback,
  Text: (props) => ({ type: "text", props }),
  View: (props) => ({ type: "view", props }),
}));

const { createRoot, createSignal } = await import("solid-js");
const { Video } = await import(${JSON.stringify(videoSourcePath)});
const registrations = [];
const surfaces = [];
const releases = [];
const policyCalls = [];
const configurations = [];
const media = {
  register(id, options) {
    registrations.push({ id, options });
    return {
      id,
      configure(configuration) {
        configurations.push({ id, configuration });
        if (typeof configuration.playing === "boolean" && this.playing !== configuration.playing) {
          this.playing = configuration.playing;
          policyCalls.push(id + (this.playing ? ":play" : ":pause"));
        }
        return true;
      },
      setActive(active) { this.active = active; policyCalls.push(id + ":active:" + active); },
      play() { this.playing = true; policyCalls.push(id + ":play"); return true; },
      pause() { this.playing = false; policyCalls.push(id + ":pause"); return true; },
      dispose() { this.disposed = true; },
    };
  },
};

globalThis.pocket = {
  registerSurface(id, kind, payload) {
    surfaces.push({ id, kind, payload });
    return 100;
  },
  releaseSurface(id) { releases.push(id); },
};
let dispose;
let setAsset;
createRoot((cleanup) => {
  dispose = cleanup;
  const [asset, updateAsset] = createSignal("one.mp4");
  setAsset = updateAsset;
  Video({ id: "hero", get asset() { return asset(); }, media, class: "w-full" });
});
await Promise.resolve();
assert.equal(registrations.length, 1);
assert.deepEqual(registrations[0].options, { group: undefined, page: undefined, active: true, playing: false });
assert.equal(surfaces[0].id, "hero");
assert.equal(surfaces[0].kind, "video");
assert.deepEqual(surfaces[0].payload, { asset: "one.mp4", fit: "cover", autoplay: false });
setAsset("two.mp4");
await Promise.resolve();
assert.deepEqual(surfaces[1].payload, { asset: "two.mp4", fit: "cover", autoplay: false });
dispose();
assert.deepEqual(releases, ["hero"]);

let disposeReactive;
let setActive;
let setPlaying;
let setToken;
let setLoop;
createRoot((cleanup) => {
  disposeReactive = cleanup;
  const [active, updateActive] = createSignal(true);
  const [playing, updatePlaying] = createSignal(false);
  const [token, updateToken] = createSignal("generation-1");
  const [loop, updateLoop] = createSignal(false);
  setActive = updateActive;
  setPlaying = updatePlaying;
  setToken = updateToken;
  setLoop = updateLoop;
  Video({
    id: "reactive",
    asset: "one.mp4",
    get active() { return active(); },
    get playing() { return playing(); },
    get token() { return token(); },
    get loop() { return loop(); },
    media,
  });
});
await Promise.resolve();
assert.deepEqual(registrations.at(-1).options, {
  group: undefined,
  page: undefined,
  active: true,
  playing: false,
  token: "generation-1",
  loop: false,
});
assert.deepEqual(configurations.at(-1), {
  id: "reactive",
  configuration: { token: "generation-1", loop: false, playing: false },
});
const reactiveStart = policyCalls.length;
setActive(false);
await Promise.resolve();
assert.deepEqual(policyCalls.slice(reactiveStart), ["reactive:active:false"]);
setPlaying(true);
await Promise.resolve();
assert.deepEqual(policyCalls.slice(reactiveStart), ["reactive:active:false", "reactive:play"]);
setToken("generation-2");
setLoop(true);
await Promise.resolve();
assert.deepEqual(configurations.at(-1), {
  id: "reactive",
  configuration: { token: "generation-2", loop: true, playing: true },
});
disposeReactive();

globalThis.pocket = undefined;
let unsupported;
createRoot((cleanup) => {
  unsupported = Video({ id: "unsupported", asset: "one.mp4", media });
  cleanup();
});
assert.equal(unsupported.type.name, "View");
assert.equal(unsupported.props.children.type.name, "View");
assert.equal(unsupported.props.children.props.children.type.name, "Show");
assert.equal(unsupported.props.children.props.children.props.when, false);
assert.equal(unsupported.props.children.props.children.props.fallback.type.name, "View");
assert.equal(unsupported.props.children.props.children.props.fallback.props.children.type.name, "Text");

let hostReleaseCalls = 0;
globalThis.pocket = {
  registerSurface() { throw new Error("application surface is host-owned"); },
  releaseSurface() { hostReleaseCalls++; throw new Error("must not release host-owned surface"); },
};
let disposeHostOwned;
createRoot((cleanup) => {
  disposeHostOwned = cleanup;
  Video({ id: "host-owned", asset: "one.mp4", media });
});
await Promise.resolve();
disposeHostOwned();
assert.equal(hostReleaseCalls, 0);

globalThis.pocket = {
  registerSurface() { return 100; },
  releaseSurface() { hostReleaseCalls++; throw new Error("provider release failed"); },
};
let disposeReleaseFailure;
createRoot((cleanup) => {
  disposeReleaseFailure = cleanup;
  Video({ id: "release-fails", asset: "one.mp4", media });
});
await Promise.resolve();
disposeReleaseFailure();
assert.equal(hostReleaseCalls, 1);
console.log(JSON.stringify({ registrations: registrations.length, surfaces: surfaces.length, releases: releases.length }));
`);

test("Video binds a stable native surface and refuses an unsupported provider", () => {
  try {
    const result = spawnSync("bun", [runnerPath], {
      cwd: join(import.meta.dir, "../../../../"),
      env: { ...process.env, NODE_PATH: nodeModulesRoot },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    assert.deepEqual(JSON.parse(output ?? "{}"), { registrations: 5, surfaces: 3, releases: 2 });
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

