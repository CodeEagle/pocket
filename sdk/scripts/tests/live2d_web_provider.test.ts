import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { createLive2dProvider } = require("../../targets/web/live2d_provider.js") as {
  createLive2dProvider(options: Record<string, unknown>): {
    invoke(capability: string, params: unknown, context?: { signal?: AbortSignal }): Promise<any>;
    dispose(): Promise<void>;
  };
};

const LOAD = "media.live2d.model.load";
const UPDATE = "media.live2d.model.update";
const RELEASE = "media.live2d.model.release";

function fakeCore() {
  let releasedModels = 0;
  let releasedMocs = 0;
  let lastModel: any;
  const core = {
    Moc: {
      fromArrayBuffer(buffer: ArrayBuffer) {
        if (buffer.byteLength === 0) return null;
        return { _release() { releasedMocs++; } };
      },
    },
    Model: {
      fromMoc() {
        const model = {
          parameters: {
            count: 1,
            ids: ["ParamAngleX"],
            minimumValues: new Float32Array([-30]),
            maximumValues: new Float32Array([30]),
            defaultValues: new Float32Array([0]),
            values: new Float32Array([0]),
          },
          parts: { count: 1, ids: ["PartCore"], opacities: new Float32Array([1]), parentIndices: new Int32Array([-1]) },
          drawables: {
            count: 1,
            ids: ["ArtMesh"],
            constantFlags: new Uint8Array([4]),
            dynamicFlags: new Uint8Array([127]),
            textureIndices: new Int32Array([0]),
            drawOrders: new Int32Array([2]),
            renderOrders: new Int32Array([0]),
            opacities: new Float32Array([1]),
            maskCounts: new Int32Array([1]),
            vertexCounts: new Int32Array([3]),
            indexCounts: new Int32Array([3]),
            multiplyColors: new Float32Array([1, 1, 1, 1]),
            screenColors: new Float32Array([0, 0, 0, 1]),
            masks: [new Int32Array([0])],
            vertexPositions: [new Float32Array([0, 0, 1, 0, 0, 1])],
            vertexUvs: [new Float32Array([0.25, 0.2, 0.75, 0.2, 0.25, 0.8])],
            indices: [new Uint16Array([0, 1, 2])],
            blendModes: new Int32Array([0]),
          },
          canvasinfo: { CanvasWidth: 100, CanvasHeight: 200, CanvasOriginX: 10, CanvasOriginY: 20, PixelsPerUnit: 2 },
          update() { this.drawables.vertexPositions[0][0] = this.parameters.values[0] / 10; },
          release() { releasedModels++; },
        };
        lastModel = model;
        return model;
      },
    },
    Version: {
      csmGetVersion: () => 500,
      csmGetMocVersion: () => 3,
    },
  };
  return { core, get releasedModels() { return releasedModels; }, get releasedMocs() { return releasedMocs; }, get lastModel() { return lastModel; } };
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readF32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);
}

