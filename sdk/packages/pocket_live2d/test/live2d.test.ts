import { expect, test } from "bun:test";
import {
  parseCubismModel3,
  validateCubismAssetReference,
} from "../src/manifest.ts";
import {
  applyCubismExpression3,
  evaluateCubismMotion3,
  parseCubismExpression3,
  parseCubismMotion3,
} from "../src/motion.ts";
import {
  createPocketLive2dClient,
  pocketLive2dLoadCapability,
  pocketLive2dReleaseCapability,
  pocketLive2dUpdateCapability,
} from "../src/transport.ts";

const model3 = {
  Version: 3,
  FileReferences: {
    Moc: "Mao.moc3",
    Textures: ["Mao.2048/texture_00.png"],
    Physics: "Mao.physics3.json",
    Expressions: [{ Name: "smile", File: "expressions/smile.exp3.json" }],
    Motions: { Idle: [{ File: "motions/idle.motion3.json", FadeInTime: 0.4 }] },
  },
  Groups: [{ Target: "Parameter", Name: "EyeBlink", Ids: ["ParamEyeLOpen", "ParamEyeROpen"] }],
};

const nativeModelInfo = {
  modelId: "native-1",
  drawableCount: 1,
  mocVersion: 5,
  nativeBytes: 4096,
  parameterCount: 1,
  parameterDefaults: [{ id: "ParamEyeLOpen", value: 1 }],
  canvas: { widthPixels: 5800, heightPixels: 8400, originXPixels: 2900, originYPixels: 4200, pixelsPerUnit: 5800 },
};

const nativeFrame = {
  modelId: "native-1",
  drawables: [{
    id: "ArtMesh01",
    textureIndex: 0,
    drawOrder: 0,
    renderOrder: 0,
    blendMode: 0,
    constantFlags: 0,
    dynamicFlags: 33,
    opacity: 1,
    meshBytes: pms1Bytes([0, 0, 20, 0, 10, 20], [0, 0, 1, 0, 0.5, 1], [0, 1, 2]),
    maskIndices: uint32Bytes([3]),
    multiplyColorRgba: floatBytes([1, 1, 1, 1]),
    screenColorRgba: floatBytes([0, 0, 0, 1]),
  }],
};

test("model3 parser keeps model, motion and expression references as safe relative assets", () => {
  const parsed = parseCubismModel3(model3);
  expect(parsed).toMatchObject({
    version: 3,
    moc: "Mao.moc3",
    textures: ["Mao.2048/texture_00.png"],
    physics: "Mao.physics3.json",
    expressions: [{ name: "smile", file: "expressions/smile.exp3.json" }],
    motions: { Idle: [{ file: "motions/idle.motion3.json", fadeInTime: 0.4 }] },
    groups: [{ target: "Parameter", name: "EyeBlink", ids: ["ParamEyeLOpen", "ParamEyeROpen"] }],
  });
  expect(() => parseCubismModel3({ ...model3, FileReferences: { ...model3.FileReferences, Moc: "../outside.moc3" } })).toThrow(/safe relative/);
  expect(() => validateCubismAssetReference("https://example.com/model.moc3")).toThrow(/safe relative/);
  expect(() => validateCubismAssetReference("/tmp/model.moc3")).toThrow(/safe relative/);
});

test("motion evaluator executes linear, Bezier, stepped and inverse-stepped parameter data", () => {
  const motion = parseCubismMotion3({
    Version: 3,
    Meta: { Duration: 4, Fps: 30, Loop: false, AreBeziersRestricted: true, FadeInTime: 0.2, FadeOutTime: 0.4 },
    Curves: [
      { Target: "Parameter", Id: "linear", Segments: [0, 0, 0, 2, 4] },
      { Target: "Parameter", Id: "bezier", Segments: [0, 0, 1, 0.25, 0, 0.75, 1, 1, 1] },
      { Target: "Parameter", Id: "step", Segments: [0, 2, 2, 1, 5] },
      { Target: "Parameter", Id: "inverse", Segments: [0, 2, 3, 1, 5] },
      { Target: "PartOpacity", Id: "Hair", Segments: [0, 1, 0, 1, 0] },
      { Target: "Model", Id: "EyeBlink", Segments: [0, 1, 0, 1, 0] },
      { Target: "Model", Id: "LipSync", Segments: [0, 0, 0, 1, 1] },
      { Target: "Model", Id: "Opacity", Segments: [0, 1, 0, 1, 0] },
    ],
  });
  expect(motion).toMatchObject({ fadeInTime: 0.2, fadeOutTime: 0.4 });
  const frame = evaluateCubismMotion3(motion, 0.5);
  expect(frame.parameters).toMatchObject({ linear: 1, step: 2, inverse: 5 });
  expect(frame.parameters.bezier).toBeCloseTo(0.5, 6);
  expect(evaluateCubismMotion3(motion, 0.5).partOpacities.Hair).toBe(0.5);
  expect(frame.modelValues).toEqual({ EyeBlink: 0.5, LipSync: 0.5, Opacity: 0.5 });
  expect(() => parseCubismMotion3({ Version: 3, Meta: { Duration: 1, Fps: 30, Loop: false, AreBeziersRestricted: true }, Curves: [{ Target: "Parameter", Id: "bad", Segments: [0, 0, 1, 0.5] }] })).toThrow(/incomplete segment/);
  expect(() => parseCubismMotion3({ Version: 3, Meta: { Duration: 1, Fps: 30, Loop: false, AreBeziersRestricted: true }, Curves: [{ Target: "Model", Id: "Physics", Segments: [0, 0] }] })).toThrow(/unsupported Model target/);
});

