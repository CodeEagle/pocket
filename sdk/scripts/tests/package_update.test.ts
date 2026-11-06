import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import {
  create7zArchive,
  createZipArchive,
  extract7zArchive,
  extractBundleArchive,
  extractZipArchive,
  packPak,
  packageArtifacts,
  pocketReleaseDirectory,
  patchPackageArtifacts,
  unpackPak,
  generateDevKey,
  parsePakLayout,
  sha256Hex,
  signTrustPolicy,
  verifySignedTrustPolicy,
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

test("root trust policy signs exact payload bytes", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    schemaVersion: 1 as const,
    epoch: 7,
    releaseKeys: [{
      keyId: "release-a",
      publicKeyBase64: Buffer.alloc(32, 9).toString("base64"),
      appScope: ["fixture-app"],
      notBefore: 1_700_000_000,
      notAfter: 1_800_000_000,
    }],
    revokedKeys: [],
    revokedPackages: [],
  };
  const envelope = signTrustPolicy(payload, { keyId: "root-a", privateKey });
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  expect([...verifySignedTrustPolicy(envelope, publicKey.export({ type: "spki", format: "pem" }))]).toEqual([...payloadBytes]);
  const tampered = {
    ...envelope,
    payload: Buffer.from(`${JSON.stringify(payload)} `).toString("base64"),
  };
  expect(() => verifySignedTrustPolicy(tampered, publicKey.export({ type: "spki", format: "pem" }))).toThrow("invalid Ed25519 signature");
});

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pocket-package-test-"));
}