test("PMS1 packing preserves little-endian bytes and validates in-place Core mutations", async () => {
  const fixture = fakeCore();
  const provider = createLive2dProvider({ core: async () => fixture.core, readAsset: async () => new Uint8Array([1]) });
  try {
    const info = await provider.invoke(LOAD, { id: "packing", mocAsset: "model.moc3", textures: ["page.png"] });
    const update = () => provider.invoke(UPDATE, { modelId: info.modelId, parameters: [], partOpacities: [], cacheStaticTopology: true });
    const first = await update();
    const expected = new Uint8Array(76);
    const view = new DataView(expected.buffer);
    [0x31534d50, 3, 3, 0xffffffff].forEach((value, i) => view.setUint32(i * 4, value, true));
    [10, 20, 0.25, 1 - Math.fround(0.2), 12, 20, 0.75, 1 - Math.fround(0.2), 10, 18, 0.25, 1 - Math.fround(0.8)]
      .forEach((value, i) => view.setFloat32(16 + i * 4, value, true));
    [0, 1, 2].forEach((value, i) => view.setUint32(64 + i * 4, value, true));
    expect(first.drawables[0].meshBytes).toEqual(expected);
    const d = fixture.lastModel.drawables;
    d.vertexUvs[0][0] = 0.5;
    d.indices[0][1] = 2;
    const changed = await update();
    expect(readF32(changed.drawables[0].meshBytes, 24)).toBe(0.5);
    expect(readU32(changed.drawables[0].meshBytes, 68)).toBe(2);
    d.vertexUvs[0][0] = NaN;
    await expect(update()).rejects.toMatchObject({ code: "live2d_core_invalid" });
    d.vertexUvs[0][0] = 0.5;
    d.indices[0] = [-1, 1, 2];
    await expect(update()).rejects.toMatchObject({ code: "live2d_core_invalid" });
    d.indices[0] = [3, 1, 2];
    await expect(update()).rejects.toMatchObject({ code: "live2d_mesh_invalid" });
    d.indices[0] = [0, 1, 2];
    d.multiplyColors[0] = NaN;
    await expect(update()).rejects.toMatchObject({ code: "live2d_core_invalid" });
  } finally { await provider.dispose(); }
});

test("Web provider reuses the native Live2D contract and emits placed PMS1 meshes", async () => {
  const fixture = fakeCore();
  const readCalls: string[] = [];
  const provider = createLive2dProvider({
    core: async () => fixture.core,
    readAsset: async (key: string) => { readCalls.push(key); return new Uint8Array([1, 2, 3, 4]); },
  });

  await expect(provider.invoke(LOAD, {
    id: "actor",
    mocAsset: "../outside.moc3",
    textures: ["textures/page.png"],
  })).rejects.toMatchObject({ code: "invalid_request" });
  expect(readCalls).toEqual([]);

  const info = await provider.invoke(LOAD, {
    id: "actor",
    mocAsset: "models/actor.moc3",
    textures: ["textures/page.png"],
  });
  expect(readCalls).toEqual(["models/actor.moc3"]);
  expect(info).toMatchObject({
    drawableCount: 1,
    mocVersion: 3,
    parameterCount: 1,
    nativeBytes: 148,
    memoryAccounting: "core-visible-buffers",
    parameterDefaults: [{ id: "ParamAngleX", value: 0 }],
    parameterMetadata: [{ id: "ParamAngleX", minimum: -30, maximum: 30, defaultValue: 0 }],
    parts: [{ id: "PartCore", defaultOpacity: 1 }],
    canvas: { widthPixels: 100, heightPixels: 200, originXPixels: 10, originYPixels: 20, pixelsPerUnit: 2 },
  });

  const full = await provider.invoke(UPDATE, {
    modelId: info.modelId,
    parameters: [{ id: "ParamAngleX", value: 15 }],
    partOpacities: [{ id: "PartCore", value: 0.5 }],
    placement: { dx: 3, dy: 4, scale: 2, opacity: 0.5 },
    cacheStaticTopology: true,
  });
  expect(full.topologyMode).toBe("full");
  expect(full.drawables[0].maskIndices).toBeInstanceOf(Uint8Array);
  expect(full.drawables[0].multiplyColorRgba).toBeInstanceOf(Uint8Array);
  const mesh = full.drawables[0].meshBytes as Uint8Array;
  expect(readU32(mesh, 0)).toBe(0x31534d50);
  expect([readU32(mesh, 4), readU32(mesh, 8), readU32(mesh, 12)]).toEqual([3, 3, 0x80ffffff]);
  expect([readF32(mesh, 16), readF32(mesh, 20), readF32(mesh, 24)]).toEqual([29, 44, 0.25]);
  expect(readF32(mesh, 28)).toBeCloseTo(0.8, 6);
  expect([readU32(mesh, 64), readU32(mesh, 68), readU32(mesh, 72)]).toEqual([0, 1, 2]);
  expect(readU32(full.drawables[0].maskIndices, 0)).toBe(0);
  expect(fixture.lastModel.parameters.values[0]).toBe(15);
  expect(fixture.lastModel.parts.opacities[0]).toBe(0.5);

  const cached = await provider.invoke(UPDATE, {
    modelId: info.modelId,
    parameters: [{ id: "ParamAngleX", value: 0 }],
    partOpacities: [],
    cacheStaticTopology: true,
  });
  expect(cached.topologyMode).toBe("cached-v1");
  expect(cached.drawables[0]).not.toHaveProperty("maskIndices");
  expect(readF32(cached.drawables[0].meshBytes, 16)).toBe(10);

  const uncached = await provider.invoke(UPDATE, {
    modelId: info.modelId, parameters: [], partOpacities: [],
  });
  expect(uncached.topologyMode).toBeUndefined();
  expect(uncached.drawables[0].maskIndices).toBeInstanceOf(Uint8Array);

  await provider.invoke(RELEASE, { modelId: info.modelId });
  expect(fixture.releasedModels).toBe(1);
  expect(fixture.releasedMocs).toBe(1);
  await provider.dispose();
});

