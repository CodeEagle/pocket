import { expect, test } from "bun:test";
import { createNovelLive2dFactory } from "../src/live2d.ts";
import { encodeNovelMesh } from "../src/mesh.ts";
import { encodeNovelMeshEffect } from "../src/mesh-effect.ts";
import type { NovelModelDefinition } from "../src/models.ts";

const definition: NovelModelDefinition = { kind: "live2d", source: "models/actor.model3.json", textures: { "texture.png": "art/actor.png" }, animations: ["Idle:0"] };
const document = { Version: 3, FileReferences: { Moc: "actor.moc3", Textures: ["texture.png"] }, Groups: [
  { Target: "Parameter", Name: "EyeBlink", Ids: ["Eye", "OtherEye"] },
  { Target: "Parameter", Name: "LipSync", Ids: ["Mouth"] },
] };
const motion = { Version: 3, Meta: { Duration: 2, Fps: 30, Loop: true, AreBeziersRestricted: true }, Curves: [
  { Target: "Parameter", Id: "Angle", Segments: [0, 0, 0, 2, 20] },
  { Target: "Parameter", Id: "Eye", Segments: [0, 1] },
  { Target: "Model", Id: "EyeBlink", Segments: [0, 0.8] },
  { Target: "Model", Id: "LipSync", Segments: [0, 0.2] },
  { Target: "Model", Id: "Opacity", Segments: [0, 0.4] },
] };
const expression = { Type: "Live2D Expression", Parameters: [{ Id: "Eye", Value: 0.5, Blend: "Multiply" }] };

function packMockNativePms1(
  positions: readonly number[],
  uvs: readonly number[],
  indices: readonly number[],
  drawableOpacity: number,
  placement: { dx: number; dy: number; scale: number; opacity?: number },
): Uint8Array {
  if (positions.length === 0 || indices.length === 0) return new Uint8Array(0);
  const vertices = new Float32Array(positions.length * 2);
  for (let i = 0; i < positions.length / 2; i++) {
    vertices[i * 4] = placement.dx + positions[i * 2]! * placement.scale;
    vertices[i * 4 + 1] = placement.dy + positions[i * 2 + 1]! * placement.scale;
    vertices[i * 4 + 2] = uvs[i * 2]!;
    vertices[i * 4 + 3] = 1 - uvs[i * 2 + 1]!;
  }
  const opacity = Math.round(Math.max(0, Math.min(1, drawableOpacity * (placement.opacity ?? 1))) * 255);
  return encodeNovelMesh({ vertices, indices, color: ((opacity << 24) | 0xffffff) >>> 0 });
}

