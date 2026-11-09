import type { NovelCameraTransform, StageCameraState } from "./types.ts";
import { resolveNovelCameraPose } from "./camera.ts";

/** Keep the stage draw list bounded while leaving room for foreground and depth planes. */
export const NOVEL_BACKGROUND_LAYER_LIMITS = {
  count: 8,
  parallax: { min: 0, max: 1 },
} as const;

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the authored or saved additive background layer list. */
export function novelBackgroundLayersIssue(value: unknown, path = "backgroundLayers"): string | null {
  if (!Array.isArray(value)) return `${path} must be an array`;
  if (value.length > NOVEL_BACKGROUND_LAYER_LIMITS.count) {
    return `${path} must contain at most ${NOVEL_BACKGROUND_LAYER_LIMITS.count} layers`;
  }
  for (let index = 0; index < value.length; index += 1) {
    const layer = value[index];
    const layerPath = `${path}[${index}]`;
    if (!isRecord(layer)) return `${layerPath} must be an object`;
    if (!nonEmpty(layer.background)) return `${layerPath}.background must be a non-empty registered background key`;
    if (typeof layer.parallax !== "number" || !Number.isFinite(layer.parallax)
      || layer.parallax < NOVEL_BACKGROUND_LAYER_LIMITS.parallax.min
      || layer.parallax > NOVEL_BACKGROUND_LAYER_LIMITS.parallax.max) {
      return `${layerPath}.parallax must be finite and between ${NOVEL_BACKGROUND_LAYER_LIMITS.parallax.min} and ${NOVEL_BACKGROUND_LAYER_LIMITS.parallax.max}`;
    }
  }
  return null;
}

/** Shared scene-instruction validation for the engine and Editor. */
export function novelBackgroundLayersInstructionIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "scene") return "type must be 'scene'";
  if (value.backgroundLayers === undefined) return null;
  return novelBackgroundLayersIssue(value.backgroundLayers);
}

/**
 * Resolve a depth plane against the existing deterministic stage camera.
 * A factor of 0 stays fixed to the viewport, while 1 follows the full camera.
 */
export function resolveNovelBackgroundLayerPose(
  camera: StageCameraState | NovelCameraTransform | null | undefined,
  parallax: number,
  options: { readonly reduceMotion?: boolean } = {},
): NovelCameraTransform {
  if (!Number.isFinite(parallax)
    || parallax < NOVEL_BACKGROUND_LAYER_LIMITS.parallax.min
    || parallax > NOVEL_BACKGROUND_LAYER_LIMITS.parallax.max) {
    throw new RangeError(`background layer parallax must be finite and between ${NOVEL_BACKGROUND_LAYER_LIMITS.parallax.min} and ${NOVEL_BACKGROUND_LAYER_LIMITS.parallax.max}`);
  }
  const pose = resolveNovelCameraPose(camera, options);
  if (parallax === 0) return { x: 0, y: 0, scale: 1 };
  return {
    x: pose.x * parallax,
    y: pose.y * parallax,
    scale: 1 + (pose.scale - 1) * parallax,
  };
}
