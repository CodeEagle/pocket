import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pack } from "../../../.cache/pocketjs/framework/compiler/pak.ts";
import { packageArtifacts, patchPackageArtifacts } from "../../../scripts/package_update.ts";
import type { HostBridge, JsonObject, JsonValue } from "../src/host.ts";
import {
  PocketUpdatePlanError,
  createPocketUpdateClient,
  diffUpdateManifests,
  planPackageUpdate,
} from "../src/updates.ts";

const fixtureKey = resolve(import.meta.dir, "../../../scripts/tests/fixtures/pocket-package/test-ed25519.json");

function createFixturePackages(dir: string) {
  const srcDir = join(dir, "src");
  const assetsDir = join(dir, "assets");
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(join(assetsDir, "images"), { recursive: true });

  const jsPath = join(srcDir, "app.js");
  const pakPath = join(srcDir, "app.pak");
  writeFileSync(jsPath, "globalThis.frame=()=>{return 1;};\n");
  writeFileSync(
    pakPath,
    pack([
      { key: "ui:img.alpha", dtype: 0, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
      { key: "ui:img.beta", dtype: 0, data: new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]) },
    ]),
  );
  writeFileSync(join(assetsDir, "images", "poster.png"), Buffer.from([9, 8, 7]));
  writeFileSync(join(assetsDir, "config.json"), Buffer.from('{"theme":"dark"}'));

  const v1 = packageArtifacts({
    appId: "demo.miniapp",
    version: "1.0.0",
    build: 1,
    jsPath,
    pakPath,
    outDir: join(dir, "v1"),
    keyFile: fixtureKey,
    assetDir: assetsDir,
    assetPrefix: "assets",
  });

  const jsV2 = join(srcDir, "app-v2.js");
  writeFileSync(jsV2, "globalThis.frame=()=>{return 2;};\n");
  const v2Code = patchPackageArtifacts({
    baseDir: join(dir, "v1"),
    outDir: join(dir, "v2-code"),
    version: "1.0.1",
    build: 2,
    keyFile: fixtureKey,
    jsPath: jsV2,
  });

  const v3PakEntry = patchPackageArtifacts({
    baseDir: join(dir, "v2-code"),
    outDir: join(dir, "v3-pak"),
    version: "1.0.2",
    build: 3,
    keyFile: fixtureKey,
    replacePakEntries: {
      "ui:img.beta": new Uint8Array([99, 20, 30, 40, 50, 60, 70, 80]),
    },
  });

  const v4Asset = patchPackageArtifacts({
    baseDir: join(dir, "v3-pak"),
    outDir: join(dir, "v4-asset"),
    version: "1.0.3",
    build: 4,
    keyFile: fixtureKey,
    replaceAssets: {
      "assets/images/poster.png": new Uint8Array([1, 1, 2, 3, 5, 8]),
    },
  });

  return { v1: v1.payload, v2Code: v2Code.payload, v3PakEntry: v3PakEntry.payload, v4Asset: v4Asset.payload };
}

