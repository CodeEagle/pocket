import type {
  NovelCameraEasing,
  NovelCameraMotion,
  NovelCameraShake,
  NovelCameraTransform,
  StageCameraState,
} from "./types.ts";

export const NOVEL_CAMERA_LIMITS = {
  position: { min: -4096, max: 4096 },
  scale: { min: 0.1, max: 8 },
  durationMs: { min: 1, max: 30_000 },
  shakeAmplitude: { min: 0, max: 512 },
  shakeCycles: { min: 1, max: 20 },
} as const;
const NOVEL_CAMERA_RUNTIME_POSITION_LIMIT = NOVEL_CAMERA_LIMITS.position.max + NOVEL_CAMERA_LIMITS.shakeAmplitude.max;

export const DEFAULT_NOVEL_CAMERA: NovelCameraTransform = Object.freeze({ x: 0, y: 0, scale: 1 });

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function novelCameraTransformIssue(
  value: unknown,
  label = "camera",
  allowShakeOffset = false,
): string | null {
  if (!isRecord(value)) return `${label} must be an object with x, y, and scale`;
  const positionLimit = allowShakeOffset ? NOVEL_CAMERA_RUNTIME_POSITION_LIMIT : NOVEL_CAMERA_LIMITS.position.max;
  for (const axis of ["x", "y"] as const) {
    const coordinate = value[axis];
    if (!isFiniteNumber(coordinate) || coordinate < -positionLimit || coordinate > positionLimit) {
      return `${label}.${axis} must be finite and between ${-positionLimit} and ${positionLimit}`;
    }
  }
  if (!isFiniteNumber(value.scale) || value.scale < NOVEL_CAMERA_LIMITS.scale.min || value.scale > NOVEL_CAMERA_LIMITS.scale.max) {
    return `${label}.scale must be finite and between ${NOVEL_CAMERA_LIMITS.scale.min} and ${NOVEL_CAMERA_LIMITS.scale.max}`;
  }
  if (Object.hasOwn(value, "rotation")) return `${label}.rotation is not supported`;
  return null;
}

function validateShake(value: unknown, label: string): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  if (!isFiniteNumber(value.amplitude)
    || value.amplitude < NOVEL_CAMERA_LIMITS.shakeAmplitude.min
    || value.amplitude > NOVEL_CAMERA_LIMITS.shakeAmplitude.max) {
    return `${label}.amplitude must be finite and between ${NOVEL_CAMERA_LIMITS.shakeAmplitude.min} and ${NOVEL_CAMERA_LIMITS.shakeAmplitude.max}`;
  }
  if (!isBoundedInteger(value.cycles, NOVEL_CAMERA_LIMITS.shakeCycles.min, NOVEL_CAMERA_LIMITS.shakeCycles.max)) {
    return `${label}.cycles must be an integer between ${NOVEL_CAMERA_LIMITS.shakeCycles.min} and ${NOVEL_CAMERA_LIMITS.shakeCycles.max}`;
  }
  return null;
}

/** Shared scene-camera validation for the engine and authoring tools. */
export function novelCameraInstructionIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "scene") return "type must be 'scene'";
  if (value.camera !== undefined) {
    const issue = novelCameraTransformIssue(value.camera, "camera");
    if (issue) return issue;
  }
  if (value.cameraMotion === undefined) return null;
  if (value.camera === undefined) return "cameraMotion requires camera";
  if (!isRecord(value.cameraMotion)) return "cameraMotion must be an object";
  const motion = value.cameraMotion;
  if (!isBoundedInteger(motion.durationMs, NOVEL_CAMERA_LIMITS.durationMs.min, NOVEL_CAMERA_LIMITS.durationMs.max)) {
    return `cameraMotion.durationMs must be an integer between ${NOVEL_CAMERA_LIMITS.durationMs.min} and ${NOVEL_CAMERA_LIMITS.durationMs.max}`;
  }
  if (motion.easing !== undefined && motion.easing !== "linear" && motion.easing !== "easeInOut") {
    return "cameraMotion.easing must be 'linear' or 'easeInOut'";
  }
  if (motion.shake !== undefined) return validateShake(motion.shake, "cameraMotion.shake");
  return null;
}

