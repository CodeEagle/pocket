import type { NovelModelEffect } from "./models.ts";

/** MFX1: the same retained image node owns its geometry and compositing. */
export function encodeNovelMeshEffect(effect: NovelModelEffect, resolveMask: (id: string) => number, reuse?: Uint8Array): Uint8Array {
  const blends = { normal: 0, add: 1, multiply: 2, screen: 3 };
  const blend = blends[effect.blend];
  if (blend === undefined) throw new Error(`Unsupported mesh blend: ${effect.blend}`);
  const masks = (effect.masks ?? []).map(resolveMask);
  if (masks.length > 64 || masks.some(id => !Number.isInteger(id) || id <= 0 || id > 0x7fffffff) || new Set(masks).size !== masks.length) throw new Error("Invalid mesh mask node IDs");
  if (effect.inverted && masks.length === 0) throw new Error("Inverted mesh effects require a mask");
  const colors = [...(effect.multiplyRgb ?? [1, 1, 1]), ...(effect.screenRgb ?? [0, 0, 0])];
  if (colors.length !== 6 || colors.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Invalid mesh effect RGB tint");
  const size = 40 + masks.length * 4;
  const bytes = reuse?.byteLength === size ? reuse : new Uint8Array(size);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  data.setUint32(0, 0x3158464d, true);
  data.setUint32(4, blend, true);
  data.setUint32(8, masks.length, true);
  data.setUint32(12, (effect.inverted ? 1 : 0) | (effect.repeatTexture ? 2 : 0), true);
  colors.forEach((value, index) => data.setFloat32(16 + index * 4, value, true));
  masks.forEach((id, index) => data.setUint32(40 + index * 4, id, true));
  return bytes;
}