test("Live2D factory preserves native facts, evaluates JS motion, forwards placement and passes native PMS1 bytes straight through", async () => {
  const calls: { capability: string; params: Record<string, unknown> }[] = [];
  const host = { async request(capability: string, params: Record<string, unknown>) {
    calls.push({ capability, params });
    if (capability.endsWith("load")) return { modelId: "core-1", drawableCount: 5, mocVersion: 5, nativeBytes: 1024, parameterCount: 4, parameterDefaults: [{ id: "Eye", value: 1 }, { id: "OtherEye", value: 0.6 }, { id: "Mouth", value: 0.1 }], canvas: { widthPixels: 100, heightPixels: 100, originXPixels: 50, originYPixels: 50, pixelsPerUnit: 100 } };
    if (capability.endsWith("release")) return { released: true };
    const angle = (params.parameters as { id: string; value: number }[]).find(value => value.id === "Angle")!.value;
    const placement = params.placement as { dx: number; dy: number; scale: number; opacity?: number };
    const drawable = (id: string, renderOrder: number, u0 = 0) => ({
      id,
      textureIndex: 0,
      drawOrder: renderOrder,
      renderOrder,
      blendMode: 0,
      constantFlags: 0,
      dynamicFlags: 1,
      opacity: 1,
      meshBytes: packMockNativePms1([angle, 0, 100, 0, 0, 100], [u0, 1, 1, 1, 0, 0], [0, 1, 2], 1, placement),
      maskIndices: [] as number[],
      multiplyColorRgba: [1, 1, 1, 1],
      screenColorRgba: [0, 0, 0, 0],
    });
    const mask = drawable("mask", 5, -0.0003222227); // Real official Hiyori atlas edge behavior.
    mask.dynamicFlags = 0;
    const art = drawable("art", 1);
    art.maskIndices = [0, 2];
    art.constantFlags = 8;
    const empty = { ...drawable("empty", 0), meshBytes: new Uint8Array(0) };
    const emptyNormal = { ...drawable("emptyNormal", 2), maskIndices: [2] };
    const emptyInverted = { ...drawable("emptyInverted", 3), maskIndices: [2], constantFlags: 8 };
    return { modelId: "core-1", drawables: [mask, art, empty, emptyNormal, emptyInverted] };
  } };
  const factory = createNovelLive2dFactory(host, { [definition.source]: { document, motions: { "Idle:0": motion }, expressions: { half: expression } } });
  const instance = await factory(definition, { key: "actor", expression: "half" });
  expect(instance.hitTest).toBeUndefined(); // Interactions remain opt-in for existing model registries.
  const first = await instance.advance(500);
  expect(first.map(mesh => mesh.id)).toEqual(["art", "emptyNormal", "emptyInverted", "mask"]);
  expect(first[0]!.effect?.masks).toEqual(["mask"]);
  expect(first[0]!.effect?.inverted).toBe(true);
  expect(first[1]!.visible).toBe(false);
  expect(first[2]!.visible).toBe(true);
  expect(first[2]!.effect?.inverted).toBe(false); // Empty inverted union passes without an invalid mask flag.
  expect(first[3]!.visible).toBe(false);
  expect(first.every(mesh => mesh.effect?.repeatTexture)).toBe(true);
  expect(new DataView(first[3]!.geometry.buffer).getFloat32(24, true)).toBeCloseTo(-0.0003222227, 9);
  const data = new DataView(first[0]!.geometry.buffer);
  expect(data.getFloat32(28, true)).toBe(0); // First Core v=1 becomes top-left v=0.
  expect(data.getUint32(12, true) >>> 24).toBe(102); // Model opacity multiplies Core drawable opacity.
  const initialX = data.getFloat32(16, true);
  const second = await instance.advance(500);
  const secondData = new DataView(second[0]!.geometry.buffer);
  expect(secondData.getFloat32(16, true)).toBeGreaterThan(initialX);
  expect(calls.find(call => call.capability.endsWith("load"))?.params.mocAsset).toBe("models/actor.moc3");
  const updateCall = calls.find(call => call.capability.endsWith("update"))?.params;
  expect(updateCall?.placement).toEqual({
    dx: (240 - 100 * 2.2) / 2,
    dy: 340 - 100 * 2.2,
    scale: 2.2,
    opacity: 0.4,
  });
  const parameters = updateCall?.parameters as { id: string; value: number }[];
  expect(parameters.find(value => value.id === "Eye")?.value).toBe(0.4);
  expect(parameters.find(value => value.id === "OtherEye")?.value).toBe(0.8);
  expect(parameters.find(value => value.id === "Mouth")?.value).toBeCloseTo(0.3);
  instance.dispose();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(calls.filter(call => call.capability.endsWith("release"))).toHaveLength(1);
});

