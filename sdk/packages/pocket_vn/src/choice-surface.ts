import { novelImageContainBounds, type NovelImageDimensions } from "./viewport.ts";

/** Normalized rectangle relative to a choice surface's visible content. */
export interface NovelChoiceSurfaceRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A scene maps choice options onto the current stage; a dial adds one image. */
export type NovelChoiceSurface =
  | {
      readonly kind: "scene";
      /** Normalized stage rectangle; omitted means the full usable stage. */
      readonly frame?: NovelChoiceSurfaceRect;
      /** Option IDs to touch/focus regions, normalized to the scene frame. */
      readonly targets: Readonly<Record<string, NovelChoiceSurfaceRect>>;
    }
  | {
      readonly kind: "dial";
      /** Project-relative PNG/SVG path included by the ordinary guest image pipeline. */
      readonly image: string;
      /** Normalized stage rectangle occupied by the dial illustration. */
      readonly frame: NovelChoiceSurfaceRect;
      /** Option IDs to touch/focus regions, normalized to the fitted image bounds. */
      readonly targets: Readonly<Record<string, NovelChoiceSurfaceRect>>;
    };

export interface NovelChoiceSurfaceOption {
  readonly id: string;
  readonly text: string;
}

export interface NovelChoiceSurfacePixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NovelChoiceSurfaceTarget<Option extends NovelChoiceSurfaceOption = NovelChoiceSurfaceOption>
  extends NovelChoiceSurfacePixelRect {
  readonly option: Option;
  /** The active, localized choice text; surface metadata does not duplicate it. */
  readonly displayCaption: string;
}

export interface NovelChoiceSurfaceLayout<Option extends NovelChoiceSurfaceOption = NovelChoiceSurfaceOption> {
  readonly width: number;
  readonly height: number;
  readonly image?: { readonly src: string } & NovelChoiceSurfacePixelRect;
  readonly targets: readonly NovelChoiceSurfaceTarget<Option>[];
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const imagePathPattern = /^[\w./-]+\.(png|svg)$/i;
const fullStage: NovelChoiceSurfaceRect = { x: 0, y: 0, w: 1, h: 1 };

/** Validate the portable authoring shape; project path ownership is checked by the asset registry. */
export function novelChoiceSurfaceIssue(value: unknown): string | null {
  if (!isRecord(value)) return "choice surface must be an object";
  if (value.kind === "scene") {
    if (!hasOnlyAllowedKeys(value, ["kind", "frame", "targets"])) return "scene choice surface has unknown fields";
    if (value.frame !== undefined && !isChoiceSurfaceRect(value.frame)) return "choice surface.frame must be a normalized rectangle";
    if (!isChoiceSurfaceTargets(value.targets)) return "choice surface.targets must map option IDs to normalized rectangles";
    return null;
  }
  if (value.kind === "dial") {
    if (!hasOnlyKeys(value, ["kind", "image", "frame", "targets"])) return "dial choice surface has unknown fields";
    if (typeof value.image !== "string" || !imagePathPattern.test(value.image) || value.image.startsWith("/") ||
        value.image.split("/").some(part => !part || part === "." || part === "..")) {
      return "dial choice surface.image must be a project-relative PNG/SVG path";
    }
    if (!isChoiceSurfaceRect(value.frame)) return "dial choice surface.frame must be a normalized rectangle";
    if (!isChoiceSurfaceTargets(value.targets)) return "choice surface.targets must map option IDs to normalized rectangles";
    return null;
  }
  return "choice surface.kind must be scene or dial";
}

export function isNovelChoiceSurface(value: unknown): value is NovelChoiceSurface {
  return novelChoiceSurfaceIssue(value) === null;
}

/**
 * Resolve a choice surface against the current native stage size and already
 * filtered engine options. Returning null asks the view to keep its ordinary
 * scrollable option list, so no legal option can disappear on a small screen
 * or when an author has not mapped it yet.
 */
export function createNovelChoiceSurfaceLayout<Option extends NovelChoiceSurfaceOption>(
  surface: unknown,
  options: readonly Option[],
  width: number,
  height: number,
  imageDimensions?: NovelImageDimensions,
  minHitSize = 44,
): NovelChoiceSurfaceLayout<Option> | null {
  if (novelChoiceSurfaceIssue(surface) !== null || !Array.isArray(options) || options.length === 0 ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 16_384 || height > 16_384 ||
      !Number.isFinite(minHitSize) || minHitSize < 0) return null;

  const config = surface as NovelChoiceSurface;
  const frame = config.frame ?? fullStage;
  const frameBounds = pixelRect(frame, width, height);
  const image = config.kind === "dial"
    ? imageBounds(frameBounds, imageDimensions)
    : undefined;
  const contentBounds = image ?? frameBounds;
  const seen = new Set<string>();
  const targets: NovelChoiceSurfaceTarget<Option>[] = [];

  for (const option of options) {
    if (!option || !idPattern.test(option.id) || typeof option.text !== "string" || seen.has(option.id)) return null;
    seen.add(option.id);
    const targetRect = config.targets[option.id];
    if (!targetRect) return null;
    const rect = pixelRect(targetRect, contentBounds.width, contentBounds.height, contentBounds.x, contentBounds.y);
    if (rect.width + 1e-9 < minHitSize || rect.height + 1e-9 < minHitSize) return null;
    targets.push({ ...rect, option, displayCaption: option.text });
  }

  return {
    width,
    height,
    ...(image && config.kind === "dial" ? { image: { src: config.image, ...image } } : {}),
    targets,
  };
}

function imageBounds(
  frame: NovelChoiceSurfacePixelRect,
  dimensions: NovelImageDimensions | undefined,
): NovelChoiceSurfacePixelRect {
  const contain = novelImageContainBounds(frame.width, frame.height, dimensions);
  return {
    x: frame.x + contain.insetL,
    y: frame.y + contain.insetT,
    width: contain.width,
    height: contain.height,
  };
}

function pixelRect(
  rect: NovelChoiceSurfaceRect,
  width: number,
  height: number,
  x = 0,
  y = 0,
): NovelChoiceSurfacePixelRect {
  return { x: x + rect.x * width, y: y + rect.y * height, width: rect.w * width, height: rect.h * height };
}

function isChoiceSurfaceRect(value: unknown): value is NovelChoiceSurfaceRect {
  if (!isRecord(value) || !hasOnlyKeys(value, ["x", "y", "w", "h"])) return false;
  const { x, y, w, h } = value;
  return [x, y, w, h].every(entry => typeof entry === "number" && Number.isFinite(entry)) &&
    Number(x) >= 0 && Number(y) >= 0 && Number(w) > 0 && Number(h) > 0 &&
    Number(x) + Number(w) <= 1 && Number(y) + Number(h) <= 1;
}

function isChoiceSurfaceTargets(value: unknown): value is Readonly<Record<string, NovelChoiceSurfaceRect>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 128 &&
    entries.every(([id, rect]) => idPattern.test(id) && isChoiceSurfaceRect(rect));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key)) && Object.keys(value).length === keys.length;
}

function hasOnlyAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
