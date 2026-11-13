import { expect, test } from "bun:test";
import { createCubismInteractionController } from "../src/interaction.ts";
import { parseCubismModel3 } from "../src/manifest.ts";
import type { PocketLive2dDrawableFrame } from "../src/transport.ts";

function triangleMesh(points: readonly number[], indices: readonly number[] = [0, 1, 2]): Uint8Array {
  const bytes = new Uint8Array(16 + 3 * 16 + indices.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x31534d50, true);
  view.setUint32(4, 3, true);
  view.setUint32(8, indices.length, true);
  view.setUint32(12, 0xffff_ffff, true);
  for (let index = 0; index < 3; index++) {
    view.setFloat32(16 + index * 16, points[index * 2]!, true);
    view.setFloat32(20 + index * 16, points[index * 2 + 1]!, true);
  }
  indices.forEach((value, index) => view.setUint32(64 + index * 4, value, true));
  return bytes;
}

const emptyMetadata = {
  textureIndex: 0,
  drawOrder: 0,
  renderOrder: 0,
  blendMode: 0,
  constantFlags: 0,
  dynamicFlags: 1,
  opacity: 1,
  maskIndices: [],
  multiplyColorRgba: [1, 1, 1, 1],
  screenColorRgba: [0, 0, 0, 0],
} as const;

test("Cubism model3 parser preserves optional declared hit areas and validates their drawable IDs", () => {
  const root = {
    Version: 3,
    FileReferences: { Moc: "model.moc3", Textures: ["texture.png"] },
    HitAreas: [{ Id: "HitArea", Name: "Body" }],
  };
  expect(parseCubismModel3(root).hitAreas).toEqual([{ id: "HitArea", name: "Body" }]);
  expect(parseCubismModel3({ ...root, HitAreas: undefined }).hitAreas).toEqual([]);
  expect(() => parseCubismModel3({ ...root, HitAreas: [{ Id: "HitArea", Name: "Body" }, { Id: "HitArea", Name: "Head" }] })).toThrow(/must be unique/);
});

test("HitArea uses its current Core mesh, including declared non-rendered helper meshes", () => {
  const controller = createCubismInteractionController({
    hitAreas: [{ id: "HitArea", name: "Body" }],
    parameters: [],
    canvas: { widthPixels: 100, heightPixels: 100, originXPixels: 50, originYPixels: 50 },
    placement: { dx: 0, dy: 0, scale: 1 },
  });
  const drawables: readonly PocketLive2dDrawableFrame[] = [{
    ...emptyMetadata,
    id: "HitArea",
    dynamicFlags: 0,
    opacity: 0,
    meshBytes: triangleMesh([0, 0, 20, 0, 0, 20]),
  }];
  expect(controller.hitAreaAt(drawables, { x: 3, y: 4 })?.name).toBe("Body");
  expect(controller.hitAreaAt(drawables, { x: 20, y: 20 })).toBeUndefined();
});

test("HitArea ignores degenerate triangles instead of accepting every point", () => {
  const controller = createCubismInteractionController({
    hitAreas: [{ id: "HitArea", name: "Body" }],
    parameters: [],
    canvas: { widthPixels: 100, heightPixels: 100, originXPixels: 50, originYPixels: 50 },
    placement: { dx: 0, dy: 0, scale: 1 },
  });
  const drawables: readonly PocketLive2dDrawableFrame[] = [{
    ...emptyMetadata,
    id: "HitArea",
    meshBytes: triangleMesh([2, 2, 2, 2, 2, 2]),
  }];
  expect(controller.hitAreaAt(drawables, { x: 200, y: -90 })).toBeUndefined();
});

test("drag maps placement-adjusted pointer positions through Core-provided parameter limits", () => {
  const controller = createCubismInteractionController({
    hitAreas: [],
    parameters: [
      { id: "ParamAngleX", minimum: -30, maximum: 30, defaultValue: 0 },
      { id: "ParamAngleY", minimum: -20, maximum: 40, defaultValue: 5 },
      { id: "ParamAngleZ", minimum: -10, maximum: 10, defaultValue: 0 },
      { id: "ParamBodyAngleX", minimum: -10, maximum: 10, defaultValue: 0 },
      { id: "NotAnAngle", minimum: -1, maximum: 1, defaultValue: 0 },
    ],
    canvas: { widthPixels: 200, heightPixels: 100, originXPixels: 100, originYPixels: 50 },
    placement: { dx: 20, dy: 10, scale: 2 },
  });
  const center = controller.dragParameters({ x: 220, y: 110 });
  expect(center).toEqual([
    { id: "ParamAngleX", value: 0 },
    { id: "ParamAngleY", value: 5 },
    { id: "ParamAngleZ", value: 0 },
    { id: "ParamBodyAngleX", value: 0 },
  ]);
  expect(controller.dragParameters({ x: 420, y: 10 })).toEqual([
    { id: "ParamAngleX", value: 30 },
    { id: "ParamAngleY", value: 40 },
    { id: "ParamAngleZ", value: 10 },
    { id: "ParamBodyAngleX", value: 3.5 },
  ]);
  expect(controller.dragParameters({ x: 2000, y: -1000 })[0]?.value).toBe(30);
});