test("interactive Live2D hit areas trigger transient Tap motions and Core-ranged drag parameters", async () => {
  const interactionDocument = { ...document, HitAreas: [{ Id: "HitArea", Name: "Body" }] };
  const mainMotion = { Version: 3, Meta: { Duration: 2, Fps: 30, Loop: true, AreBeziersRestricted: true }, Curves: [
    { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 5, 0, 2, 5] },
  ] };
  const tapMotion = { Version: 3, Meta: { Duration: 1, Fps: 30, Loop: true, AreBeziersRestricted: true }, Curves: [
    { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 20, 0, 1, 0] },
  ] };
  const updates: { id: string; value: number }[][] = [];
  const host = { async request(capability: string, params: Record<string, unknown>) {
    if (capability.endsWith("load")) return {
      modelId: "interactive-1", drawableCount: 1, mocVersion: 5, nativeBytes: 1024, parameterCount: 4,
      parameterDefaults: [
        { id: "ParamAngleX", value: 0 }, { id: "ParamAngleY", value: 0 },
        { id: "ParamAngleZ", value: 0 }, { id: "ParamBodyAngleX", value: 0 },
      ],
      parameterMetadata: [
        { id: "ParamAngleX", minimum: -30, maximum: 30, defaultValue: 0 },
        { id: "ParamAngleY", minimum: -30, maximum: 30, defaultValue: 0 },
        { id: "ParamAngleZ", minimum: -30, maximum: 30, defaultValue: 0 },
        { id: "ParamBodyAngleX", minimum: -10, maximum: 10, defaultValue: 0 },
      ],
      canvas: { widthPixels: 100, heightPixels: 100, originXPixels: 50, originYPixels: 50, pixelsPerUnit: 100 },
    };
    if (capability.endsWith("release")) return { released: true };
    const parameters = params.parameters as { id: string; value: number }[];
    updates.push(parameters);
    const placement = params.placement as { dx: number; dy: number; scale: number; opacity?: number };
    return { modelId: "interactive-1", drawables: [{
      id: "HitArea", textureIndex: 0, drawOrder: 0, renderOrder: 0, blendMode: 0,
      constantFlags: 0, dynamicFlags: 0, opacity: 0,
      // HitArea remains usable when its helper ArtMesh is intentionally not painted.
      meshBytes: packMockNativePms1([0, 0, 100, 0, 0, 100], [0, 0, 1, 0, 0, 1], [0, 1, 2], 0, placement),
      maskIndices: [], multiplyColorRgba: [1, 1, 1, 1], screenColorRgba: [0, 0, 0, 0],
    }] };
  } };
  const interactiveDefinition: NovelModelDefinition = { ...definition, interactive: true };
  const factory = createNovelLive2dFactory(host, { [definition.source]: {
    document: interactionDocument,
    motions: { "Idle:0": mainMotion, "TapBody:0": tapMotion },
    expressions: {},
  } });
  const instance = await factory(interactiveDefinition, { key: "actor", animation: "Idle:0", loop: true });
  await instance.advance(0);
  expect(instance.hitTest?.({ x: 20, y: 130 })).toBe(true);
  expect(instance.hitTest?.({ x: 230, y: 340 })).toBe(false);
  expect(instance.tap?.({ x: 20, y: 130 })).toBe(true);
  await instance.advance(0);
  expect(updates.at(-1)!.find(value => value.id === "ParamAngleX")!.value).toBe(20);

  instance.drag?.({ x: 230, y: 120 });
  await instance.advance(0);
  const tracked = Object.fromEntries(updates.at(-1)!.map(value => [value.id, value.value]));
  expect(tracked.ParamAngleX).toBeCloseTo(30);
  expect(tracked.ParamAngleY).toBeCloseTo(30);
  expect(tracked.ParamAngleZ).toBeCloseTo(30);
  expect(tracked.ParamBodyAngleX).toBeCloseTo(3.5);
  instance.endDrag?.();
  await instance.advance(1000); // Finish the temporary TapBody motion.
  await instance.advance(0);
  expect(updates.at(-1)!.find(value => value.id === "ParamAngleX")!.value).toBe(5);
  instance.dispose();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
});

test("referenced Live2D physics must be bundled and MFX1 validation preserves reused buffers on failure", async () => {
  const factory = createNovelLive2dFactory({ async request() { throw new Error("must not reach native"); } }, { [definition.source]: { document: { ...document, FileReferences: { ...document.FileReferences, Physics: "actor.physics3.json" } }, motions: {}, expressions: {} } });
  await expect(factory(definition, { key: "actor" })).rejects.toThrow("physics source was not bundled");
  const bytes = encodeNovelMeshEffect({ blend: "screen", masks: ["mask"], inverted: true, repeatTexture: true, multiplyRgb: [0.5, 1, 1] }, () => 12);
  const data = new DataView(bytes.buffer);
  expect(data.getUint32(0, true)).toBe(0x3158464d);
  expect(data.getUint32(4, true)).toBe(3);
  expect(data.getUint32(8, true)).toBe(1);
  expect(data.getUint32(12, true)).toBe(3);
  expect(data.getFloat32(16, true)).toBe(0.5);
  expect(data.getUint32(40, true)).toBe(12);
  const before = [...bytes];
  expect(() => encodeNovelMeshEffect({ blend: "add", screenRgb: [NaN, 0, 0] }, () => 0, bytes)).toThrow();
  expect(() => encodeNovelMeshEffect({ blend: "normal", inverted: true }, () => 12, bytes)).toThrow();
  expect(() => encodeNovelMeshEffect({ blend: "normal", masks: ["same", "same"] }, () => 12, bytes)).toThrow();
  expect([...bytes]).toEqual(before);
});

