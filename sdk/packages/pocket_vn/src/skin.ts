import type { NovelMeshGeometry } from "./mesh.ts";

/** Source image dimensions and the shared source-pixel border inset. */
export interface NovelAssetSkinFrame {
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly inset: number;
}

/** Optional shared game-chrome image metadata stored beside novel assets. */
export interface NovelAssetSkin {
  readonly frame: NovelAssetSkinFrame;
  readonly accentFrame?: NovelAssetSkinFrame;
  readonly icons?: NovelAssetSkinIcons;
}

/** Equal cells, named in row-major order; unused trailing cells need no name. */
export interface NovelAssetSkinIcons {
  readonly image: string;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  readonly names: readonly string[];
}

/** Validate only the portable skin metadata shape; path authorization belongs to the asset registry. */
export function isNovelAssetSkin(value: unknown): value is NovelAssetSkin {
  if (!isRecord(value) || !Object.hasOwn(value, "frame") ||
      Object.keys(value).some(key => !["frame", "accentFrame", "icons"].includes(key))) return false;
  return isAssetSkinFrame(value.frame)
    && (value.accentFrame === undefined || isAssetSkinFrame(value.accentFrame))
    && (value.icons === undefined || isAssetSkinIcons(value.icons));
}

/** One quad sampling a named icon cell. Unknown optional icons render nothing. */
export function createNovelSkinIconGeometry(
  atlas: NovelAssetSkinIcons,
  name: string,
  width: number,
  height: number,
): NovelMeshGeometry | undefined {
  if (!isAssetSkinIcons(atlas)) throw new TypeError("Invalid visual-novel icon atlas metadata");
  if (!isMeshDimension(width) || !isMeshDimension(height)) throw new RangeError("Invalid icon target dimensions");
  const index = atlas.names.indexOf(name);
  if (index < 0) return undefined;
  const left = (index % atlas.columns) / atlas.columns;
  const top = Math.floor(index / atlas.columns) / atlas.rows;
  const right = left + 1 / atlas.columns;
  const bottom = top + 1 / atlas.rows;
  return {
    vertices: new Float32Array([0, 0, left, top, width, 0, right, top, 0, height, left, bottom, width, height, right, bottom]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
  };
}

/**
 * Make one static 9-slice grid in the image node's local pixel space.
 * `border` is a destination-space edge width; `frame.inset` is the source
 * image-space edge width. Both are independently clamped so narrow targets
 * retain a non-negative center region.
 */
export function createNovelSkinFrameGeometry(
  frame: NovelAssetSkinFrame,
  width: number,
  height: number,
  border: number,
): NovelMeshGeometry {
  if (!isAssetSkinFrame(frame)) throw new TypeError("Invalid visual-novel skin frame metadata");
  if (!isMeshDimension(width) || !isMeshDimension(height)) {
    throw new RangeError("Skin frame target dimensions must be positive finite values no greater than 1,000,000 pixels");
  }
  if (!Number.isFinite(border) || border < 0 || border > 1_000_000) {
    throw new RangeError("Skin frame border must be between zero and 1,000,000 pixels");
  }

  const edge = Math.min(border, width / 2, height / 2);
  const xs = [0, edge, width - edge, width];
  const ys = [0, edge, height - edge, height];
  const sourceXs = [0, frame.inset, frame.width - frame.inset, frame.width];
  const sourceYs = [0, frame.inset, frame.height - frame.inset, frame.height];
  const vertices = new Float32Array(4 * 4 * 4);
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const offset = (row * 4 + column) * 4;
      vertices[offset] = xs[column]!;
      vertices[offset + 1] = ys[row]!;
      vertices[offset + 2] = sourceXs[column]! / frame.width;
      vertices[offset + 3] = sourceYs[row]! / frame.height;
    }
  }

  const indices = new Uint32Array(9 * 6);
  let index = 0;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      const topLeft = row * 4 + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + 4;
      const bottomRight = bottomLeft + 1;
      indices[index++] = topLeft;
      indices[index++] = bottomLeft;
      indices[index++] = topRight;
      indices[index++] = topRight;
      indices[index++] = bottomLeft;
      indices[index++] = bottomRight;
    }
  }
  return { vertices, indices };
}

function isAssetSkinFrame(value: unknown): value is NovelAssetSkinFrame {
  if (!isRecord(value) || !hasOnlyKeys(value, ["image", "width", "height", "inset"])) return false;
  const width = value.width;
  const height = value.height;
  const inset = value.inset;
  return typeof value.image === "string" &&
    isPositiveSafeInteger(width) &&
    isPositiveSafeInteger(height) &&
    isNonNegativeSafeInteger(inset) &&
    inset < Math.min(width, height) / 2;
}

function isAssetSkinIcons(value: unknown): value is NovelAssetSkinIcons {
  if (!isRecord(value) || !hasOnlyKeys(value, ["image", "width", "height", "columns", "rows", "names"])) return false;
  const { columns, rows, names } = value;
  return typeof value.image === "string" && isPositiveSafeInteger(value.width) && isPositiveSafeInteger(value.height)
    && isPositiveSafeInteger(columns) && Number(columns) <= 16
    && isPositiveSafeInteger(rows) && Number(rows) <= 16
    && Array.isArray(names) && names.length > 0 && names.length <= Number(columns) * Number(rows)
    && names.every(name => typeof name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(name))
    && new Set(names).size === names.length;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isMeshDimension(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
