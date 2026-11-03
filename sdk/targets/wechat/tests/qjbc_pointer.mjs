#!/usr/bin/env node
// Portable integration gate for the actual generated WeChat WASM package.
// This is a Node WebAssembly runtime probe, not a WeChat simulator.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

const input = process.argv[2];
if (!input) throw new Error("usage: node qjbc_pointer.mjs <generated-mini-program-dir|pocketjs.wasm[.br]>");

let wasm;
let buildInfo = null;
try {
  if (statSync(input).isDirectory()) {
    buildInfo = JSON.parse(readFileSync(`${input}/build-info.json`, "utf8"));
    wasm = brotliDecompressSync(readFileSync(`${input}/${buildInfo.enginePath || "engine/pocketjs.wasm.br"}`));
  } else if (input.endsWith(".br")) {
    wasm = brotliDecompressSync(readFileSync(input));
  } else {
    wasm = readFileSync(input);
  }
} catch (error) {
  throw new Error(`cannot read generated PocketJS package at ${input}: ${error.message}`);
}

assert.deepEqual([...wasm.subarray(0, 4)], [0, 0x61, 0x73, 0x6d], "generated engine must be a WebAssembly module");
if (buildInfo) {
  assert.equal(buildInfo.target, "wechat-host-qjbc");
  assert.equal(buildInfo.rquickjs, "0.12.2");
  assert.equal(buildInfo.appId, "pocket.demo.lobby", "the acceptance guest is the retained standalone Lobby app");
  assert.equal(buildInfo.composition, "single-guest-primary-surface");
  assert.equal(buildInfo.quickjsBytecode?.entryFormat, "quickjs-bytecode");
  assert.ok(Number(buildInfo.quickjsBytecode?.bytecodeBytes) > 0, "package must embed compiled QJBC");
  assert.equal(createHash("sha256").update(wasm).digest("hex"), buildInfo.engineSha256);
}

const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module).map(({ module, name, kind }) => `${module}.${name}:${kind}`).sort();
assert.deepEqual(imports, [
  "env.__rquickjs_host_now_us:function",
  "pocket_wechat.host_emit:function",
]);

const emitted = [];
let instance;
const decoder = new TextDecoder();
const imported = {
  env: { __rquickjs_host_now_us: () => Date.now() * 1000 },
  pocket_wechat: {
    host_emit(pointer, length) {
      if (!instance || length <= 0 || length > 64 * 1024) return 0;
      emitted.push(decoder.decode(new Uint8Array(instance.exports.memory.buffer, pointer, length)));
      return 1;
    },
  },
};
instance = await WebAssembly.instantiate(module, imported);
const ex = instance.exports;
// Exercise logical touch coordinates at a DPR 2 raster scale (720x1280 output).
const host = ex.web_create(360, 640, 2, 0, 0);
assert.ok(host, "PocketJS host allocation must succeed");

const decodeResult = () => {
  const pointer = ex.web_result_ptr(host);
  const length = ex.web_result_len(host);
  return length ? decoder.decode(new Uint8Array(ex.memory.buffer, pointer, length)) : "";
};
const check = (code, message) => assert.equal(code, 0, `${message}: ${decodeResult()}`);
const withBytes = (text, callback) => {
  const bytes = new TextEncoder().encode(text);
  const pointer = ex.web_alloc(bytes.length);
  assert.ok(pointer);
  new Uint8Array(ex.memory.buffer, pointer, bytes.length).set(bytes);
  try { return callback(pointer, bytes.length); }
  finally { ex.web_free(pointer, bytes.length); }
};
const present = () => check(ex.web_present(host), "renderer present failed");
const frame = (contacts) => withBytes(JSON.stringify({
  buttons: 0,
  analog: 0x8080,
  rightAnalog: 0x8080,
  contacts,
  axisDeltas: [],
}), (pointer, length) => check(ex.web_advance(host, pointer, length, 1), "Guest input frame failed"));
const inspect = (id) => {
  check(ex.web_inspect(host, id), `inspect ${id} failed`);
  return JSON.parse(decodeResult());
};
const parents = new Map();
const findText = (text) => {
  for (let id = 0; id < 2048; id += 1) {
    const node = inspect(id);
    if (node && Array.isArray(node.children)) {
      for (const child of node.children) parents.set(child, id);
    }
    if (node && node.text === text) return { id, node };
  }
  return null;
};
const actionAncestor = (textNode) => {
  let id = parents.get(textNode.id);
  while (id !== undefined) {
    const node = inspect(id);
    if (node && node.type === 0) return { id, node };
    id = parents.get(id);
  }
  return textNode;
};
const textWithin = (id) => {
  const node = inspect(id);
  if (!node) return [];
  const ownText = typeof node.text === "string" ? [node.text] : [];
  return ownText.concat((node.children || []).flatMap((child) => textWithin(child)));
};
const valueAfterLabel = (label) => {
  const node = findText(label);
  if (!node) return null;
  let branch = node.id;
  let ancestor = parents.get(branch);
  while (ancestor !== undefined) {
    const parentId = parents.get(ancestor);
    if (parentId !== undefined) {
      const parent = inspect(parentId);
      const index = parent?.children?.indexOf(ancestor) ?? -1;
      if (index >= 0) {
        for (const sibling of parent.children.slice(index + 1)) {
          const texts = textWithin(sibling).filter((text) => text.length > 0);
          if (texts.length) return texts[0];
        }
      }
    }
    branch = ancestor;
    ancestor = parents.get(branch);
  }
  return null;
};
const pixelHash = () => {
  const pointer = ex.web_pixels(host);
  const length = ex.web_pixels_len(host);
  assert.ok(pointer && length > 0, "core software renderer must publish its pixel buffer");
  return createHash("sha256").update(new Uint8Array(ex.memory.buffer, pointer, length)).digest("hex");
};

