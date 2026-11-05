#!/usr/bin/env node
// Node WebAssembly acceptance for a generated multi-Guest WeChat bundle.
// This is a real PocketJS/QJBC Guest probe with a small WX/canvas boundary
// adapter; it is not a WeChat DevTools or physical-device test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { brotliDecompressSync } from "node:zlib";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const bundle = process.argv[2];
if (!bundle) {
  throw new Error("usage: node wechat_system_binary_probe.mjs <generated-system-bundle-dir>");
}
const bundleDir = resolve(bundle);
if (!statSync(bundleDir).isDirectory()) {
  throw new Error("the probe requires the complete generated mini-program bundle directory");
}

const require = createRequire(import.meta.url);
const bridgePath = join(bundleDir, "binary-bridge.js");
if (!existsSync(bridgePath)) {
  throw new Error(`generated bundle is missing ${bridgePath}`);
}
const bridge = require(bridgePath);
if (typeof bridge.encodeMessage !== "function" || typeof bridge.decodeMessage !== "function") {
  throw new Error("generated binary-bridge.js does not expose the B1 codec");
}
const { encodeMessage, decodeMessage } = bridge;
const config = require(join(bundleDir, "pocket.config.js"));
const { PocketWechatHost } = require(join(bundleDir, "wechat-host.js"));
const buildInfo = JSON.parse(readFileSync(join(bundleDir, "build-info.json"), "utf8"));
assert.equal(buildInfo.target, "wechat-host-qjbc");
assert.equal(buildInfo.composition, "system-multi-guest-primary-surface");
assert.ok(Array.isArray(buildInfo.quickjsBytecode?.apps));
assert.ok(buildInfo.quickjsBytecode.apps.length >= 3, "bundle must contain SystemUI, Profile and Lobby Guests");
const builtApps = buildInfo.quickjsBytecode.apps;

const enginePath = join(bundleDir, buildInfo.enginePath || "engine/pocketjs.wasm.br");
const wasm = brotliDecompressSync(readFileSync(enginePath));
assert.deepEqual([...wasm.subarray(0, 4)], [0, 0x61, 0x73, 0x6d]);
assert.equal(createHash("sha256").update(wasm).digest("hex"), buildInfo.engineSha256);
const wasmModule = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(wasmModule)
  .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
  .sort();
assert.deepEqual(imports, [
  "env.__rquickjs_host_now_us:function",
  "pocket_wechat.host_emit:function",
]);

const decoder = new TextDecoder();
function resultBytes(exports, host) {
  const length = exports.web_result_len(host);
  if (!length) return new Uint8Array();
  return new Uint8Array(exports.memory.buffer, exports.web_result_ptr(host), length).slice();
}

function resultText(exports, host) {
  return decoder.decode(resultBytes(exports, host));
}

function check(exports, host, code, message) {
  assert.equal(code, 0, `${message}: ${resultText(exports, host)}`);
}

function withBytes(exports, host, bytes, callback) {
  const pointer = exports.web_alloc(bytes.length);
  assert.ok(pointer, "WASM input allocation must succeed");
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
  try {
    return callback(pointer, bytes.length);
  } finally {
    exports.web_free(pointer, bytes.length);
  }
}

function packetFromResult(exports, host, message) {
  const bytes = resultBytes(exports, host);
  assert.equal(bytes[0], 0xb1, `${message} must use B1 transport`);
  return { bytes, packet: decodeMessage(bytes) };
}

function compositorFrames(exports, host) {
  check(exports, host, exports.web_compositor_frames(host), "web_compositor_frames failed");
  const decoded = packetFromResult(exports, host, "compositor frame packet");
  assert.ok(Array.isArray(decoded.packet.frames), "B1 compositor packet must contain frames[]");
  return decoded;
}

function scheduler(exports, host) {
  check(exports, host, exports.web_wechat_work_state(host), "web_wechat_work_state failed");
  const decoded = packetFromResult(exports, host, "scheduler packet");
  assert.equal(typeof decoded.packet.continuous, "boolean");
  assert.equal(typeof decoded.packet.simulationHz, "number");
  return decoded.packet;
}

function pixelHash(exports, host) {
  const pointer = exports.web_pixels(host);
  const length = exports.web_pixels_len(host);
  assert.ok(pointer && length > 0, "Guest must publish a real RGBA pixel frame");
  return createHash("sha256")
    .update(new Uint8Array(exports.memory.buffer, pointer, length))
    .digest("hex");
}

function inspect(exports, host, id) {
  if (exports.web_inspect(host, id) !== 0) return null;
  try {
    return JSON.parse(resultText(exports, host));
  } catch (_) {
    return null;
  }
}

