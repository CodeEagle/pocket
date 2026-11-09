import type {
  JsonValue,
  NovelSceneObject,
  StageComposition,
} from "./types.ts";
import { evaluateNovelCondition, novelConditionIssue } from "./conditions.ts";
import { isNovelVariableName, novelJsonValueIssue } from "./variables.ts";

export const NOVEL_SCENE_OBJECT_LIMITS = {
  maxObjects: 32,
  maxEffectsPerInteraction: 16,
  maxLayer: 1024,
  minLayer: -1024,
  maxStageDimension: 16_384,
  minAspectRatio: 0.05,
  maxAspectRatio: 20,
} as const;

export interface NovelSceneObjectPixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NovelSceneObjectGeometry {
  /** Actual contained object frame in logical stage pixels. It is also the rectangular clip. */
  readonly frame: NovelSceneObjectPixelRect;
  /** Image bounds relative to the actual clipped frame; crop may extend beyond it. */
  readonly image: NovelSceneObjectPixelRect;
  /** Hit target relative to the actual frame. */
  readonly hit: NovelSceneObjectPixelRect;
}

export interface NovelStageItemReference {
  readonly kind: "character" | "object";
  readonly id: string;
}

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: PlainRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const objectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sceneObjectRectIssue(value: unknown, path: string): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["x", "y", "w", "h"])) return `${path} must be a normalized rectangle`;
  const { x, y, w, h } = value;
  if (![x, y, w, h].every(isFiniteNumber) || Number(x) < 0 || Number(y) < 0 || Number(w) <= 0 || Number(h) <= 0 || Number(x) + Number(w) > 1 || Number(y) + Number(h) > 1) {
    return `${path} must have finite x/y/w/h within the 0..1 frame`;
  }
  return null;
}

function sceneObjectEffectIssue(value: unknown, path: string): string | null {
  if (!isRecord(value) || (value.type !== "set" && value.type !== "inc")) return `${path} must be a set or inc effect`;
  if (!isNonEmptyString(value.variable) || !isNovelVariableName(value.variable)) return `${path}.variable is invalid`;
  if (value.type === "set") {
    if (!hasOnlyKeys(value, ["type", "variable", "value"]) || !Object.hasOwn(value, "value")) return `${path} must contain only type, variable and value`;
    return novelJsonValueIssue(value.value, `${path}.value`);
  }
  if (!hasOnlyKeys(value, ["type", "variable", "amount"]) || !isFiniteNumber(value.amount)) return `${path}.amount must be finite`;
  return null;
}

function sceneObjectInteractionIssue(value: unknown, path: string): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["label", "effects", "when", "hit"])) return `${path} must be an object with only label, effects, when and hit`;
  if (!isNonEmptyString(value.label) || value.label.length > 256) return `${path}.label must be a non-empty string of at most 256 characters`;
  if (!Array.isArray(value.effects) || value.effects.length === 0 || value.effects.length > NOVEL_SCENE_OBJECT_LIMITS.maxEffectsPerInteraction) {
    return `${path}.effects must contain between 1 and ${NOVEL_SCENE_OBJECT_LIMITS.maxEffectsPerInteraction} effects`;
  }
  for (let index = 0; index < value.effects.length; index++) {
    if (!Object.hasOwn(value.effects, index)) return `${path}.effects[${index}] is missing`;
    const issue = sceneObjectEffectIssue(value.effects[index], `${path}.effects[${index}]`);
    if (issue !== null) return issue;
  }
  if (value.when !== undefined) {
    const issue = novelConditionIssue(value.when, `${path}.when`);
    if (issue !== null) return issue;
  }
  if (value.hit !== undefined) {
    const issue = sceneObjectRectIssue(value.hit, `${path}.hit`);
    if (issue !== null) return issue;
  }
  return null;
}

/** Validate one scene object declaration for story, stage and save boundaries. */
export function novelSceneObjectIssue(value: unknown, path = "scene.objects"): string | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "image", "frame", "aspectRatio", "crop", "layer", "interaction"])) return `${path} must be a scene object with only supported fields`;
  if (typeof value.id !== "string" || !objectIdPattern.test(value.id)) return `${path}.id must be a stable identifier`;
  if (!isNonEmptyString(value.image)) return `${path}.image must name a background asset key`;
  const frameIssue = sceneObjectRectIssue(value.frame, `${path}.frame`);
  if (frameIssue !== null) return frameIssue;
  if (value.aspectRatio !== undefined && (!isFiniteNumber(value.aspectRatio) || value.aspectRatio < NOVEL_SCENE_OBJECT_LIMITS.minAspectRatio || value.aspectRatio > NOVEL_SCENE_OBJECT_LIMITS.maxAspectRatio)) {
    return `${path}.aspectRatio must be finite and between ${NOVEL_SCENE_OBJECT_LIMITS.minAspectRatio} and ${NOVEL_SCENE_OBJECT_LIMITS.maxAspectRatio}`;
  }
  if (value.crop !== undefined) {
    const cropIssue = sceneObjectRectIssue(value.crop, `${path}.crop`);
    if (cropIssue !== null) return cropIssue;
    const crop = value.crop as { readonly w: number; readonly h: number };
    if (!Number.isFinite(NOVEL_SCENE_OBJECT_LIMITS.maxStageDimension / crop.w) ||
        !Number.isFinite(NOVEL_SCENE_OBJECT_LIMITS.maxStageDimension / crop.h)) {
      return `${path}.crop must keep image bounds finite at a stage up to ${NOVEL_SCENE_OBJECT_LIMITS.maxStageDimension}px`;
    }
  }
  if (value.layer !== undefined && (!isFiniteNumber(value.layer) || !Number.isInteger(value.layer) || value.layer < NOVEL_SCENE_OBJECT_LIMITS.minLayer || value.layer > NOVEL_SCENE_OBJECT_LIMITS.maxLayer)) {
    return `${path}.layer must be an integer between ${NOVEL_SCENE_OBJECT_LIMITS.minLayer} and ${NOVEL_SCENE_OBJECT_LIMITS.maxLayer}`;
  }
  if (value.interaction !== undefined) return sceneObjectInteractionIssue(value.interaction, `${path}.interaction`);
  return null;
}