try {
  try {
  check(ex.web_wechat_boot(host, 2), "actual QuickJS bytecode Guest failed to boot");
  } catch (error) {
    console.error(`boot failure detail: ${decodeResult()}`);
    throw error;
  }
  present();
  const before = findText("Increment lobby counter");
  assert.ok(before, "Lobby QJBC Guest must expose its counter action");
  assert.equal(valueAfterLabel("count"), "0", "Lobby count value must begin at zero");
  assert.equal(valueAfterLabel("visits"), "0", "Lobby visits value must begin at zero");
  const action = actionAncestor(before);
  for (let id = 0; id < 2048; id += 1) {
    const node = inspect(id);
    if (node && Array.isArray(node.children)) {
      for (const child of node.children) parents.set(child, id);
    }
  }
  const layoutPointer = ex.web_alloc(32);
  assert.ok(layoutPointer);
  try {
    assert.equal(ex.web_layout(host, action.id, layoutPointer), 1, "action ancestor must have core layout bounds");
    const rect = Array.from(new Float32Array(ex.memory.buffer, layoutPointer, 8));
    let x = rect[0], y = rect[1];
    for (let ancestor = parents.get(action.id); ancestor !== undefined; ancestor = parents.get(ancestor)) {
      assert.equal(ex.web_layout(host, ancestor, layoutPointer), 1, `layout ancestor ${ancestor} must be live`);
      const parentRect = new Float32Array(ex.memory.buffer, layoutPointer, 4);
      x += parentRect[0];
      y += parentRect[1];
    }
    x += rect[2] / 2;
    y += rect[3] / 2;
    const firstPixels = pixelHash();
    frame([{ surface: 0, id: 73, x, y, cancelled: false }]);
    present();
    frame([]);
    present();
    const after = findText("1");
    assert.ok(after, "a real contact down/up frame must change visible Lobby state");
    assert.equal(valueAfterLabel("count"), "1", "the Lobby guest count must update to one");
    assert.equal(valueAfterLabel("visits"), "1", "the Lobby guest visits value must update to one");
    assert.notEqual(pixelHash(), firstPixels, "the next core frame must render the changed Guest state");
  } finally {
    ex.web_free(layoutPointer, 32);
  }
  const workStatePointer = ex.web_wechat_work_state(host);
  check(workStatePointer, "event-driven scheduler state query failed");
  const packets = emitted.map((line) => JSON.parse(line));
  assert.ok(packets.every((packet) => typeof packet === "object"), "host bridge output must remain JSON packets");
  const storageRequest = packets.find((packet) => packet.name === "host.request" && packet.payload?.capability === "platform.storage.get");
  assert.ok(storageRequest, "the Lobby Guest must reach the host.request capability bridge");
  const response = JSON.stringify({
    type: "event",
    name: "host.response",
    payload: { requestId: storageRequest.payload.requestId, capability: "platform.storage.get", ok: true, result: null },
  });
  withBytes(response, (pointer, length) => check(ex.web_wechat_deliver(host, pointer, length), "host capability response delivery failed"));
  frame([]);
  present();
  assert.ok(findText("No shared identity yet."), "the real Guest must receive and resolve the storage response");
  console.log(JSON.stringify({
    result: "pass",
    host: "actual PocketJS Runtime + QuickJS 0.12.2 bytecode Guest",
    guestTransition: "Lobby counter 0 -> 1 after contact down/up and next frame",
    wasmSha256: createHash("sha256").update(wasm).digest("hex"),
    qjbcBytes: buildInfo?.quickjsBytecode?.bytecodeBytes ?? null,
    notice: "Node WebAssembly probe only; this does not accept the WeChat DevTools or device gate.",
  }, null, 2));
} finally {
  assert.equal(ex.web_destroy(host), 0, "PocketJS host disposal must release the Guest and Runtime");
}