function tree(exports, host) {
  const nodes = new Map();
  const parents = new Map();
  for (let id = 0; id < 2048; id += 1) {
    const node = inspect(exports, host, id);
    if (!node) continue;
    nodes.set(id, node);
    if (Array.isArray(node.children)) {
      for (const child of node.children) parents.set(child, id);
    }
  }
  return { nodes, parents };
}

function layout(exports, host, id, parents) {
  const pointer = exports.web_alloc(32);
  assert.ok(pointer, "layout allocation must succeed");
  try {
    assert.equal(exports.web_layout(host, id, pointer), 1, `layout ${id} must be available`);
    const own = Array.from(new Float32Array(exports.memory.buffer, pointer, 4));
    let x = own[0];
    let y = own[1];
    for (let parent = parents.get(id); parent !== undefined; parent = parents.get(parent)) {
      assert.equal(exports.web_layout(host, parent, pointer), 1, `layout parent ${parent} must be available`);
      const parentRect = new Float32Array(exports.memory.buffer, pointer, 4);
      x += parentRect[0];
      y += parentRect[1];
    }
    return [x, y, own[2], own[3]];
  } finally {
    exports.web_free(pointer, 32);
  }
}

function actionBounds(exports, host, targetText) {
  const current = tree(exports, host);
  let target;
  for (const [id, node] of current.nodes) {
    if (node.text === targetText) {
      target = id;
      break;
    }
  }
  assert.notEqual(target, undefined, `Guest must expose ${targetText}`);
  let action = target;
  for (let parent = current.parents.get(target); parent !== undefined; parent = current.parents.get(parent)) {
    if (current.nodes.get(parent)?.type === 0) {
      action = parent;
      break;
    }
  }
  return { bounds: layout(exports, host, action, current.parents), current };
}

function textWithin(nodes, id) {
  const node = nodes.get(id);
  if (!node) return [];
  const own = typeof node.text === "string" ? [node.text] : [];
  return own.concat((node.children || []).flatMap((child) => textWithin(nodes, child)));
}

function valueAfterLabel(exports, host, label) {
  const current = tree(exports, host);
  let labelId;
  for (const [id, node] of current.nodes) {
    if (node.text === label) {
      labelId = id;
      break;
    }
  }
  if (labelId === undefined) return null;
  let branch = labelId;
  let ancestor = current.parents.get(branch);
  while (ancestor !== undefined) {
    const parentId = current.parents.get(ancestor);
    if (parentId !== undefined) {
      const parent = current.nodes.get(parentId);
      const index = parent?.children?.indexOf(ancestor) ?? -1;
      if (index >= 0) {
        for (const sibling of parent.children.slice(index + 1)) {
          const values = textWithin(current.nodes, sibling).filter((text) => text.length > 0);
          if (values.length) return values[0];
        }
      }
    }
    branch = ancestor;
    ancestor = current.parents.get(branch);
  }
  return null;
}

function advance(exports, host, contacts) {
  const bytes = encodeMessage({
    buttons: 0,
    analog: 0x8080,
    rightAnalog: 0x8080,
    contacts,
    axisDeltas: [],
  });
  withBytes(exports, host, bytes, (pointer, length) => {
    check(exports, host, exports.web_advance(host, pointer, length, 1), "Guest input frame failed");
  });
  check(exports, host, exports.web_present(host), "Guest renderer present failed");
}

async function probeDirectGuest(index) {
  const emitted = [];
  let instance;
  const imported = {
    env: { __rquickjs_host_now_us: () => Date.now() * 1000 },
    pocket_wechat: {
      host_emit(pointer, length) {
        if (!instance || length <= 0 || length > 64 * 1024) return 0;
        try {
          emitted.push(decodeMessage(new Uint8Array(instance.exports.memory.buffer, pointer, length)));
          return 1;
        } catch (_) {
          return 0;
        }
      },
    },
  };
  instance = await WebAssembly.instantiate(wasmModule, imported);
  const exports = instance.exports;
  const host = exports.web_create(375, 812, 1, 0, 0);
  assert.ok(host, `Guest ${index} host allocation must succeed`);
  try {
    check(exports, host, exports.web_wechat_boot_index(host, 1, index), `Guest ${index} QJBC boot failed`);
    check(exports, host, exports.web_present(host), `Guest ${index} initial present failed`);
    const initialPixels = pixelHash(exports, host);
    const state = scheduler(exports, host);
    const frames = compositorFrames(exports, host);
    assert.ok(initialPixels.length > 0);
    assert.ok(emitted.every((packet) => packet && typeof packet === "object"));

    let pointerChanged = false;
    let counter = null;
    if (index === 2) {
      const action = actionBounds(exports, host, "Increment lobby counter");
      const [x, y, width, height] = action.bounds;
      assert.ok(width > 0 && height > 0);
      const contact = { surface: 0, id: 73, x: x + width / 2, y: y + height / 2, cancelled: false };
      advance(exports, host, [contact]);
      advance(exports, host, []);
      counter = valueAfterLabel(exports, host, "count");
      pointerChanged = pixelHash(exports, host) !== initialPixels;
      assert.equal(counter, "1", "real Lobby pointer input must change count");
      assert.ok(pointerChanged, "real Lobby pointer input must change the framebuffer");
    }
    return {
      index,
      appId: builtApps[index]?.appId,
      emittedPackets: emitted.length,
      scheduler: { continuous: state.continuous, simulationHz: state.simulationHz },
      compositorBytes: frames.bytes.length,
      compositorFrameCount: frames.packet.frames.length,
      pointerChanged,
      counter,
    };
  } finally {
    assert.equal(exports.web_destroy(host), 0, `Guest ${index} disposal must succeed`);
  }
}