/** Validate canonical stage camera data before it enters a save or checkpoint. */
export function novelCameraStateIssue(
  value: unknown,
  label = "camera",
  options: { readonly allowShakeOffset?: boolean; readonly allowMotion?: boolean } = {},
): string | null {
  if (!isRecord(value)) return `${label} must be an object`;
  const transformIssue = novelCameraTransformIssue(value, label, options.allowShakeOffset);
  if (transformIssue) return transformIssue;
  if (options.allowMotion === false) {
    if (Object.hasOwn(value, "motion")) return `${label}.motion is not allowed in a frozen composition`;
    return null;
  }
  if (!Object.hasOwn(value, "motion")) return `${label}.motion must be null or a motion state`;
  if (value.motion === null) return null;
  if (!isRecord(value.motion)) return `${label}.motion must be null or an object`;
  const motion = value.motion;
  if (novelCameraTransformIssue(motion.from, `${label}.motion.from`, true)) return `${label}.motion.from is invalid`;
  if (!isBoundedInteger(motion.durationMs, NOVEL_CAMERA_LIMITS.durationMs.min, NOVEL_CAMERA_LIMITS.durationMs.max)) {
    return `${label}.motion.durationMs is invalid`;
  }
  if (!isFiniteNumber(motion.elapsedMs) || motion.elapsedMs < 0 || motion.elapsedMs > motion.durationMs) {
    return `${label}.motion.elapsedMs is invalid`;
  }
  if (motion.easing !== "linear" && motion.easing !== "easeInOut") return `${label}.motion.easing is invalid`;
  if (motion.shake !== undefined) {
    const shakeIssue = validateShake(motion.shake, `${label}.motion.shake`);
    if (shakeIssue) return shakeIssue;
  }
  return null;
}

function easedProgress(progress: number, easing: NovelCameraEasing): number {
  if (easing === "easeInOut") return progress * progress * (3 - 2 * progress);
  return progress;
}

/**
 * Resolve one deterministic render pose from canonical stage data. Shake is a
 * fading sinusoid tied to the stored elapsed time; it never uses wall-clock
 * time or random numbers. Legacy compositions without camera use the default.
 */
export function resolveNovelCameraPose(
  camera: StageCameraState | NovelCameraTransform | null | undefined,
  options: { readonly reduceMotion?: boolean } = {},
): NovelCameraTransform {
  const target = camera ?? DEFAULT_NOVEL_CAMERA;
  const pose: NovelCameraTransform = {
    x: isFiniteNumber(target.x) ? target.x : DEFAULT_NOVEL_CAMERA.x,
    y: isFiniteNumber(target.y) ? target.y : DEFAULT_NOVEL_CAMERA.y,
    scale: isFiniteNumber(target.scale) && target.scale > 0 ? target.scale : DEFAULT_NOVEL_CAMERA.scale,
  };
  const motion = (target as Partial<StageCameraState>).motion;
  if (!motion || options.reduceMotion) return pose;

  const durationMs = motion.durationMs;
  const elapsedMs = motion.elapsedMs;
  if (!isFiniteNumber(durationMs) || durationMs <= 0 || !isFiniteNumber(elapsedMs)) return pose;
  const progress = Math.max(0, Math.min(1, elapsedMs / durationMs));
  const amount = easedProgress(progress, motion.easing === "easeInOut" ? "easeInOut" : "linear");
  const result = {
    x: motion.from.x + (pose.x - motion.from.x) * amount,
    y: motion.from.y + (pose.y - motion.from.y) * amount,
    scale: motion.from.scale + (pose.scale - motion.from.scale) * amount,
  };
  const shake = motion.shake;
  if (shake && isFiniteNumber(shake.amplitude) && isFiniteNumber(shake.cycles) && shake.amplitude !== 0) {
    const envelope = Math.sin(Math.PI * progress);
    const phase = Math.PI * 2 * shake.cycles * progress;
    result.x += shake.amplitude * Math.sin(phase) * envelope;
    result.y += shake.amplitude * Math.sin(phase + Math.PI / 2) * envelope;
  }
  return result;
}

/** Construct a serialized in-flight motion from validated authoring fields. */
export function createNovelCameraMotionState(
  from: NovelCameraTransform,
  motion: NovelCameraMotion,
): StageCameraState["motion"] {
  return {
    from: { x: from.x, y: from.y, scale: from.scale },
    elapsedMs: 0,
    durationMs: motion.durationMs,
    easing: motion.easing ?? "linear",
    ...(motion.shake === undefined ? {} : { shake: { amplitude: motion.shake.amplitude, cycles: motion.shake.cycles } }),
  };
}