test("Live2D runs official physics and pose in JS before passing real Core parameter and part values", async () => {
  const dynamicsManifest = {
    ...document,
    FileReferences: { ...document.FileReferences, Physics: "actor.physics3.json", Pose: "actor.pose3.json" },
  };
  const physics3 = {
    Version: 3,
    Meta: { PhysicsSettingCount: 1, TotalInputCount: 1, TotalOutputCount: 1, VertexCount: 2, Fps: 30, EffectiveForces: { Gravity: { X: 0, Y: -1 }, Wind: { X: 0, Y: 0 } } },
    PhysicsSettings: [{
      Input: [{ Source: { Target: "Parameter", Id: "ParamAngleX" }, Weight: 100, Type: "X", Reflect: false }],
      Output: [{ Destination: { Target: "Parameter", Id: "ParamHairFront" }, VertexIndex: 1, Scale: 1.5, Weight: 100, Type: "Angle", Reflect: false }],
      Vertices: [
        { Position: { X: 0, Y: 0 }, Mobility: 0, Delay: 0, Acceleration: 0, Radius: 0 },
        { Position: { X: 0, Y: 10 }, Mobility: 1, Delay: 0.5, Acceleration: 1, Radius: 10 },
      ],
      Normalization: { Position: { Minimum: -30, Maximum: 30, Default: 0 }, Angle: { Minimum: -30, Maximum: 30, Default: 0 } },
    }],
  };
  const pose3 = { Type: "Live2D Pose", FadeInTime: 0.5, Groups: [[{ Id: "PartArmA", Link: [] }, { Id: "PartArmB", Link: [] }]] };
  const motion3 = {
    Version: 3,
    Meta: { Duration: 2, Fps: 30, Loop: false, AreBeziersRestricted: true },
    Curves: [
      { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 2, 30] },
      { Target: "PartOpacity", Id: "PartArmA", Segments: [0, 1, 0, 2, 0] },
      { Target: "PartOpacity", Id: "PartArmB", Segments: [0, 0, 0, 2, 1] },
    ],
  };
  const calls: { capability: string; params: Record<string, unknown> }[] = [];
  const host = { async request(capability: string, params: Record<string, unknown>) {
    calls.push({ capability, params });
    if (capability.endsWith("load")) return {
      modelId: "dynamics-1", drawableCount: 0, mocVersion: 5, nativeBytes: 4096, parameterCount: 2,
      parameterDefaults: [{ id: "ParamAngleX", value: 0 }, { id: "ParamHairFront", value: 0 }],
      parameterMetadata: [
        { id: "ParamAngleX", minimum: -30, maximum: 30, defaultValue: 0 },
        { id: "ParamHairFront", minimum: -10, maximum: 10, defaultValue: 0 },
      ],
      parts: [{ id: "PartArmA", defaultOpacity: 1 }, { id: "PartArmB", defaultOpacity: 1 }],
      canvas: { widthPixels: 100, heightPixels: 100, originXPixels: 50, originYPixels: 50, pixelsPerUnit: 100 },
    };
    if (capability.endsWith("update")) return { modelId: "dynamics-1", drawables: [] };
    return { modelId: "dynamics-1", released: true };
  } };
  const source = {
    document: dynamicsManifest,
    physics: physics3,
    pose: pose3,
    motions: { "Idle:0": motion3 },
    expressions: {},
  };
  const factory = createNovelLive2dFactory(host, { [definition.source]: source });
  const instance = await factory(definition, { key: "actor", animation: "Idle:0", loop: false });
  await instance.advance(1500);
  const firstUpdate = calls.filter(call => call.capability.endsWith("update")).at(-1)!.params;
  const firstParameters = firstUpdate.parameters as { id: string; value: number }[];
  const firstParts = Object.fromEntries((firstUpdate.partOpacities as { id: string; value: number }[]).map(value => [value.id, value.value]));
  expect(Math.abs(firstParameters.find(value => value.id === "ParamHairFront")!.value)).toBeGreaterThan(0.001);
  expect(firstParts).toMatchObject({ PartArmA: 1, PartArmB: 0 }); // Cubism Pose consumes the two PartOpacity curves as virtual parameters.

  await instance.advance(0);
  const pausedUpdate = calls.filter(call => call.capability.endsWith("update")).at(-1)!.params;
  const pausedHair = (pausedUpdate.parameters as { id: string; value: number }[]).find(value => value.id === "ParamHairFront")!.value;
  expect(pausedHair).toBe(firstParameters.find(value => value.id === "ParamHairFront")!.value);

  await instance.advance(500);
  const resumedUpdate = calls.filter(call => call.capability.endsWith("update")).at(-1)!.params;
  expect(Object.fromEntries((resumedUpdate.partOpacities as { id: string; value: number }[]).map(value => [value.id, value.value]))).toMatchObject({ PartArmA: 0, PartArmB: 1 });
  await instance.advance(1_000_000);
  const boundedUpdate = calls.filter(call => call.capability.endsWith("update")).at(-1)!.params;
  expect((boundedUpdate.parameters as { id: string; value: number }[]).every(value => Number.isFinite(value.value))).toBe(true);
  instance.dispose();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(calls.filter(call => call.capability.endsWith("release"))).toHaveLength(1);
});