test("planPackageUpdate selects one-shot zip mode on fresh install and granular mode when mini-app is already downloaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-ui-updates-"));
  try {
    const { v1, v2Code, v3PakEntry, v4Asset } = createFixturePackages(dir);

    // Fresh download without baseline: auto mode chooses one-shot zip bundle
    const freshPlan = planPackageUpdate({ candidate: v1 });
    expect(freshPlan.deliveryMode).toBe("zip");
    expect(freshPlan.bundle).toEqual(v1.bundle);
    expect(freshPlan.downloadBytes).toBe(v1.bundle!.size);

    // Already-downloaded mini-app (v1 installed): auto mode switches to granular and downloads only the 1 changed code blob
    const codePlan = planPackageUpdate({
      baseline: v1,
      candidate: v2Code,
      target: { scope: "code" },
    });
    expect(codePlan.deliveryMode).toBe("granular");
    expect(codePlan.diff.codeChanged).toBe(true);
    expect(codePlan.diff.pakChanged).toBe(false);
    expect(codePlan.diff.changedAssets).toEqual([]);
    expect(codePlan.downloadFiles.map((f) => f.sha256)).toEqual([v2Code.entry.sha256]);
    expect(codePlan.reusedFiles.length).toBe(v2Code.files.length - 1);

    // Single PAK resource update ("ui:img.beta") on already-downloaded v2Code
    const pakResourcePlan = planPackageUpdate({
      baseline: v2Code,
      candidate: v3PakEntry,
      target: { scope: "resource", resource: "ui:img.beta" },
    });
    expect(pakResourcePlan.deliveryMode).toBe("granular");
    expect(pakResourcePlan.resolvedResource).toBe("pak:ui:img.beta");
    expect(pakResourcePlan.diff.codeChanged).toBe(false);
    expect(pakResourcePlan.diff.changedPakEntries).toEqual(["ui:img.beta"]);
    expect(pakResourcePlan.downloadFiles).toHaveLength(1);

    // Single loose asset update ("assets/images/poster.png") on already-downloaded v3PakEntry
    const assetResourcePlan = planPackageUpdate({
      baseline: v3PakEntry,
      candidate: v4Asset,
      target: { scope: "resource", resource: "assets/images/poster.png" },
    });
    expect(assetResourcePlan.deliveryMode).toBe("granular");
    expect(assetResourcePlan.resolvedResource).toBe("asset:assets/images/poster.png");
    expect(assetResourcePlan.diff.codeChanged).toBe(false);
    expect(assetResourcePlan.diff.changedAssets).toEqual(["assets/images/poster.png"]);
    expect(assetResourcePlan.downloadFiles).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planPackageUpdate rejects granular target scope violations and missing baselines", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-ui-updates-reject-"));
  try {
    const { v1, v2Code, v3PakEntry, v4Asset } = createFixturePackages(dir);

    // Code-only update without an installed baseline is rejected
    expect(() =>
      planPackageUpdate({
        candidate: v2Code,
        target: { scope: "code" },
      }),
    ).toThrow(PocketUpdatePlanError);

    // Code-only update when a PAK resource changed is rejected
    expect(() =>
      planPackageUpdate({
        baseline: v2Code,
        candidate: v3PakEntry,
        target: { scope: "code" },
      }),
    ).toThrow(/resource files also changed/);

    // Single-resource update when code changed is rejected
    expect(() =>
      planPackageUpdate({
        baseline: v1,
        candidate: v2Code,
        target: { scope: "resource", resource: "assets/config.json" },
      }),
    ).toThrow(/code also changed/);

    // Single-resource update targeting a different resource than the one that changed is rejected
    expect(() =>
      planPackageUpdate({
        baseline: v3PakEntry,
        candidate: v4Asset,
        target: { scope: "resource", resource: "assets/config.json" },
      }),
    ).toThrow(/other resources changed/);

    // PAK dtype change or unattributed PAK change is rejected when requesting an unrelated loose asset or unchanged PAK key
    const dtypeChangedCandidate = {
      ...v1,
      build: 9,
      pak: {
        ...v1.pak,
        sha256: "f".repeat(64),
        parts: v1.pak.parts.map((part) => (part.key === "ui:img.alpha" ? { ...part, dtype: 7 } : part)),
      },
    };
    expect(() =>
      planPackageUpdate({
        baseline: v1,
        candidate: dtypeChangedCandidate,
        target: { scope: "resource", resource: "assets/config.json" },
      }),
    ).toThrow(/other resources changed/);

    const unattributedPakCandidate = {
      ...v1,
      build: 10,
      pak: {
        ...v1.pak,
        sha256: "e".repeat(64),
      },
    };
    expect(() =>
      planPackageUpdate({
        baseline: v1,
        candidate: unattributedPakCandidate,
        target: { scope: "resource", resource: "pak:ui:img.alpha" },
      }),
    ).toThrow(/other resources changed/);

    // Duplicate PAK part keys in manifest are rejected
    const duplicateKeyCandidate = {
      ...v1,
      build: 11,
      pak: {
        ...v1.pak,
        sha256: "d".repeat(64),
        parts: v1.pak.parts.map((part) => (part.kind === "blob" ? { ...part, key: "ui:img.alpha" } : part)),
      },
    };
    expect(() =>
      planPackageUpdate({
        baseline: v1,
        candidate: duplicateKeyCandidate,
        target: { scope: "resource", resource: "assets/config.json" },
      }),
    ).toThrow(/Duplicate PAK part key/);

    // Worker descriptor changes (even with identical worker bytecode sha256) are classified as code changes
    const workerBaseline = {
      ...v1,
      worker: {
        kind: "quickjs-bytecode",
        protocolVersion: 1,
        runtimeAbi: "abi-v1",
        requiredCaps: ["runtime.worker"],
        bytecode: { path: "assets/worker.qjbc", sha256: "a".repeat(64), bytes: 256 },
      },
    };
    const workerCapsChanged = {
      ...v4Asset,
      worker: {
        ...workerBaseline.worker,
        requiredCaps: ["runtime.worker", "network.fetch"],
      },
    };
    expect(() =>
      planPackageUpdate({
        baseline: workerBaseline,
        candidate: workerCapsChanged,
        target: { scope: "resource", resource: "assets/images/poster.png" },
      }),
    ).toThrow(/code also changed/);

    // 9. Single-resource scope rejects guest policy (capabilities / permissions / memory) escalation (Finding 4)
    const policyEscalated = {
      ...v4Asset,
      permissions: { requires: ["camera"], optional: [] },
    };
    expect(() =>
      planPackageUpdate({
        baseline: v3PakEntry,
        candidate: policyEscalated,
        target: { scope: "resource", resource: "assets/config.json" },
      }),
    ).toThrow(/guest policy .* also changed/);

    // 10. Unannotated legacy baseline PAK can perform its first single-PAK-resource update (Finding 5)
    const legacyUnannotatedBaseline = {
      ...v2Code,
      pak: {
        ...v2Code.pak,
        parts: v2Code.pak.parts.map((part) => ({
          offset: part.offset,
          sha256: part.sha256,
          size: part.size,
        })),
      },
    };
    const legacyToAnnotatedPlan = planPackageUpdate({
      baseline: legacyUnannotatedBaseline,
      candidate: v3PakEntry,
      target: { scope: "resource", resource: "ui:img.beta" },
    });
    expect(legacyToAnnotatedPlan.diff.changedPakEntries).toEqual(["ui:img.beta"]);
    expect(legacyToAnnotatedPlan.diff.updatedComponents).toEqual(["pak:ui:img.beta"]);

    // 11. Null-valued worker fields canonicalize identically to omitted fields (Finding 9)
    const workerWithNullField = {
      ...v3PakEntry,
      worker: {
        kind: "quickjs-bytecode",
        protocolVersion: 1,
        runtimeAbi: "abi-1",
        bindingGeneration: 1,
        tickHz: 60,
        bytecode: { path: "app.worker.qjbc", bytes: 10, sha256: "a".repeat(64) },
        declaration: { entry: "worker.ts", nodes: [], channels: [] },
        requiredCaps: ["runtime.worker"],
      },
    };
    const workerWithExtraNull = {
      ...v4Asset,
      worker: {
        ...workerWithNullField.worker,
        optionalNote: null,
      } as unknown as Record<string, JsonValue>,
    };
    const workerNullDiff = diffUpdateManifests(workerWithNullField, workerWithExtraNull);
    expect(workerNullDiff.workerChanged).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createPocketUpdateClient forwards zip, code-only, and single-resource check requests to host bridge", async () => {
  const calls: Array<{ capability: string; params?: JsonObject }> = [];
  const fakeHost: HostBridge = {
    async request<T extends JsonValue = JsonValue>(capability: string, params?: JsonObject): Promise<T> {
      calls.push({ capability, params });
      return {
        configured: true,
        stage: "verified",
        activeVersion: "1.0.0",
        activeBuild: 1,
        availableVersion: "1.0.1",
        versions: [],
      } as unknown as T;
    },
    handle: () => false,
    tick: () => {},
    dispose: () => {},
  };

  const client = createPocketUpdateClient(fakeHost);
  await client.checkZip();
  await client.checkCodeOnly();
  await client.checkResource("assets/images/poster.png");

  expect(calls).toEqual([
    { capability: "updates.check", params: { mode: "zip", scope: "all" } },
    { capability: "updates.check", params: { mode: "granular", scope: "code" } },
    { capability: "updates.check", params: { mode: "granular", scope: "resource", resource: "assets/images/poster.png" } },
  ]);
});
