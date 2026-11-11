import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewLive2d, cubismWebCorePath } from "../live2d.ts";
import { createPreviewManager } from "../preview.ts";
import { buildResourceSnapshot } from "../resources.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(sdkRoot, "..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/release/pocket_probe");
const hiyoriMoc = [
  join(repoRoot, "demo/js/apps/lantern/.pocket-build/live2d/Hiyori/Hiyori.moc3"),
  join(sdkRoot, "packages/pocket_live2d/.cache/hiyori-guest-pixels/project/models/Hiyori/Hiyori.moc3"),
].find(existsSync) ?? join(repoRoot, "demo/js/apps/lantern/.pocket-build/live2d/Hiyori/Hiyori.moc3");
const webCore = cubismWebCorePath();
const uiPackage = join(sdkRoot, "packages/pocket_ui");
const vnPackage = join(sdkRoot, "packages/pocket_vn");
const live2dPackage = join(sdkRoot, "packages/pocket_live2d");

async function snapshot(manager: ReturnType<typeof createPreviewManager>, projectId: string) {
  const response = await manager.handle(new Request(`http://127.0.0.1/api/projects/${projectId}/preview/snapshot`), projectId, "snapshot");
  assert.equal(response.status, 200);
  return await response.json() as { status: { state: string; error?: string }; frame: { ops: Array<Record<string, unknown>> } };
}