test("canonical deployment layout scopes releases by host, package, and package version", () => {
  const root = tempDirectory();
  try {
    const prefixedRoot = join(root, "some-other-path");
    expect(
      pocketReleaseDirectory(prefixedRoot, "3.2.0", "com.example.notes", "1.4.7"),
    ).toBe(join(root, "some-other-path", "pocket", "3.2.0", "com.example.notes", "1.4.7"));
    expect(() => pocketReleaseDirectory(root, "../host", "app", "1.0.0")).toThrow("invalid host version");
    expect(() => pocketReleaseDirectory(root, "3.2.0", "bad/app", "1.0.0")).toThrow("invalid package ID");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    expect(result.payload.memory).toBeUndefined();
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

test("package preserves validated guest memory in the signed payload, including nested declarations", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const keyPath = join(dir, "generated-key.json");
    const generated = generateDevKey(keyPath, "memory-payload-test");
    const guestManifest = join(dir, "input", "guest-manifest.json");
    const memory = { heapLimitBytes: 128 * 1024, maxPakBytes: 8 * 1024 * 1024 };
    writeFileSync(guestManifest, JSON.stringify({ memory }));
    const result = packageArtifacts({
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "out"), keyFile: keyPath,
      guestManifestPath: guestManifest,
    });
    expect(result.payload.memory).toEqual(memory);
    expect(JSON.parse(readFileSync(join(dir, "out", "payload.json"), "utf8")).memory).toEqual(memory);
    const envelope = JSON.parse(readFileSync(join(dir, "out", "signed-manifest.json"), "utf8"));
    expect([...verifySignedManifest(envelope, generated.publicKeyPem)]).toEqual([...result.payloadBytes]);

    writeFileSync(guestManifest, JSON.stringify({ guest: { memory: { maxPakBytes: 1 } } }));
    const nested = packageArtifacts({
      appId: "fixture-app", version: "1.0.1", build: 2,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "nested-out"), keyFile: keyPath,
      guestManifestPath: guestManifest,
    });
    expect(nested.payload.memory).toEqual({ maxPakBytes: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package rejects malformed guest memory declarations", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const keyPath = join(dir, "generated-key.json");
    generateDevKey(keyPath, "memory-validation-test");
    const guestManifest = join(dir, "input", "guest-manifest.json");
    let outputIndex = 0;
    const expectInvalid = (memory: unknown, nested = false): void => {
      writeFileSync(guestManifest, JSON.stringify(nested ? { guest: { memory } } : { memory }));
      expect(() => packageArtifacts({
        appId: "fixture-app", version: "1.0.0", build: 1,
        jsPath: input.js, pakPath: input.pak, outDir: join(dir, `out-${outputIndex++}`), keyFile: keyPath,
        guestManifestPath: guestManifest,
      })).toThrow(/package: memory/);
    };

    expectInvalid(null);
    expectInvalid({ heapLimitBytes: 0 });
    expectInvalid({ heapLimitBytes: -1 });
    expectInvalid({ heapLimitBytes: 2 * 1024 * 1024 * 1024 + 1 });
    expectInvalid({ heapLimitBytes: 64 * 1024 + 0.5 });
    expectInvalid({ maxPakBytes: null });
    expectInvalid({ maxPakBytes: 0 });
    expectInvalid({ maxPakBytes: 512 * 1024 * 1024 + 1 });
    expectInvalid({ gcThreshold: 2 });
    expectInvalid({ maxPakBytes: "8MiB" }, true);
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

test("package emits verified bundle.7z by default (and supports bundle.zip) and serveUpdates serves both", async () => {
  const dir = tempDirectory();
  let server: ReturnType<typeof serveUpdates> | undefined;
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const assetsDir = join(dir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "banner.bin"), Buffer.from([10, 20, 30, 40, 50]));
    const out = join(dir, "out");
    const result = packageArtifacts({
      appId: "fixture-app",
      version: "1.0.0",
      build: 1,
      jsPath: input.js,
      pakPath: input.pak,
      outDir: out,
      keyFile: fixtureKey,
      assetDir: assetsDir,
      assetPrefix: "assets",
    });

    expect(result.payload.bundle).toBeDefined();
    expect(result.payload.bundle?.format).toBe("7z");
    expect(result.payload.bundle?.url).toBe(`bundles/bundle-${result.payload.bundle!.sha256}.7z`);

    server = serveUpdates({ rootDir: out, port: 0 });
    const base = String(server.url).replace(/\/$/, "");
    const immutableRes = await fetch(`${base}/${result.payload.bundle!.url}`);
    expect(immutableRes.status).toBe(200);
    expect(immutableRes.headers.get("Content-Type")).toBe("application/x-7z-compressed");
    expect(immutableRes.headers.get("Cache-Control")).toContain("immutable");
    const bundleRes = await fetch(`${base}/bundle.7z`);
    expect(bundleRes.status).toBe(200);
    expect(bundleRes.headers.get("Content-Type")).toBe("application/x-7z-compressed");
    const sevenZipBytes = new Uint8Array(await immutableRes.arrayBuffer());
    expect(sevenZipBytes.byteLength).toBe(result.payload.bundle!.size);
    expect(sha256Hex(sevenZipBytes)).toBe(result.payload.bundle!.sha256);

    const extracted = extract7zArchive(sevenZipBytes);
    for (const file of result.payload.files) {
      const entry = extracted.get(file.url);
      expect(entry).toBeDefined();
      expect(entry!.byteLength).toBe(file.size);
      expect(sha256Hex(entry!)).toBe(file.sha256);
    }

    // Verify built-in 7z encoder (useCli: false) and 7z CLI encoder both roundtrip through extractBundleArchive
    const builtin7z = create7zArchive(extracted, { useCli: false });
    const extractedFromBuiltin = extractBundleArchive(builtin7z, undefined, "7z");
    expect(extractedFromBuiltin.size).toBe(extracted.size);
    for (const [key, val] of extracted.entries()) {
      expect([...(extractedFromBuiltin.get(key) ?? [])]).toEqual([...val]);
    }

    // Verify backward-compatible ZIP format option
    const outZip = join(dir, "out-zip");
    const zipResult = packageArtifacts({
      appId: "fixture-app",
      version: "1.0.0",
      build: 1,
      jsPath: input.js,
      pakPath: input.pak,
      outDir: outZip,
      keyFile: fixtureKey,
      assetDir: assetsDir,
      assetPrefix: "assets",
      bundleFormat: "zip",
    });
    expect(zipResult.payload.bundle?.format).toBe("zip");
    expect(zipResult.payload.bundle?.url).toBe(`bundles/bundle-${zipResult.payload.bundle!.sha256}.zip`);
    const extractedZip = extractZipArchive(new Uint8Array(readFileSync(zipResult.bundlePath!)));
    expect(extractedZip.size).toBe(zipResult.payload.files.length);
  } finally {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("network placement omits selected blobs from the bootstrap archive but preserves canonical PAK reconstruction", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const assets = join(dir, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "network.bin"), Buffer.from([91, 92, 93]));
    writeFileSync(join(assets, "bundled.bin"), Buffer.from([101, 102, 103]));

    const base = {
      appId: "fixture-app",
      version: "1.0.0",
      build: 1,
      jsPath: input.js,
      pakPath: input.pak,
      keyFile: fixtureKey,
      assetDir: assets,
      assetPrefix: "assets",
      bundleFormat: "zip" as const,
    };
    const full = packageArtifacts({ ...base, outDir: join(dir, "full"), signedAt: 1 });
    const emptySelection = packageArtifacts({
      ...base,
      outDir: join(dir, "empty-selection"),
      signedAt: 1,
      networkPakKeys: [],
      networkAssets: [],
    });
    expect(emptySelection.payload.bundle?.blobs).toBeUndefined();
    expect(readFileSync(emptySelection.bundlePath!)).toEqual(readFileSync(full.bundlePath!));
    expect(emptySelection.payload.bundle).toEqual(full.payload.bundle);

    const selected = packageArtifacts({
      ...base,
      outDir: join(dir, "selected"),
      signedAt: 1,
      networkPakKeys: ["ui:img.alpha"],
      networkAssets: ["assets/network.bin"],
    });
    expect(selected.payload.pak).toEqual(full.payload.pak);
    expect(selected.payload.pak.sha256).toBe(sha256Hex(input.sourcePak));
    expect(selected.payload.files.map((file) => file.sha256)).toEqual(full.payload.files.map((file) => file.sha256));

    const alphaHash = selected.payload.pak.parts.find((part) => part.key === "ui:img.alpha")!.sha256;
    const networkAssetHash = selected.payload.assets!["assets/network.bin"].sha256;
    const included = new Set(selected.payload.bundle!.blobs);
    expect(included.has(alphaHash)).toBe(false);
    expect(included.has(networkAssetHash)).toBe(false);
    expect(selected.payload.bundle!.blobs).toEqual([...included].sort());

    const archive = extractZipArchive(new Uint8Array(readFileSync(selected.bundlePath!)));
    expect(archive.has(`blobs/${alphaHash}`)).toBe(false);
    expect(archive.has(`blobs/${networkAssetHash}`)).toBe(false);
    expect(archive.size).toBe(included.size);
    for (const file of selected.payload.files) {
      const entry = archive.get(file.url);
      if (included.has(file.sha256)) {
        expect(entry).toBeDefined();
        expect(sha256Hex(entry!)).toBe(file.sha256);
      } else {
        expect(entry).toBeUndefined();
      }
    }
    expect([...reconstruct(join(dir, "selected"), selected.payload)]).toEqual([...input.sourcePak]);

    const tampered = new Uint8Array(readFileSync(selected.bundlePath!));
    tampered[0] ^= 0xff;
    expect(() => extractZipArchive(tampered)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("network placement validates logical selections and locks non-image PAK entries", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const lockedPak = packPak([
      ...[{ key: "ui:img.alpha", dtype: 0, data: new Uint8Array([1, 2, 3]) },
        { key: "ui:font.required", dtype: 0, data: new Uint8Array([4, 5, 6]) },
        { key: "ui:img.beta", dtype: 0, data: new Uint8Array([7, 8, 9]) }],
    ]);
    writeFileSync(input.pak, lockedPak);
    const base = {
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, keyFile: fixtureKey,
      outDir: join(dir, "out"), bundleFormat: "zip" as const,
    };
    expect(() => packageArtifacts({ ...base, networkPakKeys: ["ui:font.required"] })).toThrow(/only ui:img/);
    expect(() => packageArtifacts({ ...base, networkPakKeys: ["ui:img.missing"] })).toThrow(/was not found/);
    expect(() => packageArtifacts({ ...base, networkPakKeys: ["ui:img.alpha", "ui:img.alpha"] })).toThrow(/duplicate network PAK key/);

    const assets = join(dir, "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "known.bin"), Buffer.from([10]));
    const withAssets = { ...base, assetDir: assets, assetPrefix: "assets", outDir: join(dir, "asset-out") };
    expect(() => packageArtifacts({ ...withAssets, networkAssets: ["assets/missing.bin"] })).toThrow(/network asset assets\/missing.bin was not found/);
    expect(() => packageArtifacts({ ...withAssets, networkAssets: ["../known.bin"] })).toThrow(/asset path is not safe/);
    expect(() => packageArtifacts({ ...withAssets, networkAssets: ["assets/known.bin", "assets/known.bin"] })).toThrow(/duplicate network asset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("network selection keeps a selected image blob when its hash is required by the entry", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const alpha = unpackPak(input.sourcePak).find((blob) => blob.key === "ui:img.alpha")!.data;
    writeFileSync(input.js, alpha);
    const result = packageArtifacts({
      appId: "fixture-app", version: "1.0.0", build: 1,
      jsPath: input.js, pakPath: input.pak, outDir: join(dir, "out"), keyFile: fixtureKey,
      bundleFormat: "zip",
      networkPakKeys: ["ui:img.alpha"],
    });
    expect(result.payload.entry.sha256).toBe(sha256Hex(alpha));
    expect(result.payload.bundle?.blobs).toBeUndefined();
    const archive = extractZipArchive(new Uint8Array(readFileSync(result.bundlePath!)));
    expect(archive.size).toBe(result.payload.files.length);
    expect(archive.has(`blobs/${result.payload.entry.sha256}`)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("patchPackageArtifacts supports granular code-only, single PAK resource, and single loose asset updates", () => {
  const dir = tempDirectory();
  try {
    const input = writeFixture(join(dir, "input"), 10);
    const assetsDir = join(dir, "assets");
    mkdirSync(join(assetsDir, "images"), { recursive: true });
    writeFileSync(join(assetsDir, "video.mp4"), Buffer.from([1, 2, 3, 4]));
    writeFileSync(join(assetsDir, "images", "poster.png"), Buffer.from([9, 8, 7]));

    const v1Dir = join(dir, "v1");
    const v1 = packageArtifacts({
      appId: "fixture-app",
      version: "1.0.0",
      build: 1,
      jsPath: input.js,
      pakPath: input.pak,
      outDir: v1Dir,
      keyFile: fixtureKey,
      assetDir: assetsDir,
      assetPrefix: "assets",
    });
    const v1FileSet = new Set(v1.payload.files.map((f) => f.sha256));

    // 1. Code-only update: PAK and all assets are reused unchanged
    const updatedJs = join(dir, "app-v2.js");
    writeFileSync(updatedJs, "globalThis.frame=()=>{return 2;};\n");
    const v2Dir = join(dir, "v2-code");
    const v2 = patchPackageArtifacts({
      baseDir: v1Dir,
      outDir: v2Dir,
      version: "1.0.1",
      build: 2,
      keyFile: fixtureKey,
      jsPath: updatedJs,
    });
    expect(v2.payload.entry.sha256).not.toBe(v1.payload.entry.sha256);
    expect(v2.payload.pak.sha256).toBe(v1.payload.pak.sha256);
    expect(v2.payload.assets).toEqual(v1.payload.assets);
    const v2Added = v2.payload.files.filter((f) => !v1FileSet.has(f.sha256));
    expect(v2Added.map((f) => f.sha256)).toEqual([v2.payload.entry.sha256]);

    // 2. Single PAK resource update ("ui:img.beta"): code, assets, and "ui:img.alpha" blob are reused
    const v2FileSet = new Set(v2.payload.files.map((f) => f.sha256));
    const v3Dir = join(dir, "v3-pak-resource");
    const v3 = patchPackageArtifacts({
      baseDir: v2Dir,
      outDir: v3Dir,
      version: "1.0.2",
      build: 3,
      keyFile: fixtureKey,
      replacePakEntries: {
        "ui:img.beta": new Uint8Array([99, 16, 32, 255, 64, 96, 128, 255]),
      },
    });
    expect(v3.payload.entry.sha256).toBe(v2.payload.entry.sha256);
    expect(v3.payload.assets).toEqual(v2.payload.assets);
    const alphaV2 = v2.payload.pak.parts.find((p) => p.key === "ui:img.alpha");
    const alphaV3 = v3.payload.pak.parts.find((p) => p.key === "ui:img.alpha");
    const betaV2 = v2.payload.pak.parts.find((p) => p.key === "ui:img.beta");
    const betaV3 = v3.payload.pak.parts.find((p) => p.key === "ui:img.beta");
    expect(alphaV3?.sha256).toBe(alphaV2?.sha256);
    expect(betaV3?.sha256).not.toBe(betaV2?.sha256);
    const v3Added = v3.payload.files.filter((f) => !v2FileSet.has(f.sha256));
    expect(v3Added).toHaveLength(1);
    expect(v3Added[0].sha256).toBe(betaV3?.sha256);

    // 3. Single external asset update ("assets/images/poster.png"): code, PAK, and "assets/video.mp4" are reused
    const v3FileSet = new Set(v3.payload.files.map((f) => f.sha256));
    const v4Dir = join(dir, "v4-asset-resource");
    const v4 = patchPackageArtifacts({
      baseDir: v3Dir,
      outDir: v4Dir,
      version: "1.0.3",
      build: 4,
      keyFile: fixtureKey,
      replaceAssets: {
        "assets/images/poster.png": new Uint8Array([42, 43, 44, 45]),
      },
    });
    expect(v4.payload.entry.sha256).toBe(v3.payload.entry.sha256);
    expect(v4.payload.pak.sha256).toBe(v3.payload.pak.sha256);
    expect(v4.payload.assets?.["assets/video.mp4"]).toEqual(v3.payload.assets?.["assets/video.mp4"]);
    expect(v4.payload.assets?.["assets/images/poster.png"]?.sha256).not.toBe(
      v3.payload.assets?.["assets/images/poster.png"]?.sha256,
    );
    const v4Added = v4.payload.files.filter((f) => !v3FileSet.has(f.sha256));
    expect(v4Added).toHaveLength(1);
    expect(v4Added[0].sha256).toBe(v4.payload.assets?.["assets/images/poster.png"]?.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-place patching preserves content-addressed bundles and enforces PAK/ZIP/worker invariants", async () => {
  const dir = tempDirectory();
  let server: ReturnType<typeof serveUpdates> | undefined;
  try {
    // 1. ZIP encoder rejects normalized duplicates and >65535-byte entry names
    expect(() =>
      createZipArchive({
        "a\\b": new Uint8Array([1]),
        "a/b": new Uint8Array([2]),
      }),
    ).toThrow(/duplicate entry a\/b/);
    expect(() =>
      createZipArchive({
        ["k".repeat(65536)]: new Uint8Array([1]),
      }),
    ).toThrow(/exceeds 65535 bytes/);

    // 2. packPak / parsePakLayout enforce 1..65535 UTF-8 key lengths, non-empty data, unique keys, and non-aliased ranges
    const maxKey = "k".repeat(65535);
    const validMaxPak = packPak([{ key: maxKey, dtype: 3, data: new Uint8Array([1, 2, 3]) }]);
    const parsedMax = parsePakLayout(validMaxPak).find((p) => p.kind === "blob");
    expect(parsedMax?.key).toBe(maxKey);
    expect(parsedMax?.dtype).toBe(3);

    expect(() => packPak([{ key: "k".repeat(65536), dtype: 0, data: new Uint8Array([1]) }])).toThrow(/1\.\.65535/);
    expect(() => packPak([{ key: "empty", dtype: 0, data: new Uint8Array(0) }])).toThrow(/must not be empty/);
    expect(() => packPak([{ key: " trailing ", dtype: 0, data: new Uint8Array([1]) }])).toThrow(/invalid key/);

    // Craft a PAK with two directory entries aliasing the same blob range -> parsePakLayout must reject
    const twoEntryPak = new Uint8Array(packPak([
      { key: "alpha", dtype: 0, data: new Uint8Array([1, 2, 3, 4]) },
      { key: "beta", dtype: 0, data: new Uint8Array([5, 6, 7, 8]) },
    ]));
    const pakView = new DataView(twoEntryPak.buffer, twoEntryPak.byteOffset, twoEntryPak.byteLength);
    // Point entry 1's blobOffset and blobSize to entry 0's range
    pakView.setUint32(32 + 24 + 4, pakView.getUint32(32 + 4, true), true);
    pakView.setUint32(32 + 24 + 8, pakView.getUint32(32 + 8, true), true);
    expect(() => parsePakLayout(twoEntryPak)).toThrow(/overlapping or aliased/);

    // 3. In-place patching retains v1's content-addressed bundle while publishing v2's bundle
    const input = writeFixture(join(dir, "input"), 10);
    const entry = join(dir, "input", "app.qjbc");
    writeFileSync(entry, Buffer.from("PJBC-ui-v1"));
    const workerBytesV1 = Buffer.concat([Buffer.from("PJBC"), Buffer.alloc(128, 7)]);
    writeFileSync(join(dir, "input", "app.worker.qjbc"), workerBytesV1);
    const workerV1 = {
      kind: "quickjs-bytecode",
      protocolVersion: 1,
      runtimeAbi: "fixture-abi",
      bindingGeneration: 12,
      tickHz: 60,
      bytecode: { path: "app.worker.qjbc", bytes: workerBytesV1.length, sha256: sha256Hex(workerBytesV1) },
      declaration: { entry: "worker.ts", nodes: [], channels: [] },
      requiredCaps: ["runtime.worker"],
    };
    const guestPath = join(dir, "input", "guest-manifest.json");
    writeFileSync(guestPath, JSON.stringify({ worker: workerV1, capabilities: { requires: ["runtime.worker"], optional: [] } }));

    const servedDir = join(dir, "served");
    const v1 = packageArtifacts({
      appId: "fixture-app",
      version: "1.0.0",
      build: 1,
      bytecodePath: entry,
      runtimeAbi: "fixture-abi",
      pakPath: input.pak,
      outDir: servedDir,
      keyFile: fixtureKey,
      guestManifestPath: guestPath,
    });

    // Reject removing or replacing active worker asset without updating worker descriptor
    expect(() =>
      patchPackageArtifacts({
        baseDir: servedDir,
        outDir: join(dir, "bad-remove"),
        version: "1.0.1",
        build: 2,
        keyFile: fixtureKey,
        removeAssets: ["app.worker.qjbc"],
      }),
    ).toThrow(/cannot remove active worker asset/);

    expect(() =>
      patchPackageArtifacts({
        baseDir: servedDir,
        outDir: join(dir, "bad-replace"),
        version: "1.0.1",
        build: 2,
        keyFile: fixtureKey,
        replaceAssets: {
          "app.worker.qjbc": Buffer.concat([Buffer.from("PJBC"), Buffer.alloc(128, 9)]),
        },
      }),
    ).toThrow(/cannot replace worker asset/);

    // Patch in-place with updated entry + sibling app.bytecode.json worker
    const v2InputDir = join(dir, "input-v2");
    mkdirSync(v2InputDir, { recursive: true });
    const entryV2 = join(v2InputDir, "app.qjbc");
    writeFileSync(entryV2, Buffer.from("PJBC-ui-v2"));
    const workerBytesV2 = Buffer.concat([Buffer.from("PJBC"), Buffer.alloc(128, 9)]);
    writeFileSync(join(v2InputDir, "app.worker.qjbc"), workerBytesV2);
    const workerV2 = {
      ...workerV1,
      bytecode: { path: "app.worker.qjbc", bytes: workerBytesV2.length, sha256: sha256Hex(workerBytesV2) },
    };
    writeFileSync(join(v2InputDir, "app.bytecode.json"), JSON.stringify({ worker: workerV2 }));

    const v2 = patchPackageArtifacts({
      baseDir: servedDir,
      outDir: servedDir,
      version: "1.0.1",
      build: 2,
      keyFile: fixtureKey,
      bytecodePath: entryV2,
    });
    expect(v2.payload.worker).toEqual(workerV2);
    expect(v2.payload.bundle?.url).not.toBe(v1.payload.bundle?.url);

    server = serveUpdates({ rootDir: servedDir, port: 0 });
    const base = String(server.url).replace(/\/$/, "");
    const resV1 = await fetch(`${base}/${v1.payload.bundle!.url}`);
    const resV2 = await fetch(`${base}/${v2.payload.bundle!.url}`);
    expect(resV1.status).toBe(200);
    expect(resV2.status).toBe(200);
    expect(sha256Hex(new Uint8Array(await resV1.arrayBuffer()))).toBe(v1.payload.bundle!.sha256);
    expect(sha256Hex(new Uint8Array(await resV2.arrayBuffer()))).toBe(v2.payload.bundle!.sha256);

    // 4. Malformed UTF-8 in PAK key is rejected (Finding 8)
    const badUtf8Pak = new Uint8Array(packPak([
      { key: "alpha", dtype: 0, data: new Uint8Array([1, 2, 3, 4]) },
    ]));
    const badPakView = new DataView(badUtf8Pak.buffer, badUtf8Pak.byteOffset, badUtf8Pak.byteLength);
    const namesOffset = badPakView.getUint32(16, true);
    const keyOffset = namesOffset + badPakView.getUint32(32 + 12, true);
    badUtf8Pak[keyOffset] = 0xff;
    badUtf8Pak[keyOffset + 1] = 0xfe;
    expect(() => parsePakLayout(badUtf8Pak)).toThrow();

    // 5. Truncated LZMA2 compressed stream is rejected instead of zero-padded (Finding 6)
    const sample7z = create7zArchive({
      "blobs/a": Buffer.from("Repeated LZMA2 test payload for truncation check! ".repeat(8)),
      "blobs/b": Buffer.from("Second solid substream payload! ".repeat(6)),
    });
    expect(extract7zArchive(sample7z).get("blobs/a")?.byteLength).toBeGreaterThan(0);
    const mutatedLzma = new Uint8Array(sample7z);
    mutatedLzma[38] = 0x01;
    expect(() => extract7zArchive(mutatedLzma)).toThrow(/LZMA|CRC/);
  } finally {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