/** Validate a complete scene object declaration list and enforce stable unique IDs. */
export function novelSceneObjectsIssue(value: unknown, path = "scene.objects"): string | null {
  if (!Array.isArray(value)) return `${path} must be an array`;
  if (value.length > NOVEL_SCENE_OBJECT_LIMITS.maxObjects) return `${path} must contain at most ${NOVEL_SCENE_OBJECT_LIMITS.maxObjects} objects`;
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return `${path}[${index}] is missing`;
    const object = value[index];
    const issue = novelSceneObjectIssue(object, `${path}[${index}]`);
    if (issue !== null) return issue;
    const id = (object as NovelSceneObject).id;
    if (ids.has(id)) return `${path} contains duplicate object id '${id}'`;
    ids.add(id);
  }
  return null;
}

/** Return true when an object has a live interaction under the current story variables. */
export function isNovelSceneObjectInteractive(
  object: NovelSceneObject,
  variables: Readonly<Record<string, JsonValue>>,
): boolean {
  const interaction = object.interaction;
  return interaction !== undefined && (interaction.when === undefined || evaluateNovelCondition(interaction.when, variables));
}

/** Convert normalized frame, crop and hit rectangles to the shared stage geometry. */
export function resolveNovelSceneObjectGeometry(
  object: NovelSceneObject,
  stageWidth: number,
  stageHeight: number,
): NovelSceneObjectGeometry | null {
  if (!Number.isFinite(stageWidth) || !Number.isFinite(stageHeight) || stageWidth <= 0 || stageHeight <= 0 || stageWidth > NOVEL_SCENE_OBJECT_LIMITS.maxStageDimension || stageHeight > NOVEL_SCENE_OBJECT_LIMITS.maxStageDimension) return null;
  const { frame, crop } = object;
  if (sceneObjectRectIssue(frame, "object.frame") !== null ||
      (crop !== undefined && sceneObjectRectIssue(crop, "object.crop") !== null) ||
      (object.interaction?.hit !== undefined && sceneObjectRectIssue(object.interaction.hit, "object.interaction.hit") !== null)) return null;
  const frameBoxPixels = {
    x: frame.x * stageWidth,
    y: frame.y * stageHeight,
    width: frame.w * stageWidth,
    height: frame.h * stageHeight,
  };
  if (![frameBoxPixels.x, frameBoxPixels.y, frameBoxPixels.width, frameBoxPixels.height].every(Number.isFinite) || frameBoxPixels.width <= 0 || frameBoxPixels.height <= 0) return null;
  let framePixels = frameBoxPixels;
  if (object.aspectRatio !== undefined) {
    if (!isFiniteNumber(object.aspectRatio) || object.aspectRatio < NOVEL_SCENE_OBJECT_LIMITS.minAspectRatio || object.aspectRatio > NOVEL_SCENE_OBJECT_LIMITS.maxAspectRatio) return null;
    const boxAspectRatio = frameBoxPixels.width / frameBoxPixels.height;
    if (boxAspectRatio > object.aspectRatio) {
      const width = frameBoxPixels.height * object.aspectRatio;
      framePixels = {
        x: frameBoxPixels.x + (frameBoxPixels.width - width) / 2,
        y: frameBoxPixels.y,
        width,
        height: frameBoxPixels.height,
      };
    } else {
      const height = frameBoxPixels.width / object.aspectRatio;
      framePixels = {
        x: frameBoxPixels.x,
        y: frameBoxPixels.y + (frameBoxPixels.height - height) / 2,
        width: frameBoxPixels.width,
        height,
      };
    }
  }
  if (![framePixels.x, framePixels.y, framePixels.width, framePixels.height].every(Number.isFinite) || framePixels.width <= 0 || framePixels.height <= 0) return null;
  const source = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const image = {
    x: -source.x / source.w * framePixels.width,
    y: -source.y / source.h * framePixels.height,
    width: framePixels.width / source.w,
    height: framePixels.height / source.h,
  };
  if (![image.x, image.y, image.width, image.height].every(Number.isFinite) || image.width <= 0 || image.height <= 0) return null;
  const target = object.interaction?.hit ?? { x: 0, y: 0, w: 1, h: 1 };
  return {
    frame: framePixels,
    image,
    hit: {
      x: target.x * framePixels.width,
      y: target.y * framePixels.height,
      width: target.w * framePixels.width,
      height: target.h * framePixels.height,
    },
  };
}

/**
 * Stable stage draw order shared by the Pocket view and Editor. Characters are
 * inserted first, then objects; equal layers retain this deterministic order.
 */
export function orderedNovelStageItems(
  stage: Pick<StageComposition, "characters" | "objects">,
): NovelStageItemReference[] {
  const items: Array<NovelStageItemReference & { readonly layer: number; readonly order: number }> = [];
  let order = 0;
  for (const [id, character] of Object.entries(stage.characters)) {
    if (character.visible) items.push({ kind: "character", id, layer: character.layer ?? 0, order: order++ });
  }
  for (const object of stage.objects ?? []) items.push({ kind: "object", id: object.id, layer: object.layer ?? 0, order: order++ });
  items.sort((left, right) => left.layer - right.layer || left.order - right.order);
  return items.map(({ kind, id }) => ({ kind, id }));
}
