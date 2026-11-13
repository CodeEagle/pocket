import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from "../src/bytes.ts";
import { sha256Hex } from "../src/sha256.ts";
import { CHUNK_BYTES, createStudioClient, StudioError, type StudioHost, type StudioStreams } from "../src/studio-client.ts";

type Call = { capability: string; params: any };

function fakeHost(handler: (c: Call) => unknown | Promise<unknown>): { host: StudioHost; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, host: { async request(capability, params = {}) { const call = { capability, params }; calls.push(call); return handler(call) as any; } } };
}

test("sha256, base64 and utf8 helpers match node", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 200_000]) {
    const bytes = new Uint8Array(randomBytes(size));
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `sha ${size}`);
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString("base64"));
    assert.deepEqual(Array.from(base64Decode(base64Encode(bytes))), Array.from(bytes));
  }
  const text = "héllo 你好 😀 \n tab\t";
  assert.deepEqual(Array.from(utf8Encode(text)), Array.from(Buffer.from(text)));
  assert.equal(utf8Decode(utf8Encode(text)), text);
});

test("request shapes: every wrapper sends the frozen capability and params", async () => {
  const { host, calls } = fakeHost(() => ({ projects: [] }));
  const c = createStudioClient(host);
  await c.project.list();
  await c.project.create("p-1", "game", { name: "N" });
  await c.project.open("p-1");
  await c.project.settings.get("p-1");
  await c.project.settings.set("p-1", { title: "T" });
  await c.fs.tree("p-1", true);
  await c.fs.read("p-1", "a.ts");
  await c.fs.write("p-1", "a.ts", "x");
  await c.fs.rename("p-1", "a.ts", "b.ts", true);
  await c.fs.delete("p-1", "b.ts");
  await c.fs.stat("p-1", "src");
  await c.fs.mkdir("p-1", "src");
  await c.fs.rmdir("p-1", "src");
  await c.build.start("p-1");
  await c.build.cancel("p-1");
  await c.build.status("p-1");
  await c.logs.tail("p-1");
  await c.preview.publish("p-1");
  await c.preview.devices();
  await c.preview.deploy("p-1", "sim");
  await c.preview.deployStatus("p-1", "j1");
  await c.preview.deployCancel("p-1", "j1");
  await c.publish.plan("p-1", "release");
  await c.publish.publish("p-1");
  await c.publish.history("p-1");
  await c.publish.offline("p-1");
  await c.artifacts.list("p-1");
  await c.artifacts.inspect("p-1", "build.json");
  await c.service.health();
  await c.service.upgradeStatus();
  assert.deepEqual(calls.map((x) => x.capability), [
    "studio.project.list", "studio.project.create", "studio.project.open", "studio.project.settings.get", "studio.project.settings.set",
    "studio.fs.tree", "studio.fs.read", "studio.fs.write", "studio.fs.rename", "studio.fs.delete", "studio.fs.stat", "studio.fs.mkdir", "studio.fs.rmdir",
    "studio.build.start", "studio.build.cancel", "studio.build.status", "studio.logs.tail",
    "studio.preview.publish", "studio.preview.devices", "studio.preview.deploy", "studio.preview.deployStatus", "studio.preview.deployCancel",
    "studio.publish.plan", "studio.publish.publish", "studio.publish.history", "studio.publish.offline",
    "studio.artifacts.list", "studio.artifacts.inspect", "studio.service.health", "studio.service.upgrade.status",
  ]);
  assert.deepEqual(calls[1]!.params, { id: "p-1", template: "game", settings: { name: "N" } });
  assert.deepEqual(calls[5]!.params, { project: "p-1", assets: true });
  assert.deepEqual(calls[8]!.params, { project: "p-1", from: "a.ts", to: "b.ts", overwrite: true });
});

test("error mapping keeps the structured code and message", async () => {
  const { host } = fakeHost(() => { throw Object.assign(new Error("file not found (HTTP 404)"), { code: "not_found" }); });
  await assert.rejects(createStudioClient(host).fs.read("p", "a.ts"), (e: unknown) =>
    e instanceof StudioError && e.code === "not_found" && e.capability === "studio.fs.read" && e.message.includes("404"));
  const plain = fakeHost(() => { throw "boom"; });
  await assert.rejects(createStudioClient(plain.host).fs.stat("p", "a"), (e: unknown) => e instanceof StudioError && e.code === "host_error");
});

function chunkServer(file: Uint8Array, tamper = false) {
  const sha = createHash("sha256").update(file).digest("hex");
  return fakeHost(({ capability, params }) => {
    if (capability === "studio.fs.read") throw Object.assign(new Error("too big"), { code: "too_large" });
    assert.equal(capability, "studio.fs.readChunk");
    const length = Math.min(params.length, CHUNK_BYTES);
    const part = file.subarray(params.offset, params.offset + length);
    const data = Buffer.from(part);
    if (tamper && data.length) data[0] = data[0]! ^ 1;
    return { path: params.path, offset: params.offset, length: part.length, totalBytes: file.length, sha256: sha, mtimeMs: 1, data: data.toString("base64") };
  });
}

test("chunked read splits at 128 KiB, reassembles and verifies sha256", async () => {
  const file = new Uint8Array(randomBytes(CHUNK_BYTES * 2 + 777));
  const { host, calls } = chunkServer(file);
  const result = await createStudioClient(host).fs.readBytes("p", "big.bin");
  assert.deepEqual(Array.from(result.bytes), Array.from(file));
  const chunks = calls.filter((c) => c.capability === "studio.fs.readChunk");
  assert.deepEqual(chunks.map((c) => c.params.offset), [0, CHUNK_BYTES, CHUNK_BYTES * 2]);
  assert.ok(chunks.every((c) => c.params.length <= CHUNK_BYTES));
});

