import { expect, test } from "bun:test";
import { createNovelLive2dFactory } from "../src/live2d.ts";
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

test("Live2D factory preserves native facts, evaluates JS motion, flips Core UV and resolves masks before paint order", async () => {
  const calls: { capability: string; params: Record<string, unknown> }[] = [];
  const host = { async request(capability: string, params: Record<string, unknown>) {
    calls.push({ capability, params });
    if (capability.endsWith("load")) return { modelId: "core-1", drawableCount: 5, mocVersion: 5, nativeBytes: 1024, parameterCount: 4, parameterDefaults: [{ id: "Eye", value: 1 }, { id: "OtherEye", value: 0.6 }, { id: "Mouth", value: 0.1 }], canvas: { widthPixels: 100, heightPixels: 100, originXPixels: 50, originYPixels: 50, pixelsPerUnit: 100 } };
    if (capability.endsWith("release")) return { released: true };
    const angle = (params.parameters as { id: string; value: number }[]).find(value => value.id === "Angle")!.value;
    const drawable = (id: string, renderOrder: number) => ({ id, textureIndex: 0, drawOrder: renderOrder, renderOrder, blendMode: 0, constantFlags: 0, dynamicFlags: 1, opacity: 1, positionsXYPixels: [angle, 0, 100, 0, 0, 100], uvs: [0, 1, 1, 1, 0, 0], indices: [0, 1, 2], maskIndices: [] as number[], multiplyColorRgba: [1, 1, 1, 1], screenColorRgba: [0, 0, 0, 0] });
    const mask = drawable("mask", 5);
    mask.uvs[0] = -0.0003222227; // Real official Hiyori atlas edge behavior.
    mask.dynamicFlags = 0;
    const art = drawable("art", 1);
    art.maskIndices = [0, 2];
    art.constantFlags = 8;
    const empty = { ...drawable("empty", 0), positionsXYPixels: [], uvs: [], indices: [] };
    const emptyNormal = { ...drawable("emptyNormal", 2), maskIndices: [2] };
    const emptyInverted = { ...drawable("emptyInverted", 3), maskIndices: [2], constantFlags: 8 };
    return { modelId: "core-1", drawables: [mask, art, empty, emptyNormal, emptyInverted] };
  } };
  const factory = createNovelLive2dFactory(host, { [definition.source]: { document, motions: { "Idle:0": motion }, expressions: { half: expression } } });
  const instance = await factory(definition, { key: "actor", expression: "half" });
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
  expect(second[0]!.geometry).toBe(first[0]!.geometry);
  expect(data.getFloat32(16, true)).toBeGreaterThan(initialX);
  expect(calls.find(call => call.capability.endsWith("load"))?.params.mocAsset).toBe("models/actor.moc3");
  const parameters = calls.find(call => call.capability.endsWith("update"))?.params.parameters as { id: string; value: number }[];
  expect(parameters.find(value => value.id === "Eye")?.value).toBe(0.4);
  expect(parameters.find(value => value.id === "OtherEye")?.value).toBe(0.8);
  expect(parameters.find(value => value.id === "Mouth")?.value).toBeCloseTo(0.3);
  instance.dispose();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(calls.filter(call => call.capability.endsWith("release"))).toHaveLength(1);
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
