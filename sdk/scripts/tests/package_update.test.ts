import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import {
  packageArtifacts,
  generateDevKey,
  parsePakLayout,
  sha256Hex,
  verifySignedManifest,
  writePublicKeyConfig,
  type PocketUpdatePayload,
} from "../package_update.ts";
import { adbReverseCommand, serveUpdates } from "../serve_updates.ts";

const root = resolve(import.meta.dir, "../..");
const fixtureKey = resolve(import.meta.dir, "fixtures/pocket-package/test-ed25519.json");

test("dev key exports raw32 public key and a public-only Dart config", () => {
  const dir = tempDirectory();
  try {
    const privatePath = join(dir, "dev-key.json");
    const publicPath = join(dir, "public-config.json");
    const generated = generateDevKey(privatePath, "fixture-generated");
    writePublicKeyConfig(publicPath, { keyId: generated.keyId, publicKeyBase64: generated.publicKeyBase64 });
    const key = JSON.parse(readFileSync(privatePath, "utf8")) as Record<string, string>;
    const publicConfig = JSON.parse(readFileSync(publicPath, "utf8")) as Record<string, string>;
    expect(Buffer.from(key.publicKeyBase64, "base64")).toHaveLength(32);
    expect(key.publicKeyBase64).toBe(generated.publicKeyBase64);
    expect(publicConfig).toEqual({ keyId: "fixture-generated", publicKeyBase64: generated.publicKeyBase64 });
    expect(publicConfig.privateKeyPem).toBeUndefined();
    const der = Buffer.from(createPublicKey(key.publicKeyPem).export({ type: "spki", format: "der" }));
    expect(key.publicKeyBase64).toBe(der.subarray(-32).toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pocket-package-test-"));
}

function writeFixture(dir: string, secondImage: number): { js: string; pak: string; sourcePak: Uint8Array } {
  mkdirSync(dir, { recursive: true });
  const js = join(dir, "app.js");
  const pak = join(dir, "app.pak");
  writeFileSync(js, "globalThis.frame=()=>{};\n");
  const sourcePak = pack([
    { key: "ui:img.alpha", dtype: 0, data: new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]) },
    { key: "ui:img.beta", dtype: 0, data: new Uint8Array([secondImage, 16, 32, 255, 64, 96, 128, 255]) },
  ]);
  writeFileSync(pak, sourcePak);
  return { js, pak, sourcePak };
}

function reconstruct(outDir: string, payload: PocketUpdatePayload): Uint8Array {
  const result = new Uint8Array(payload.pak.size);
  for (const part of payload.pak.parts) {
    const file = payload.files.find((candidate) => candidate.sha256 === part.sha256);
    expect(file).toBeDefined();
    expect(file!.size).toBe(part.size);
    const bytes = new Uint8Array(readFileSync(join(outDir, file!.url)));
    expect(bytes.byteLength).toBe(part.size);
    expect(sha256Hex(bytes)).toBe(part.sha256);
    result.set(bytes, part.offset);
  }
  return result;
}

test("package emits signed exact payload and PAK parts reconstruct byte-for-byte", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(dir, 10);
    const out = join(dir, "v1");
    const result = packageArtifacts({
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, outDir: out, keyFile: fixtureKey,
    });
    expect(result.payload.schemaVersion).toBe(1);
    expect(result.payload.entry.size).toBe(readFileSync(input.js).byteLength);
    expect(result.payload.pak.sha256).toBe(sha256Hex(input.sourcePak));
    expect(result.payload.pak.parts[0].offset).toBe(0);
    expect(result.payload.pak.parts.at(-1)!.offset + result.payload.pak.parts.at(-1)!.size).toBe(input.sourcePak.byteLength);
    expect(new Set(result.payload.files.map((file) => file.sha256)).size).toBe(result.payload.files.length);

    const payloadBytes = new Uint8Array(readFileSync(join(out, "payload.json")));
    expect([...payloadBytes]).toEqual([...result.payloadBytes]);
    const envelope = JSON.parse(readFileSync(join(out, "signed-manifest.json"), "utf8"));
    expect([...verifySignedManifest(envelope, JSON.parse(readFileSync(fixtureKey, "utf8")).publicKeyPem)]).toEqual([...payloadBytes]);
    expect(new TextDecoder().decode(payloadBytes)).toBe(JSON.stringify(result.payload));
    expect([...reconstruct(out, result.payload)]).toEqual([...input.sourcePak]);

    // The pack contains directory/name bytes and alignment bytes in addition
    // to entry data; these are explicit metadata parts, not fixed chunks.
    expect(result.pakParts.some((part) => part.kind === "metadata")).toBe(true);
    expect(result.pakParts.some((part) => part.kind === "blob")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed entry produces one new content blob while unchanged content is reused", () => {
  const dir = tempDirectory();
  try {
    const first = writeFixture(join(dir, "first"), 10);
    const second = writeFixture(join(dir, "second"), 11);
    const firstResult = packageArtifacts({
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: first.js, pakPath: first.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
    });
    const secondResult = packageArtifacts({
      appId: "fixture-app", version: "1.0.1", build: 2,
      jsPath: second.js, pakPath: second.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
    });
    const firstHashes = new Set(firstResult.payload.files.map((file) => file.sha256));
    const secondHashes = new Set(secondResult.payload.files.map((file) => file.sha256));
    const added = [...secondHashes].filter((hash) => !firstHashes.has(hash));
    expect(added).toHaveLength(1);
    expect([...firstHashes].filter((hash) => secondHashes.has(hash)).length).toBe(firstHashes.size - 1);
    expect(secondResult.payload.pak.sha256).not.toBe(firstResult.payload.pak.sha256);
    expect([...reconstruct(join(dir, "out"), secondResult.payload)]).toEqual([...second.sourcePak]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("optional external assets publish safe logical names and reuse content blobs", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const assetsV1 = join(dir, "assets-v1");
    mkdirSync(join(assetsV1, "images"), { recursive: true });
    writeFileSync(join(assetsV1, "video.mp4"), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(assetsV1, "images", "poster.png"), Buffer.from([9, 8, 7]));

    const first = packageArtifacts({
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
      assetDir: assetsV1, assetPrefix: "assets",
    });
    expect(first.payload.assets).toEqual({
      "assets/images/poster.png": { sha256: sha256Hex(new Uint8Array([9, 8, 7])), size: 3 },
      "assets/video.mp4": { sha256: sha256Hex(new Uint8Array([1, 2, 3, 4])), size: 4 },
    });
    for (const asset of Object.values(first.payload.assets!)) {
      expect(first.payload.files.find((file) => file.sha256 === asset.sha256)?.size).toBe(asset.size);
    }

    const assetsV2 = join(dir, "assets-v2");
    mkdirSync(join(assetsV2, "images"), { recursive: true });
    writeFileSync(join(assetsV2, "video.mp4"), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(assetsV2, "images", "poster.png"), Buffer.from([6, 5, 4]));
    const second = packageArtifacts({
      appId: "fixture-app", version: "1.0.1", build: 2,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
      assetDir: assetsV2, assetPrefix: "assets",
    });
    const firstHashes = new Set(first.payload.files.map((file) => file.sha256));
    const secondHashes = new Set(second.payload.files.map((file) => file.sha256));
    expect([...secondHashes].filter((hash) => !firstHashes.has(hash))).toHaveLength(1);
    expect(second.payload.assets?.["assets/video.mp4"]?.sha256).toBe(first.payload.assets?.["assets/video.mp4"]?.sha256);
    expect(second.payload.assets?.["assets/images/poster.png"]?.sha256).not.toBe(first.payload.assets?.["assets/images/poster.png"]?.sha256);

    const withoutAssets = packageArtifacts({
      appId: "fixture-app", version: "1.0.2", build: 3,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "without-assets"), keyFile: fixtureKey,
    });
    expect(withoutAssets.payload.assets).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("external assets reject traversal prefixes, symlinks, and a prefix without a directory", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const assets = join(dir, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "demo.mp4"), Buffer.from([1]));
    const base = {
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
    };
    expect(() => packageArtifacts({ ...base, assetDir: assets, assetPrefix: "../outside" })).toThrow(/safe relative path/);
    expect(() => packageArtifacts({ ...base, assetDir: assets, assetPrefix: "/outside" })).toThrow(/safe relative path/);
    expect(() => packageArtifacts({ ...base, assetPrefix: "assets" })).toThrow(/requires asset-dir/);

    const outside = join(dir, "outside.mp4");
    writeFileSync(outside, Buffer.from([2]));
    symlinkSync(outside, join(assets, "link.mp4"));
    expect(() => packageArtifacts({ ...base, assetDir: assets, assetPrefix: "assets" })).toThrow(/unsupported symlink/);
    unlinkSync(join(assets, "link.mp4"));
    writeFileSync(join(assets, "provider.dylib"), Buffer.from([3]));
    expect(() => packageArtifacts({ ...base, assetDir: assets, assetPrefix: "assets" })).toThrow(/remote native code/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("layout rejects truncation and does not silently omit an entry range", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(dir, 10);
    const parts = parsePakLayout(input.sourcePak);
    expect(parts.filter((part) => part.kind === "blob")).toHaveLength(2);
    expect(() => parsePakLayout(input.sourcePak.subarray(0, input.sourcePak.length - 1))).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local update server serves latest, direct manifest and content-addressed blobs", async () => {
  const dir = tempDirectory();
  let server: ReturnType<typeof serveUpdates> | undefined;
  try {
    const input = writeFixture(dir, 10);
    const out = join(dir, "out");
    const result = packageArtifacts({
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, outDir: out, keyFile: fixtureKey,
    });
    writeFileSync(join(out, "private-key.json"), "must not be public");
    const outside = join(dir, "outside-secret");
    writeFileSync(outside, "must not be public");
    symlinkSync(outside, join(out, "blobs", "f".repeat(64)));
    server = serveUpdates({ rootDir: out, port: 0 });
    const base = String(server.url).replace(/\/$/, "");
    const latest = await fetch(`${base}/latest.json`);
    const direct = await fetch(`${base}/signed-manifest.json`);
    expect(latest.status).toBe(200);
    expect(await latest.text()).toBe(await direct.text());
    const blob = await fetch(`${base}/${result.payload.files[0].url}`);
    expect(blob.status).toBe(200);
    expect(new Uint8Array(await blob.arrayBuffer()).byteLength).toBe(result.payload.files[0].size);
    expect((await fetch(`${base}/does-not-exist`)).status).toBe(404);
    expect((await fetch(`${base}/private-key.json`)).status).toBe(404);
    expect((await fetch(`${base}/blobs/not-a-sha`)).status).toBe(404);
    expect((await fetch(`${base}/blobs/${"f".repeat(64)}`)).status).toBe(404);
  } finally {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package signs real QuickJS bytecode metadata and guest declaration", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(dir, 10);
    const bytecode = join(dir, "app.qjbc");
    const guestManifest = join(dir, "guest-manifest.json");
    writeFileSync(bytecode, Buffer.from([0x51, 0x4a, 0x53, 0x42, 1, 2, 3]));
    writeFileSync(guestManifest, JSON.stringify({
      capabilities: { requires: ["text.glyphs.baked"], optional: ["runtime.info"] },
      permissions: { optional: ["network"] },
    }));
    const result = packageArtifacts({
      appId: "fixture-app", version: "2.0.0", build: 2,
      bytecodePath: bytecode, entryFormat: "quickjs-bytecode", runtimeAbi: "quickjs-test-abi",
      pakPath: input.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
      guestManifestPath: guestManifest,
    });
    expect(result.payload.entryFormat).toBe("quickjs-bytecode");
    expect(result.payload.runtimeAbi).toBe("quickjs-test-abi");
    expect(result.payload.capabilities).toEqual({ requires: ["text.glyphs.baked"], optional: ["runtime.info"] });
    expect(result.payload.permissions).toEqual({ requires: [], optional: ["network"] });
    const envelope = JSON.parse(readFileSync(join(dir, "out", "signed-manifest.json"), "utf8"));
    expect(new TextDecoder().decode(verifySignedManifest(envelope, JSON.parse(readFileSync(fixtureKey, "utf8")).publicKeyPem)))
      .toBe(JSON.stringify(result.payload));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bytecode packaging requires an ABI and rejects source/bytecode ambiguity", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(dir, 10);
    const bytecode = join(dir, "app.qjbc");
    writeFileSync(bytecode, Buffer.from([1, 2, 3]));
    const base = {
      appId: "fixture-app", version: "2.0.0", build: 2, pakPath: input.pak,
      outDir: join(dir, "out"), keyFile: fixtureKey, bytecodePath: bytecode,
      entryFormat: "quickjs-bytecode" as const,
    };
    expect(() => packageArtifacts(base)).toThrow(/runtime-abi/);
    expect(() => packageArtifacts({ ...base, runtimeAbi: "abi", jsPath: input.js, entryFormat: "javascript" })).toThrow(/--bytecode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adb reverse requires an explicit selected serial", () => {
  expect(adbReverseCommand(8787, "emulator-5580")).toEqual([
    "adb", "-s", "emulator-5580", "reverse", "tcp:8787", "tcp:8787",
  ]);
  expect(() => adbReverseCommand(8787)).toThrow(/--device\/-s/);
});



test("signed worker bytes/declaration survive publication and tampering is rejected", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const entry = join(dir, "input", "app.qjbc");
    writeFileSync(entry, Buffer.from("PJBC-ui-fixture"));
    const bytes = Buffer.concat([Buffer.from("PJBC"), Buffer.alloc(128, 7)]);
    writeFileSync(join(dir, "input", "app.worker.qjbc"), bytes);
    const worker = {kind:"quickjs-bytecode", protocolVersion:1, runtimeAbi:"fixture-abi", bindingGeneration:12, tickHz:60,
      bytecode:{path:"app.worker.qjbc",bytes:bytes.length,sha256:sha256Hex(bytes)},
      declaration:{entry:"worker.ts",nodes:[],channels:[]},requiredCaps:["runtime.worker"]};
    const manifest = join(dir, "input", "guest-manifest.json");
    writeFileSync(manifest, JSON.stringify({worker,capabilities:{requires:["runtime.worker"],optional:[]}}));
    const options = {appId:"fixture-app",version:"1.0.0",build:1,bytecodePath:entry,runtimeAbi:"fixture-abi",
      pakPath:input.pak,outDir:join(dir,"out"),keyFile:fixtureKey,guestManifestPath:manifest};
    const result = packageArtifacts(options);
    expect(result.payload.worker).toEqual(worker);
    expect(result.payload.assets?.["app.worker.qjbc"]).toEqual({sha256:sha256Hex(bytes),size:bytes.length});
    expect(result.payload.files.some(f=>f.sha256===sha256Hex(bytes))).toBe(true);
    writeFileSync(join(dir, "input", "app.worker.qjbc"), Buffer.alloc(bytes.length, 1));
    expect(()=>packageArtifacts(options)).toThrow("worker bytecode integrity mismatch");
    writeFileSync(manifest,JSON.stringify({capabilities:{requires:["runtime.worker"]}}));
    expect(()=>packageArtifacts(options)).toThrow("without its signed descriptor");
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