test("chunked read rejects corrupted bytes, oversize files and files that change mid-read", async () => {
  const file = new Uint8Array(randomBytes(CHUNK_BYTES + 10));
  await assert.rejects(createStudioClient(chunkServer(file, true).host).fs.readBytes("p", "x"), (e: any) => e.code === "checksum_mismatch");
  await assert.rejects(createStudioClient(chunkServer(file).host).fs.readBytes("p", "x", 100), (e: any) => e.code === "too_large");
  let n = 0;
  const { host } = fakeHost(({ params }) => ({ path: "x", offset: params.offset, length: CHUNK_BYTES, totalBytes: CHUNK_BYTES * 2, sha256: `s${n++}`, mtimeMs: 1, data: base64Encode(new Uint8Array(CHUNK_BYTES)) }));
  await assert.rejects(createStudioClient(host).fs.readBytes("p", "x"), (e: any) => e.code === "conflict");
});

test("readText falls back to chunks only when the small read is too_large", async () => {
  const text = "x".repeat(CHUNK_BYTES + 5) + "你";
  const { host, calls } = chunkServer(utf8Encode(text));
  assert.equal((await createStudioClient(host).fs.readText("p", "a.ts")).text, text);
  assert.equal(calls[0]!.capability, "studio.fs.read");
  const missing = fakeHost(() => { throw Object.assign(new Error("nope"), { code: "not_found" }); });
  await assert.rejects(createStudioClient(missing.host).fs.readText("p", "a.ts"), (e: any) => e.code === "not_found");
  assert.equal(missing.calls.length, 1);
});

test("writeText: small write is one call; large write is a chunked, hashed upload", async () => {
  const small = fakeHost(() => ({ path: "a", bytes: 1, revision: 2 }));
  await createStudioClient(small.host).fs.writeText("p", "a.ts", "hi");
  assert.deepEqual(small.calls.map((c) => c.capability), ["studio.fs.write"]);

  const text = "// big\n" + "é".repeat(300_000);
  const bytes = Buffer.from(text);
  const received: Buffer[] = [];
  const { host, calls } = fakeHost(({ capability, params }) => {
    if (capability === "studio.fs.upload.begin") return { uploadId: "u1", chunkBytes: CHUNK_BYTES };
    if (capability === "studio.fs.upload.chunk") { assert.equal(params.offset, received.reduce((n, b) => n + b.length, 0)); received.push(Buffer.from(params.data, "base64")); return { received: 0, totalBytes: 0 }; }
    if (capability === "studio.fs.upload.commit") return { path: "big.ts", bytes: bytes.length, sha256: createHash("sha256").update(Buffer.concat(received)).digest("hex"), revision: 3 };
    throw new Error(capability);
  });
  const done = await createStudioClient(host).fs.writeText("p", "big.ts", text);
  assert.equal(done.bytes, bytes.length);
  assert.ok(received.every((b) => b.length <= CHUNK_BYTES));
  assert.equal(Buffer.concat(received).toString("utf8"), text);
  assert.equal(calls[0]!.params.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(calls[0]!.params.totalBytes, bytes.length);
});

test("a failed upload chunk aborts the upload and rethrows", async () => {
  const { host, calls } = fakeHost(({ capability }) => {
    if (capability === "studio.fs.upload.begin") return { uploadId: "u9", chunkBytes: CHUNK_BYTES };
    if (capability === "studio.fs.upload.chunk") throw Object.assign(new Error("budget"), { code: "too_many_requests" });
    return {};
  });
  await assert.rejects(createStudioClient(host).fs.writeText("p", "big.ts", "x".repeat(300_000)), (e: any) => e.code === "too_many_requests");
  assert.equal(calls.at(-1)!.capability, "studio.fs.upload.abort");
  assert.equal(calls.at(-1)!.params.uploadId, "u9");
});

test("stream batches are expanded into individual events; gap markers pass through; close cancels", () => {
  let dataListener: (v: any) => void = () => {};
  let cancelled = "";
  let opened: any;
  const streams: StudioStreams = { open(topic, params) { opened = { topic, params }; return {
    onData(l) { dataListener = l; return () => {}; }, onError: () => () => {}, onEnd: () => () => {}, cancel(r) { cancelled = r ?? ""; },
  }; } };
  const c = createStudioClient(fakeHost(() => ({})).host, streams);
  const seen: any[] = [];
  const sub = c.fs.watch("p-1", (e) => seen.push(e));
  dataListener({ events: [{ type: "ready", revision: 1 }, { type: "gap", dropped: 4 }] });
  dataListener({ events: [{ type: "change", path: "a.ts", kind: "file", event: "change" }] });
  dataListener({ nonsense: true });
  assert.deepEqual(seen.map((e) => e.type), ["ready", "gap", "change"]);
  assert.deepEqual(opened, { topic: "studio.fs.watch", params: { project: "p-1" } });
  sub.close();
  assert.ok(cancelled);
  assert.throws(() => createStudioClient(fakeHost(() => ({})).host).build.events("p", () => {}), (e: any) => e.code === "streams_unavailable");
});

test("guest manifest declares exactly the capabilities the Dart provider registers", () => {
  const dart = readFileSync(join(import.meta.dir, "../../../sdk/packages/pocket_studio/lib/src/studio_routes.dart"), "utf8");
  const names = [...dart.matchAll(/StudioCall\(\s*'(studio\.[A-Za-z.]+)'/g)].map((m) => m[1]!).sort();
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../manifest.json"), "utf8"));
  const declared = (manifest.capabilities.optional as string[]).filter((n) => n.startsWith("studio.")).sort();
  assert.deepEqual(declared, names);
  assert.ok(names.length >= 37);
});