function makeWechatWx() {
  const storage = new Map();
  return {
    WXWebAssembly: {
      instantiate: async (_path, imports) => ({ instance: await WebAssembly.instantiate(wasmModule, imports) }),
    },
    __pocketBrowserDevicePixelRatio: 1,
    getWindowInfo: () => ({
      windowWidth: 375,
      windowHeight: 812,
      screenWidth: 375,
      screenHeight: 812,
      pixelRatio: 1,
      safeArea: { top: 0, right: 375, bottom: 812, left: 0 },
    }),
    getStorage({ key, success, fail }) {
      if (storage.has(key)) success({ data: storage.get(key) });
      else fail({ errMsg: "data not found" });
    },
    setStorage({ key, data, success }) {
      storage.set(key, data);
      success?.({});
    },
    removeStorage({ key, success }) {
      storage.delete(key);
      success?.({});
    },
    getStorageInfo({ success }) { success({ keys: [...storage.keys()] }); },
    hideKeyboard({ complete }) { complete?.(); },
  };
}

function makeCanvas() {
  const context = {
    createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
    putImageData() {},
  };
  return { canvas: { width: 1, height: 1 }, context };
}

async function probeSystemBoundary() {
  const wx = makeWechatWx();
  const { canvas, context } = makeCanvas();
  const errors = [];
  const root = new PocketWechatHost({
    wx,
    config,
    canvas,
    context,
    isActive: () => true,
    onInput: () => {},
    onError: (error) => errors.push(String(error?.stack || error)),
  });
  try {
    await root.start(375, 812, 1);
    root.stopScheduled();
    const initialPixels = pixelHash(root.exports, root.host);
    const action = actionBounds(root.exports, root.host, "Open profile app");
    const [x, y, width, height] = action.bounds;
    root.inputFrame([{ surface: 0, id: 91, x: x + width / 2, y: y + height / 2, cancelled: false }]);
    root.stopScheduled();
    root.inputFrame([]);
    root.stopScheduled();

    let profile;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      root.stopScheduled();
      profile = [...root.system.runtimes.values()].find((runtime) => runtime.config.appId === "pocket.demo.profile");
      if (profile?.started && profile.surfaceUploaded) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.ok(profile?.started, "real SystemUI input must create the Profile Guest");
    assert.ok(profile.surfaceUploaded, "real Profile Guest raster must upload to its compositor surface");
    root.stopScheduled();
    root.draw();
    root.stopScheduled();
    const frames = compositorFrames(root.exports, root.host);
    const profileFrame = frames.packet.frames.find((frame) => frame.handle === 2);
    assert.ok(profileFrame, "B1 compositor packet must expose the Profile surface");
    assert.ok(profileFrame.focused, "Profile surface must be focused after real open input");
    assert.notEqual(pixelHash(root.exports, root.host), initialPixels, "system composition must change the root framebuffer");
    assert.equal(errors.length, 0, `WeChat host boundary reported errors: ${errors.join("; ")}`);
    const state = scheduler(root.exports, root.host);
    return {
      runtimeCount: root.system.runtimes.size,
      profileUploaded: profile.surfaceUploaded,
      focusedHandle: profileFrame.handle,
      compositorBytes: frames.bytes.length,
      compositorFrameCount: frames.packet.frames.length,
      scheduler: { continuous: state.continuous, simulationHz: state.simulationHz },
    };
  } finally {
    root.dispose();
  }
}

const direct = [];
for (const index of [0, 1, 2]) direct.push(await probeDirectGuest(index));
const system = await probeSystemBoundary();
console.log(JSON.stringify({
  result: "pass",
  host: "actual generated PocketJS WASM + QJBC Guests",
  guestsBooted: direct.map((entry) => entry.appId),
  direct,
  system,
  notice: "Node WebAssembly probe with a WX/canvas boundary adapter; not WeChat DevTools or a physical-device gate.",
}, null, 2));
