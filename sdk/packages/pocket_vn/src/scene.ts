import type { StageCharacter, StageComposition } from "./types.ts";

export const NOVEL_CHARACTER_TRANSFORM_LIMITS = {
  scale: { min: 0.05, max: 8, integer: false },
  rotation: { min: -360, max: 360, integer: false },
  layer: { min: -1024, max: 1024, integer: true },
} as const;

/** Shared by authored scenes and persisted state validation at IO boundaries. */
export function novelCharacterTransformIssue(value: { readonly scale?: unknown; readonly rotation?: unknown; readonly layer?: unknown }): string | null {
  for (const key of ["scale", "rotation", "layer"] as const) {
    const field = value[key];
    const range = NOVEL_CHARACTER_TRANSFORM_LIMITS[key];
    if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field) || field < range.min || field > range.max || range.integer && !Number.isInteger(field))) {
      return `${key} must be ${range.integer ? "an integer " : ""}between ${range.min} and ${range.max}`;
    }
  }
  return null;
}

/** The same authored character geometry is used by Pocket and the Editor. */
export function resolveNovelCharacterPlacement(character: StageCharacter) {
  const position = character.position;
  return {
    x: typeof position === "object" ? position.x : position === "left" ? -24 : position === "right" ? 144 : 60,
    y: typeof position === "object" ? position.y : 116,
    scale: character.scale ?? 1,
    rotation: character.rotation ?? 0,
    layer: character.layer ?? 0,
    width: 240,
    height: 350,
  };
}

/** Map a viewport pointer back into the Live2D model's 240×350 canvas. */
export function screenPointToNovelModelPoint(
  point: { readonly x: number; readonly y: number },
  stage: { readonly insetL: number; readonly insetT: number; readonly width: number; readonly height: number },
  camera: { readonly x: number; readonly y: number; readonly scale: number },
  character: { readonly insetL: number; readonly insetT: number; readonly scale: number; readonly rotation: number },
  artScale: number,
): { readonly x: number; readonly y: number } | undefined {
  const characterScale = character.scale * artScale;
  if (!(camera.scale > 0) || !(characterScale > 0)
    || !Number.isFinite(characterScale) || !Number.isFinite(camera.scale)) return undefined;

  // The stage camera transform is centered on its safe-stage node. Character
  // and model transforms are top-left anchored, so undo them after the camera.
  const centerX = stage.width / 2;
  const centerY = stage.height / 2;
  const stageX = (point.x - stage.insetL - camera.x - centerX) / camera.scale + centerX;
  const stageY = (point.y - stage.insetT - camera.y - centerY) / camera.scale + centerY;
  const dx = stageX - character.insetL;
  const dy = stageY - character.insetT;
  const radians = character.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = (dx * cosine + dy * sine) / characterScale;
  const y = (-dx * sine + dy * cosine) / characterScale;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/** Stable sorting keeps existing stories' draw order and model instances. */
export function orderedNovelCharacterIds(stage: StageComposition): string[] {
  return Object.keys(stage.characters)
    .filter(id => stage.characters[id]!.visible)
    .sort((a, b) => (stage.characters[a]!.layer ?? 0) - (stage.characters[b]!.layer ?? 0));
}
