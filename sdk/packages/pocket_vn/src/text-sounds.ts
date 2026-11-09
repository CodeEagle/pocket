export interface NovelTextSoundsConfig {
  readonly defaultCue?: string;
  readonly speakers?: Readonly<Record<string, string>>;
  readonly minIntervalMs?: number;
}

export interface NovelTextSoundsIssue {
  readonly path: string;
  readonly code: "schema" | "cue" | "interval";
  readonly message: string;
}

export const DEFAULT_NOVEL_TEXT_SOUND_INTERVAL_MS = 100;
export const MIN_NOVEL_TEXT_SOUND_INTERVAL_MS = 40;
export const MAX_NOVEL_TEXT_SOUND_INTERVAL_MS = 1000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validCue(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validateCue(
  cue: unknown,
  path: string,
  availableCues: ReadonlySet<string> | undefined,
  issues: NovelTextSoundsIssue[],
): void {
  if (!validCue(cue)) {
    issues.push({ path, code: "cue", message: "cue must be a short audio cue identifier" });
  } else if (availableCues && !availableCues.has(cue)) {
    issues.push({ path, code: "cue", message: `audio cue '${cue}' is not registered` });
  }
}

/** Pure asset-registry validation shared by runtime and editor callers. */
export function validateNovelTextSounds(
  value: unknown,
  availableCues?: ReadonlySet<string>,
): readonly NovelTextSoundsIssue[] {
  if (!isRecord(value)) {
    return [{ path: "textSounds", code: "schema", message: "textSounds must be an object" }];
  }

  const issues: NovelTextSoundsIssue[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "defaultCue" && key !== "speakers" && key !== "minIntervalMs") {
      issues.push({ path: `textSounds.${key}`, code: "schema", message: "unknown textSounds field" });
    }
  }

  if (value.defaultCue !== undefined) {
    validateCue(value.defaultCue, "textSounds.defaultCue", availableCues, issues);
  }

  if (value.speakers !== undefined) {
    if (!isRecord(value.speakers)) {
      issues.push({ path: "textSounds.speakers", code: "schema", message: "speakers must be an object" });
    } else {
      for (const [speaker, cue] of Object.entries(value.speakers)) {
        if (speaker.length === 0 || speaker.length > 128 || /[\u0000-\u001f\u007f]/.test(speaker)) {
          issues.push({ path: `textSounds.speakers.${speaker}`, code: "schema", message: "speaker key must be non-empty plain text up to 128 characters" });
          continue;
        }
        validateCue(cue, `textSounds.speakers.${speaker}`, availableCues, issues);
      }
    }
  }

  if (value.minIntervalMs !== undefined && (
    typeof value.minIntervalMs !== "number" ||
    !Number.isInteger(value.minIntervalMs) ||
    value.minIntervalMs < MIN_NOVEL_TEXT_SOUND_INTERVAL_MS ||
    value.minIntervalMs > MAX_NOVEL_TEXT_SOUND_INTERVAL_MS
  )) {
    issues.push({
      path: "textSounds.minIntervalMs",
      code: "interval",
      message: `minIntervalMs must be an integer from ${MIN_NOVEL_TEXT_SOUND_INTERVAL_MS} to ${MAX_NOVEL_TEXT_SOUND_INTERVAL_MS}`,
    });
  }

  return issues;
}

/** Validates and defensively copies authored settings for the audio adapter. */
export function parseNovelTextSounds(
  value: unknown,
  availableCues?: ReadonlySet<string>,
): NovelTextSoundsConfig | undefined {
  if (value === undefined) return undefined;
  const issues = validateNovelTextSounds(value, availableCues);
  if (issues.length > 0) {
    const first = issues[0]!;
    throw new RangeError(`${first.path}: ${first.message}`);
  }
  const source = value as Record<string, unknown>;
  const speakers = isRecord(source.speakers) ? Object.freeze({
    ...Object.fromEntries(Object.entries(source.speakers).map(([speaker, cue]) => [speaker, cue as string])),
  }) : undefined;
  return Object.freeze({
    ...(source.defaultCue === undefined ? {} : { defaultCue: source.defaultCue as string }),
    ...(speakers === undefined ? {} : { speakers }),
    ...(source.minIntervalMs === undefined ? {} : { minIntervalMs: source.minIntervalMs as number }),
  });
}

export function resolveNovelTextSoundCue(
  config: NovelTextSoundsConfig | undefined,
  speaker: string | null,
): string | undefined {
  if (!config) return undefined;
  return (speaker === null ? undefined : config.speakers?.[speaker]) ?? config.defaultCue;
}
