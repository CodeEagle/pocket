import { expect, test } from "bun:test";
import { encodeNovelMesh } from "../src/mesh.ts";
import { createNovelSkinFrameGeometry, createNovelSkinIconGeometry, isNovelAssetSkin, type NovelAssetSkinFrame, type NovelAssetSkinIcons } from "../src/skin.ts";

const frame: NovelAssetSkinFrame = {
  image: "art/ui/harbor-frame.png",
  width: 512,
  height: 512,
  inset: 122,
};

test("skin metadata accepts the shared frame shape and rejects unknown or unsafe fields", () => {
  expect(isNovelAssetSkin({ frame })).toBe(true);
  expect(isNovelAssetSkin({ frame, extra: true })).toBe(false);
  expect(isNovelAssetSkin({ frame: { ...frame, extra: 1 } })).toBe(false);
  expect(isNovelAssetSkin({ frame: { ...frame, width: 0 } })).toBe(false);
  expect(isNovelAssetSkin({ frame: { ...frame, height: Number.POSITIVE_INFINITY } })).toBe(false);
  expect(isNovelAssetSkin({ frame: { ...frame, inset: 627 } })).toBe(false);
  expect(isNovelAssetSkin({ frame: { ...frame, inset: 1.5 } })).toBe(false);
});

test("9-slice geometry keeps the source UV inset while clamping target borders", () => {
  const geometry = createNovelSkinFrameGeometry(frame, 100, 60, 40);
  expect(geometry.vertices).toHaveLength(64);
  expect(geometry.indices).toHaveLength(54);
  expect(Array.from(geometry.vertices.slice(0, 4))).toEqual([0, 0, 0, 0]);
  expect(Array.from(geometry.vertices.slice(4, 8)).slice(0, 2)).toEqual([30, 0]);
  expect(geometry.vertices[6]).toBeCloseTo(122 / 512, 6);
  expect(Array.from(geometry.vertices.slice(12, 16))).toEqual([100, 0, 1, 0]);
  expect(Array.from(geometry.vertices.slice(48, 52))).toEqual([0, 60, 0, 1]);
  expect(Array.from(geometry.vertices.slice(60, 64))).toEqual([100, 60, 1, 1]);

  const encoded = encodeNovelMesh(geometry);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  expect(view.getUint32(0, true)).toBe(0x31534d50);
  expect(view.getUint32(4, true)).toBe(16);
  expect(view.getUint32(8, true)).toBe(54);
});

test("narrow skin targets collapse border safely and invalid mesh sizes are rejected", () => {
  const geometry = createNovelSkinFrameGeometry(frame, 20, 12, 40);
  expect(Array.from(geometry.vertices.slice(4, 8)).slice(0, 2)).toEqual([6, 0]);
  expect(geometry.vertices[6]).toBeCloseTo(122 / 512, 6);
  expect(Array.from(geometry.vertices.slice(20, 24)).slice(0, 2)).toEqual([6, 6]);
  expect(geometry.vertices[22]).toBeCloseTo(122 / 512, 6);
  expect(geometry.vertices[23]).toBeCloseTo(122 / 512, 6);
  expect(Array.from(geometry.vertices.slice(24, 28)).slice(0, 2)).toEqual([14, 6]);
  expect(geometry.vertices[26]).toBeCloseTo(390 / 512, 6);
  expect(() => createNovelSkinFrameGeometry(frame, 0, 12, 4)).toThrow("dimensions");
  expect(() => createNovelSkinFrameGeometry(frame, 20, 12, Number.NaN)).toThrow("border");
  expect(createNovelSkinFrameGeometry(frame, 20.5, 12.25, 2.75).vertices[4]).toBeCloseTo(2.75);
});

test("optional primary texture and named icon cells share the image skin contract", () => {
  const icons: NovelAssetSkinIcons = { image: "art/ui/icons.png", width: 512, height: 512, columns: 4, rows: 4, names: ["compass", "book", "rewind", "wave", "play"] };
  expect(isNovelAssetSkin({ frame, accentFrame: frame, icons })).toBe(true);
  expect(isNovelAssetSkin({ frame, icons: { ...icons, names: ["play", "play"] } })).toBe(false);
  expect(isNovelAssetSkin({ frame, icons: { ...icons, names: Array.from({ length: 17 }, (_, i) => `icon-${i}`) } })).toBe(false);
  expect(isNovelAssetSkin({ frame, icons: { ...icons, columns: 0 } })).toBe(false);
  expect(isNovelAssetSkin({ frame, icons: { ...icons, names: ["../escape"] } })).toBe(false);
  expect(isNovelAssetSkin({ frame, accentFrame: { ...frame, inset: 256 } })).toBe(false);
  const topRight = createNovelSkinIconGeometry(icons, "wave", 24, 24)!;
  expect(Array.from(topRight.vertices)).toEqual([0, 0, .75, 0, 24, 0, 1, 0, 0, 24, .75, .25, 24, 24, 1, .25]);
  const secondRow = createNovelSkinIconGeometry(icons, "play", 20, 18)!;
  expect(Array.from(secondRow.vertices)).toEqual([0, 0, 0, .25, 20, 0, .25, .25, 0, 18, 0, .5, 20, 18, .25, .5]);
  expect(createNovelSkinIconGeometry(icons, "absent", 24, 24)).toBeUndefined();
  expect(() => createNovelSkinIconGeometry(icons, "play", 0, 24)).toThrow("dimensions");
  const encoded = encodeNovelMesh(secondRow);
  expect(new DataView(encoded.buffer, encoded.byteOffset).getUint32(4, true)).toBe(4);
});