test("Web provider enforces model, value, topology, and lifecycle boundaries", async () => {
  const fixture = fakeCore();
  const provider = createLive2dProvider({
    core: async () => fixture.core,
    readAsset: async () => new Uint8Array([1]),
  });
  const first = await provider.invoke(LOAD, { id: "one", mocAsset: "models/one.moc3", textures: ["texture.png"] });
  await expect(provider.invoke(UPDATE, {
    modelId: first.modelId, parameters: [{ id: "ParamUnknown", value: 0 }], partOpacities: [],
  })).rejects.toMatchObject({ code: "live2d_parameter_not_found" });
  await expect(provider.invoke(UPDATE, {
    modelId: first.modelId, parameters: [], partOpacities: [{ id: "PartCore", value: 2 }],
  })).rejects.toMatchObject({ code: "invalid_request" });

  await provider.dispose();
  expect(fixture.releasedModels).toBe(1);
  expect(fixture.releasedMocs).toBe(1);
  await expect(provider.invoke(RELEASE, { modelId: first.modelId })).rejects.toMatchObject({ code: "live2d_provider_disposed" });
});

test("Web provider normalizes legacy blend flags and rejects unsupported packed Core modes", async () => {
  for (const [flag, expected] of [[1, 3], [2, 6]] as const) {
    const fixture = fakeCore();
    const provider = createLive2dProvider({ core: async () => fixture.core, readAsset: async () => new Uint8Array([1]) });
    const info = await provider.invoke(LOAD, { id: "blend", mocAsset: "models/blend.moc3", textures: ["texture.png"] });
    delete fixture.lastModel.drawables.blendModes;
    fixture.lastModel.drawables.constantFlags[0] = flag;
    const frame = await provider.invoke(UPDATE, { modelId: info.modelId, parameters: [], partOpacities: [] });
    expect(frame.drawables[0].blendMode).toBe(expected);
    await provider.dispose();
  }

  const unsupported = fakeCore();
  const provider = createLive2dProvider({ core: async () => unsupported.core, readAsset: async () => new Uint8Array([1]) });
  const info = await provider.invoke(LOAD, { id: "blend", mocAsset: "models/blend.moc3", textures: ["texture.png"] });
  unsupported.lastModel.drawables.blendModes[0] = 4;
  await expect(provider.invoke(UPDATE, { modelId: info.modelId, parameters: [], partOpacities: [] }))
    .rejects.toMatchObject({ code: "live2d_blend_mode_unsupported" });
  await provider.dispose();
});