test("expression blending modifies parameter values without running code", () => {
  const expression = parseCubismExpression3({
    Type: "Live2D Expression",
    FadeInTime: 0.2,
    FadeOutTime: 0.3,
    Parameters: [
      { Id: "add", Value: 0.5, Blend: "Add" },
      { Id: "multiply", Value: 0.25, Blend: "Multiply" },
      { Id: "overwrite", Value: 1, Blend: "Overwrite" },
    ],
  });
  expect(applyCubismExpression3({ add: 1, multiply: 2, overwrite: 0 }, expression, 0.5)).toEqual({
    add: 1.25,
    multiply: 1.25,
    overwrite: 0.5,
  });
  expect(() => parseCubismExpression3({ Type: "Live2D Expression", Parameters: [{ Id: "bad", Value: 1, Blend: "Execute" }] })).toThrow(/unsupported/);
});

test("host transport keeps model asset references, forwards Core mesh facts and releases native handles", async () => {
  const calls: Array<{ capability: string; params: Record<string, unknown> }> = [];
  const host = {
    async request(capability: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ capability, params });
      if (capability === pocketLive2dLoadCapability) return nativeModelInfo;
      if (capability === pocketLive2dUpdateCapability) return nativeFrame;
      if (capability === pocketLive2dReleaseCapability) return { released: true };
      throw new Error(`unexpected capability ${capability}`);
    },
  };
  const client = createPocketLive2dClient(host);
  const info = await client.load({ id: "mao", assetPrefix: "models/mao", manifest: parseCubismModel3(model3) });
  expect(info).toEqual(nativeModelInfo);
  expect(calls[0]).toEqual({
    capability: pocketLive2dLoadCapability,
    params: { id: "mao", mocAsset: "models/mao/Mao.moc3", textures: ["models/mao/Mao.2048/texture_00.png"] },
  });
  const frame = await client.update(
    info.modelId,
    [{ id: "ParamAngleX", value: 30 }],
    [],
    { dx: 10, dy: 20, scale: 0.5, opacity: 0.8 },
  );
  expect(frame.drawables[0]).toMatchObject({
    id: "ArtMesh01",
    textureIndex: 0,
    maskIndices: [3],
    blendMode: 0,
  });
  expect(frame.drawables[0]?.meshBytes).toBe(nativeFrame.drawables[0]!.meshBytes);
  expect(calls[1]).toEqual({
    capability: pocketLive2dUpdateCapability,
    params: {
      modelId: "native-1",
      parameters: [{ id: "ParamAngleX", value: 30 }],
      partOpacities: [],
      placement: { dx: 10, dy: 20, scale: 0.5, opacity: 0.8 },
    },
  });
  await client.release(info.modelId);
  await client.dispose();
  expect(calls.filter((call) => call.capability === pocketLive2dReleaseCapability)).toHaveLength(1);
});

test("host transport preserves the supported Core-visible memory accounting marker", async () => {
  const webModelInfo = { ...nativeModelInfo, memoryAccounting: "core-visible-buffers" };
  const client = createPocketLive2dClient({
    async request(capability: string): Promise<unknown> {
      if (capability === pocketLive2dLoadCapability) return webModelInfo;
      if (capability === pocketLive2dReleaseCapability) return { released: true };
      throw new Error(`unexpected capability ${capability}`);
    },
  });
  const info = await client.load({ id: "web", assetPrefix: "", manifest: parseCubismModel3(model3) });
  expect(info.nativeBytes).toBe(nativeModelInfo.nativeBytes);
  expect(info.memoryAccounting).toBe("core-visible-buffers");
  await client.dispose();

  const invalidClient = createPocketLive2dClient({
    async request(capability: string): Promise<unknown> {
      if (capability === pocketLive2dLoadCapability) return { ...nativeModelInfo, memoryAccounting: "wasm-heap-estimate" };
      throw new Error(`unexpected capability ${capability}`);
    },
  });
  await expect(invalidClient.load({ id: "invalid", assetPrefix: "", manifest: parseCubismModel3(model3) }))
    .rejects.toThrow(/unsupported accounting basis/);
  await invalidClient.dispose();
});