// The official model/Core are ignored local license-gated caches, not portable
// repository fixtures. Skip this real-model acceptance test when they or the
// compiled probe are unavailable; never replace them with a fake Core/model.
test.skipIf(!existsSync(probe) || !existsSync(hiyoriMoc) || !existsSync(webCore))("real Guest Preview loads Hiyori through typed binary host responses and updates deformed PMS1 meshes", { timeout: 120_000 }, async () => {

  const project = await mkdtemp(join(tmpdir(), "pocket-preview-live2d-project-"));
  const output = await mkdtemp(join(tmpdir(), "pocket-preview-live2d-build-"));
  const modelDir = join(project, "models");
  const artDir = join(project, "art");
  await mkdir(modelDir, { recursive: true });
  await mkdir(artDir, { recursive: true });
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await cp(hiyoriMoc, join(modelDir, "Hiyori.moc3"));
    await writeFile(join(modelDir, "Hiyori.model3.json"), JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "Hiyori.moc3", Textures: ["texture_00.png", "texture_01.png"] },
    }));
    await writeFile(join(artDir, "texture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    await writeFile(join(project, "package.json"), JSON.stringify({
      name: "pocket-live2d-preview-guest",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${uiPackage}`,
        "@pocket/vn": `file:${vnPackage}`,
        "@pocket/live2d": `file:${live2dPackage}`,
      },
    }));
    await writeFile(join(project, "pocket.json"), JSON.stringify({ appId: "pocket.test.live2d-preview", entry: "app.tsx" }));
    await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [
      "media.live2d.model.load", "media.live2d.model.update", "media.live2d.model.release",
    ] } }));
    await writeFile(join(project, "novel.assets.json"), JSON.stringify({
      models: {
        hiyori: {
          kind: "live2d",
          source: "models/Hiyori.model3.json",
          textures: { "texture_00.png": "art/texture.png", "texture_01.png": "art/texture.png" },
        },
      },
    }));
    await writeFile(join(project, "app.tsx"), `
import { createSignal, onMount } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketLive2dClient } from "@pocket/live2d";

const client = createPocketLive2dClient(createHostBridge(), { cacheStaticTopology: true });
function App() {
  const [status, setStatus] = createSignal("pending");
  onMount(() => { void (async () => {
    try {
      const info = await client.load({
        id: "guest-hiyori",
        assetPrefix: "",
        manifest: { version: 3, moc: "models/Hiyori.moc3", textures: ["models/texture_00.png", "models/texture_01.png"], expressions: [], motions: {}, groups: [] },
      });
      const angle = info.parameterMetadata?.find((item: any) => item.id === "ParamAngleX");
      if (!angle) throw new Error("Core omitted ParamAngleX metadata");
      const placement = { dx: 10, dy: 20, scale: 0.1 };
      const first = await client.update(info.modelId, [], [], placement);
      const changed = await client.update(info.modelId, [{ id: angle.id, value: Math.min(angle.maximum, angle.defaultValue + 20) }], [], placement);
      const firstMeshes = new Map(first.drawables.filter((item: any) => item.meshBytes.byteLength > 0).map((item: any) => [item.id, item.meshBytes]));
      let moved = false;
      let typed = false;
      let meshBytes = 0;
      for (const item of changed.drawables) {
        const before = firstMeshes.get(item.id);
        if (!before || item.meshBytes.byteLength === 0) continue;
        typed ||= item.meshBytes instanceof Uint8Array;
        meshBytes = item.meshBytes.byteLength;
        const count = new DataView(item.meshBytes.buffer, item.meshBytes.byteOffset, item.meshBytes.byteLength).getUint32(4, true);
        const left = new DataView(before.buffer, before.byteOffset, before.byteLength);
        const right = new DataView(item.meshBytes.buffer, item.meshBytes.byteOffset, item.meshBytes.byteLength);
        for (let vertex = 0; vertex < count; vertex++) {
          const offset = 16 + vertex * 16;
          if (Math.abs(left.getFloat32(offset, true) - right.getFloat32(offset, true)) > 0.01 ||
              Math.abs(left.getFloat32(offset + 4, true) - right.getFloat32(offset + 4, true)) > 0.01) moved = true;
        }
      }
      // This third request exercises the sparse cached-v1 topology response;
      // the JS client expands it back to the same complete drawable contract.
      const cached = await client.update(info.modelId, [{ id: angle.id, value: angle.defaultValue }], [], placement);
      if (cached.drawables.length !== info.drawableCount) throw new Error("cached topology count changed");
      await client.dispose();
      setStatus("ready " + JSON.stringify({ drawables: info.drawableCount, parameter: angle.id, typed, moved, meshBytes, memoryAccounting: info.memoryAccounting }));
    } catch (error) {
      setStatus("error " + String(error));
    }
  })(); });
  return <Screen><Text>{status()}</Text></Screen>;
}
mount(() => <App />);
`, "utf8");

    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    const catalog = JSON.parse(await readFile(join(output, "novel.native-assets.json"), "utf8"));
    assert.equal(catalog.version, 1);
    assert.deepEqual(Object.keys(catalog.assets), ["models/Hiyori.moc3"]);
    manager = createPreviewManager({
      probePath: probe,
      projectDirectory: output,
      width: 390,
      height: 360,
      idleDisposeMs: 30_000,
      artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
    });
    const projectId = "live2d-preview-guest";
    const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    const deadline = Date.now() + 30_000;
    let current = await snapshot(manager, projectId);
    let status = current.frame.ops.find(op => op.type === "text")?.text;
    while (typeof status !== "string" || !status.startsWith("ready ") && !status.startsWith("error ")) {
      assert.ok(Date.now() < deadline, `Live2D Guest did not finish; preview=${JSON.stringify(current.status)}`);
      await Bun.sleep(30);
      current = await snapshot(manager, projectId);
      status = current.frame.ops.find(op => op.type === "text")?.text;
    }
    assert.ok(typeof status === "string" && status.startsWith("ready "), String(status));
    const result = JSON.parse(String(status).slice("ready ".length)) as Record<string, unknown>;
    assert.equal(result.drawables, 134);
    assert.equal(result.parameter, "ParamAngleX");
    assert.equal(result.typed, true, "binary host response must restore PMS1 meshBytes as Uint8Array in QJBC");
    assert.equal(result.moved, true, "real Core parameter input must change PMS1 vertex coordinates");
    assert.equal(result.memoryAccounting, "core-visible-buffers", "the shared client must preserve the provider's explicit byte accounting basis");
    assert.ok(Number(result.meshBytes) > 16);
  } finally {
    await reader?.cancel();
    await manager?.dispose();
    await rm(project, { recursive: true, force: true });
    await rm(output, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!existsSync(hiyoriMoc) || !existsSync(webCore))("child package resource snapshot retains novel.native-assets.json and native-models for createPreviewLive2d after temporary build removal", { timeout: 120_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pocket-live2d-subpackage-snapshot-"));
  const rootProject = join(workspace, "project");
  const childProject = join(rootProject, "apps/lantern");
  const buildDir = join(workspace, "build");
  const tempRootOut = join(workspace, "temp-root-out");
  await mkdir(join(childProject, "models"), { recursive: true });
  await mkdir(join(childProject, "art"), { recursive: true });
  await mkdir(buildDir, { recursive: true });
  await mkdir(tempRootOut, { recursive: true });
  let provider: ReturnType<typeof createPreviewLive2d> | undefined;
  try {
    const mocBytes = await readFile(hiyoriMoc);
    const expectedHash = createHash("sha256").update(mocBytes).digest("hex");
    const expectedBundlePath = `native-models/${expectedHash}.moc3`;
    await writeFile(join(childProject, "models/Hiyori.moc3"), mocBytes);
    await writeFile(join(childProject, "models/Hiyori.model3.json"), JSON.stringify({
      Version: 3,
      FileReferences: { Moc: "Hiyori.moc3", Textures: ["texture_00.png"] },
    }));
    await writeFile(
      join(childProject, "art/texture.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    );

    await writeFile(join(rootProject, "package.json"), JSON.stringify({
      name: "pocket-live2d-root",
      private: true,
      type: "module",
      dependencies: { "@pocket/ui": `file:${uiPackage}` },
    }));
    await writeFile(join(rootProject, "pocket.json"), JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: "pocket.test.root",
      name: "root",
      title: "Root",
      version: "0.1.0",
      engine: {
        capabilities: {
          requires: ["text.glyphs.baked", "ui.compositor-surfaces"],
          enhances: [],
        },
      },
      app: {
        entry: "app.tsx",
        output: "root-app",
        framework: "solid",
        viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      },
    }));
    await writeFile(join(rootProject, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    await writeFile(join(rootProject, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text } from "@pocketjs/framework/solid/components";
mount(() => <Screen><Text>root</Text></Screen>);
`, "utf8");

    await writeFile(join(childProject, "package.json"), JSON.stringify({
      name: "pocket-live2d-child",
      private: true,
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${uiPackage}`,
        "@pocket/vn": `file:${vnPackage}`,
        "@pocket/live2d": `file:${live2dPackage}`,
      },
    }));
    await writeFile(join(childProject, "pocket.json"), JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id: "pocket.demo.lantern",
      name: "lantern",
      title: "Lantern",
      version: "0.1.0",
      engine: {
        capabilities: {
          requires: ["text.glyphs.baked"],
          enhances: [],
        },
      },
      app: {
        entry: "app.tsx",
        output: "lantern-app",
        framework: "solid",
        viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      },
    }));
    await writeFile(join(childProject, "manifest.json"), JSON.stringify({
      capabilities: {
        requires: ["media.live2d.model.load", "media.live2d.model.update", "media.live2d.model.release"],
      },
    }));
    await writeFile(join(childProject, "novel.assets.json"), JSON.stringify({
      models: {
        hiyori: {
          kind: "live2d",
          source: "models/Hiyori.model3.json",
          textures: { "texture_00.png": "art/texture.png" },
        },
      },
    }));
    await writeFile(join(childProject, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text } from "@pocketjs/framework/solid/components";
mount(() => <Screen><Text>lantern</Text></Screen>);
`, "utf8");

    const systemPath = join(rootProject, "pocket.system.json");
    await writeFile(systemPath, JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-system-1.json",
      pocketSystem: 1,
      id: "pocket.test.system",
      name: "pocket-test-system",
      title: "Test System",
      version: "0.1.0",
      roles: { systemUI: "pocket.test.root" },
      applications: {
        installPolicy: { model: "managed", mutable: false },
        backgroundExecution: "suspend",
        catalog: [
          { package: "pocket.test.root", manifest: "pocket.json", required: true },
          { package: "pocket.demo.lantern", manifest: "apps/lantern/pocket.json", required: true },
        ],
      },
      installation: {
        installedPackages: ["pocket.test.root", "pocket.demo.lantern"],
      },
    }));

    const rootBuilt = await buildGuest({ projectRoot: rootProject, outDir: tempRootOut, tickHz: 60 });
    await cp(rootBuilt.source, join(buildDir, "app.js"));
    await cp(rootBuilt.pak, join(buildDir, "app.pak"));
    await cp(rootBuilt.bytecode, join(buildDir, "app.qjbc"));
    await cp(rootBuilt.metadata, join(buildDir, "app.bytecode.json"));
    await cp(join(tempRootOut, "guest-manifest.json"), join(buildDir, "guest-manifest.json"));
    const rootMeta = JSON.parse(await readFile(rootBuilt.metadata, "utf8")) as { runtimeAbi: string };
    await rm(tempRootOut, { recursive: true, force: true });

    const resourceSnapshot = await buildResourceSnapshot({
      projectRoot: rootProject,
      buildDirectory: buildDir,
      revision: 1,
      rootPackageId: "pocket.test.root",
      rootTitle: "Root",
      rootManifest: "pocket.json",
      rootVersion: "0.1.0",
      rootBuild: 1,
      rootRuntimeAbi: rootMeta.runtimeAbi,
      tickHz: 60,
      systemFile: systemPath,
    });

    // Remove the source project's .moc3 to prove createPreviewLive2d reads only
    // from the immutable child snapshot directory next to app.qjbc.
    await rm(join(childProject, "models/Hiyori.moc3"), { force: true });

    const childInventory = resourceSnapshot.packages.find((pkg) => pkg.id === "pocket.demo.lantern");
    assert.ok(childInventory, "snapshot must include child package");
    assert.equal(childInventory.artifactDirectory, "subpackages/pocket.demo.lantern");
    const childSnapshotDir = join(buildDir, childInventory.artifactDirectory);
    const catalog = JSON.parse(await readFile(join(childSnapshotDir, "novel.native-assets.json"), "utf8"));
    assert.deepEqual(catalog, {
      version: 1,
      assets: { "models/Hiyori.moc3": expectedBundlePath },
    });
    assert.deepEqual(await readFile(join(childSnapshotDir, expectedBundlePath)), mocBytes);

    provider = createPreviewLive2d(join(childSnapshotDir, "app.qjbc"));
    const loaded = await provider.invoke("media.live2d.model.load", {
      id: "snapshot-hiyori",
      mocAsset: "models/Hiyori.moc3",
      textures: ["models/texture_00.png", "models/texture_01.png"],
    }) as { modelId: string; drawableCount: number };
    assert.equal(loaded.drawableCount, 134);
    await provider.invoke("media.live2d.model.release", { modelId: loaded.modelId });
  } finally {
    await provider?.dispose?.();
    await rm(workspace, { recursive: true, force: true });
  }
}, 120_000);