const repositoryRoot = resolve(import.meta.dir, "../../..");
const corePath = process.env.POCKET_CUBISM_WEB_CORE || [
  resolve(repositoryRoot, "sdk/.pocket-build/live2d-web/live2dcubismcore.min.js"),
  resolve(repositoryRoot, "sdk/packages/pocket_live2d/.cache/cubism-web-core/live2dcubismcore.min.js"),
].find(existsSync);
const modelPath = [
  resolve(repositoryRoot, "demo/js/apps/lantern/.pocket-build/live2d/Hiyori/Hiyori.moc3"),
  resolve(repositoryRoot, "sdk/packages/pocket_live2d/.cache/hiyori-guest-pixels/project/models/Hiyori/Hiyori.moc3"),
].find(existsSync);

test.skipIf(!corePath || !modelPath)("official Cubism Web Core deforms the Hiyori MOC through the Web capability provider", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.setContent("<!doctype html><html><head></head><body></body></html>");
    await page.addScriptTag({ path: corePath! });
    await page.addScriptTag({ path: resolve(import.meta.dir, "../../targets/web/live2d_provider.js") });
    const mocBytes = readFileSync(modelPath!);
    const result = await page.evaluate(async ({ encodedMoc }) => {
      const binary = atob(encodedMoc);
      const moc = Uint8Array.from(binary, character => character.charCodeAt(0));
      const provider = (globalThis as any).PocketLive2dProvider.createLive2dProvider({
        core: async () => (globalThis as any).Live2DCubismCore,
        readAsset: async (key: string) => {
          if (key !== "models/Hiyori.moc3") throw new Error(`Unexpected model asset ${key}`);
          return moc;
        },
      });
      const info = await provider.invoke("media.live2d.model.load", {
        id: "hiyori", mocAsset: "models/Hiyori.moc3", textures: ["textures/page0.png", "textures/page1.png"],
      });
      const first = await provider.invoke("media.live2d.model.update", {
        modelId: info.modelId, parameters: [], partOpacities: [], cacheStaticTopology: true,
      });
      const moved = await provider.invoke("media.live2d.model.update", {
        modelId: info.modelId, parameters: [{ id: "ParamAngleX", value: 20 }], partOpacities: [], cacheStaticTopology: true,
      });
      let maximumDelta = 0;
      for (let drawableIndex = 0; drawableIndex < first.drawables.length; drawableIndex++) {
        const a = new DataView(first.drawables[drawableIndex].meshBytes.buffer, first.drawables[drawableIndex].meshBytes.byteOffset, first.drawables[drawableIndex].meshBytes.byteLength);
        const b = new DataView(moved.drawables[drawableIndex].meshBytes.buffer, moved.drawables[drawableIndex].meshBytes.byteOffset, moved.drawables[drawableIndex].meshBytes.byteLength);
        if (a.byteLength === 0 || b.byteLength === 0) continue;
        const vertexCount = a.getUint32(4, true);
        for (let vertex = 0; vertex < vertexCount; vertex++) {
          for (let component = 0; component < 2; component++) {
            maximumDelta = Math.max(maximumDelta, Math.abs(a.getFloat32(16 + vertex * 16 + component * 4, true) - b.getFloat32(16 + vertex * 16 + component * 4, true)));
          }
        }
      }
      await provider.invoke("media.live2d.model.release", { modelId: info.modelId });
      await provider.dispose();
      return { drawableCount: info.drawableCount, parameterCount: info.parameterCount,
        firstMode: first.topologyMode, movedMode: moved.topologyMode, maximumDelta,
        meshByteLength: moved.drawables.reduce((total: number, item: any) => total + item.meshBytes.byteLength, 0) };
    }, { encodedMoc: mocBytes.toString("base64") });
    expect(pageErrors).toEqual([]);
    expect(result).toMatchObject({ drawableCount: 134, parameterCount: 70, firstMode: "full", movedMode: "cached-v1" });
    expect(result.maximumDelta).toBeGreaterThan(0.1);
    expect(result.meshByteLength).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});