test("opt-in topology transport merges sparse native facts into a complete frame", async () => {
  const calls: Array<{ capability: string; params: Record<string, unknown> }> = [];
  let updates = 0;
  const complete = { ...nativeFrame, topologyMode: "full" };
  const sparseMesh = pms1Bytes([1, 2, 21, 2, 11, 22], [0, 0, 1, 0, 0.5, 1], [0, 1, 2], 0.4);
  const sparse = {
    modelId: nativeModelInfo.modelId,
    topologyMode: "cached-v1",
    drawables: [{
      id: "ArtMesh01",
      textureIndex: 0,
      drawOrder: 2,
      renderOrder: 4,
      blendMode: 3,
      constantFlags: 1,
      dynamicFlags: 17,
      opacity: 0.4,
      meshBytes: sparseMesh,
      multiplyColorRgba: floatBytes([1, 0.5, 0.25, 1]),
      screenColorRgba: floatBytes([0, 0.5, 0.25, 1]),
    }],
  };
  const host = {
    async request(capability: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ capability, params });
      if (capability === pocketLive2dLoadCapability) return nativeModelInfo;
      if (capability === pocketLive2dUpdateCapability) return ++updates === 1 ? complete : sparse;
      return { released: true };
    },
  };
  const client = createPocketLive2dClient(host, { cacheStaticTopology: true });
  const info = await client.load({ id: "mao", assetPrefix: "", manifest: parseCubismModel3(model3) });
  const first = await client.update(info.modelId);
  const next = await client.update(info.modelId);
  expect(calls[1]?.params.cacheStaticTopology).toBe(true);
  expect(calls[2]?.params.cacheStaticTopology).toBe(true);
  expect(next.drawables[0]).toEqual({
    id: "ArtMesh01",
    textureIndex: 0,
    drawOrder: 2,
    renderOrder: 4,
    blendMode: 3,
    constantFlags: 1,
    dynamicFlags: 17,
    opacity: 0.4,
    meshBytes: sparseMesh,
    maskIndices: first.drawables[0]!.maskIndices,
    multiplyColorRgba: [1, 0.5, 0.25, 1],
    screenColorRgba: [0, 0.5, 0.25, 1],
  });
  await client.dispose();
});

test("topology cache is cleared on release and a sparse first frame is rejected", async () => {
  let updateCount = 0;
  let released = false;
  const host = {
    async request(capability: string): Promise<unknown> {
      if (capability === pocketLive2dLoadCapability) return nativeModelInfo;
      if (capability === pocketLive2dUpdateCapability) {
        updateCount++;
        if (updateCount === 1) return { ...nativeFrame, topologyMode: "full" };
        if (released) return {
          modelId: nativeModelInfo.modelId,
          topologyMode: "cached-v1",
          drawables: [{
            id: "ArtMesh01",
            textureIndex: 0,
            drawOrder: 0,
            renderOrder: 0,
            blendMode: 0,
            constantFlags: 0,
            dynamicFlags: 33,
            opacity: 1,
            meshBytes: nativeFrame.drawables[0]!.meshBytes,
            multiplyColorRgba: floatBytes([1, 1, 1, 1]),
            screenColorRgba: floatBytes([0, 0, 0, 1]),
          }],
        };
        return nativeFrame;
      }
      if (capability === pocketLive2dReleaseCapability) {
        released = true;
        return { released: true };
      }
      throw new Error(`unexpected capability ${capability}`);
    },
  };
  const client = createPocketLive2dClient(host, { cacheStaticTopology: true });
  const firstLoad = await client.load({ id: "mao", assetPrefix: "", manifest: parseCubismModel3(model3) });
  await client.update(firstLoad.modelId);
  await client.release(firstLoad.modelId);
  const secondLoad = await client.load({ id: "mao", assetPrefix: "", manifest: parseCubismModel3(model3) });
  await expect(client.update(secondLoad.modelId)).rejects.toThrow(/before its full frame/);
  await client.dispose();
});

test("host updates serialize per model and asset traversal never reaches the host", async () => {
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let updates = 0;
  const host = {
    async request(capability: string): Promise<unknown> {
      calls.push(capability);
      if (capability === pocketLive2dLoadCapability) return nativeModelInfo;
      if (capability === pocketLive2dUpdateCapability) {
        updates++;
        if (updates === 1) { markFirstStarted!(); await firstGate; }
        return nativeFrame;
      }
      return { released: true };
    },
  };
  const client = createPocketLive2dClient(host);
  const info = await client.load({ id: "mao", assetPrefix: "models/mao", manifest: parseCubismModel3(model3) });
  const one = client.update(info.modelId);
  const two = client.update(info.modelId);
  await firstStarted;
  expect(updates).toBe(1);
  releaseFirst!();
  await Promise.all([one, two]);
  expect(updates).toBe(2);
  await client.release(info.modelId);
  const before = calls.length;
  await expect(client.load({ id: "bad", assetPrefix: "models/../private", manifest: parseCubismModel3(model3) })).rejects.toThrow(/safe relative/);
  expect(calls).toHaveLength(before);
  await client.dispose();
});

test("empty source directory resolves manifest files as root-relative allowlist keys", async () => {
  const calls: Array<{ capability: string; params: Record<string, unknown> }> = [];
  const host = {
    async request(capability: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ capability, params });
      if (capability === pocketLive2dLoadCapability) return nativeModelInfo;
      if (capability === pocketLive2dUpdateCapability) return nativeFrame;
      return { released: true };
    },
  };
  const client = createPocketLive2dClient(host);
  await client.load({ id: "mao", assetPrefix: "", manifest: parseCubismModel3(model3) });
  expect(calls[0]?.params).toEqual({
    id: "mao",
    mocAsset: "Mao.moc3",
    textures: ["Mao.2048/texture_00.png"],
  });
  await client.dispose();
});

test("dispose waits for pending load and releases a late native handle", async () => {
  let finishLoad: ((value: unknown) => void) | undefined;
  const calls: string[] = [];
  const host = {
    request(capability: string): Promise<unknown> {
      calls.push(capability);
      if (capability === pocketLive2dLoadCapability) {
        return new Promise((resolve) => { finishLoad = resolve; });
      }
      return Promise.resolve({ released: true });
    },
  };
  const client = createPocketLive2dClient(host);
  const loading = client.load({ id: "mao", assetPrefix: "", manifest: parseCubismModel3(model3) });
  const disposing = client.dispose();
  finishLoad!(nativeModelInfo);
  await expect(loading).rejects.toThrow(/disposed while a model was loading/);
  await disposing;
  expect(calls).toEqual([pocketLive2dLoadCapability, pocketLive2dReleaseCapability]);
});

test("host parser preserves Core drawables that have no topology", async () => {
  const host = {
    async request(capability: string): Promise<unknown> {
      if (capability === pocketLive2dLoadCapability) return nativeModelInfo;
      if (capability === pocketLive2dUpdateCapability) {
        return {
          modelId: nativeModelInfo.modelId,
          drawables: [{
            id: "ArtMeshEmpty",
            textureIndex: -1,
            drawOrder: 0,
            renderOrder: 0,
            blendMode: 0,
            constantFlags: 0,
            dynamicFlags: 0,
            opacity: 0,
            meshBytes: new Uint8Array(0),
            maskIndices: new Uint8Array(0),
            multiplyColorRgba: floatBytes([1, 1, 1, 1]),
            screenColorRgba: floatBytes([0, 0, 0, 1]),
          }],
        };
      }
      return { released: true };
    },
  };
  const client = createPocketLive2dClient(host);
  const model = await client.load({ id: "empty", assetPrefix: "", manifest: parseCubismModel3(model3) });
  const frame = await client.update(model.modelId);
  expect(frame.drawables[0]).toMatchObject({
    id: "ArtMeshEmpty",
    textureIndex: -1,
    meshBytes: new Uint8Array(0),
  });
  await client.dispose();
});

function pms1Bytes(
  positions: readonly number[],
  uvs: readonly number[],
  indices: readonly number[],
  opacity = 1,
): Uint8Array {
  const n = positions.length / 2;
  const m = indices.length;
  const bytes = new Uint8Array(16 + n * 16 + m * 4);
  const view = new DataView(bytes.buffer);
  const opacityByte = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  view.setUint32(0, 0x31534d50, true);
  view.setUint32(4, n, true);
  view.setUint32(8, m, true);
  view.setUint32(12, ((opacityByte << 24) | 0xffffff) >>> 0, true);
  for (let i = 0; i < n; i++) {
    view.setFloat32(16 + i * 16, positions[i * 2]!, true);
    view.setFloat32(20 + i * 16, positions[i * 2 + 1]!, true);
    view.setFloat32(24 + i * 16, uvs[i * 2]!, true);
    view.setFloat32(28 + i * 16, 1 - uvs[i * 2 + 1]!, true);
  }
  for (let i = 0; i < m; i++) {
    view.setUint32(16 + n * 16 + i * 4, indices[i]!, true);
  }
  return bytes;
}

function floatBytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function uint16Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

function uint32Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}
