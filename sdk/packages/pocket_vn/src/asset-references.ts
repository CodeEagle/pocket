import type { StoryDefinition } from "./types.ts";

export interface NovelAssetReferenceDiagnostic {
  readonly severity: "error";
  readonly code: string;
  readonly message: string;
  readonly location?: {
    readonly label?: string;
    readonly index?: number;
    readonly field?: string;
  };
}

type PlainRecord = Record<string, unknown>;

function isRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function has(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key);
}

function map(value: unknown): PlainRecord {
  return isRecord(value) ? value : Object.create(null) as PlainRecord;
}

/**
 * Check story-key references against the same asset registry used by the
 * stage, audio, video and choice renderers. This is deliberately independent
 * of disk paths: Editor and buildGuest own those IO boundaries separately.
 */
export function validateNovelAssetReferences(
  story: StoryDefinition,
  registry: unknown,
): NovelAssetReferenceDiagnostic[] {
  const assets = map(registry);
  const backgrounds = map(assets.backgrounds);
  const characters = map(assets.characters);
  const cgs = map(assets.cgs);
  const audio = map(assets.audio);
  const videos = map(assets.videos);
  const models = map(assets.models);
  const diagnostics: NovelAssetReferenceDiagnostic[] = [];
  const choices = new Map<string, PlainRecord>();

  const add = (
    code: string,
    message: string,
    location: NovelAssetReferenceDiagnostic["location"],
  ): void => { diagnostics.push({ severity: "error", code, message, location }); };
  const ref = (
    label: string,
    index: number,
    field: string,
    kind: string,
    key: string,
    exists: boolean,
  ): void => {
    if (!exists) add("assets.reference", `Unknown ${kind} asset key “${key}”.`, { label, index, field });
  };

  for (const instructions of Object.values(story.script)) {
    if (!Array.isArray(instructions)) continue;
    for (const instruction of instructions) {
      if (isRecord(instruction) && instruction.type === "choice" && typeof instruction.id === "string") {
        choices.set(instruction.id, instruction);
      }
    }
  }
  const choiceSurfaces = map(assets.choiceSurfaces);
  for (const [choiceId, surface] of Object.entries(choiceSurfaces)) {
    const choice = choices.get(choiceId);
    if (!choice) {
      add("assets.choiceSurface.choice", `Choice surface “${choiceId}” must refer to an existing story choice ID.`, { field: `choiceSurfaces.${choiceId}` });
      continue;
    }
    if (!isRecord(surface) || !isRecord(surface.targets) || !Array.isArray(choice.options)) continue;
    const actual = new Set(choice.options.flatMap(option => isRecord(option) && typeof option.id === "string" ? [option.id] : []));
    const configured = new Set(Object.keys(surface.targets));
    const missing = [...actual].filter(optionId => !configured.has(optionId));
    const unknown = [...configured].filter(optionId => !actual.has(optionId));
    if (missing.length || unknown.length) {
      const details = [
        missing.length ? `missing option IDs: ${missing.join(", ")}` : "",
        unknown.length ? `unknown option IDs: ${unknown.join(", ")}` : "",
      ].filter(Boolean).join("; ");
      add(
        "assets.choiceSurface.options",
        `Choice surface “${choiceId}” must cover every story option exactly once (${details}).`,
        { field: `choiceSurfaces.${choiceId}.targets` },
      );
    }
  }

  for (const [backgroundId] of Object.entries(map(assets.atmospheres))) {
    if (!has(backgrounds, backgroundId)) {
      add("assets.atmosphere.background", `Atmosphere “${backgroundId}” must refer to a registered background.`, { field: `atmospheres.${backgroundId}` });
    }
  }

  for (const [label, instructions] of Object.entries(story.script)) {
    if (!Array.isArray(instructions)) continue;
    for (const [index, instruction] of instructions.entries()) {
      if (!isRecord(instruction)) continue;
      if (instruction.type === "scene") {
        if (typeof instruction.background === "string" && instruction.background.length > 0) {
          ref(label, index, "background", "background", instruction.background, has(backgrounds, instruction.background));
        }
        if (Array.isArray(instruction.objects)) {
          for (const [objectIndex, object] of instruction.objects.entries()) {
            if (!isRecord(object) || typeof object.image !== "string") continue;
            ref(label, index, `objects[${objectIndex}].image`, "scene object image", object.image, has(backgrounds, object.image));
          }
        }
        if (Array.isArray(instruction.backgroundLayers)) {
          for (const [layerIndex, layer] of instruction.backgroundLayers.entries()) {
            if (!isRecord(layer) || typeof layer.background !== "string") continue;
            ref(label, index, `backgroundLayers[${layerIndex}].background`, "background layer", layer.background, has(backgrounds, layer.background));
          }
        }
        if (Array.isArray(instruction.characters)) {
          for (const [characterIndex, character] of instruction.characters.entries()) {
            if (!isRecord(character) || typeof character.id !== "string") continue;
            const expressions = map(characters[character.id]);
            if (isRecord(character.model) && typeof character.model.key === "string") {
              const model = models[character.model.key];
              ref(label, index, `characters[${characterIndex}].model.key`, "model", character.model.key, !!model);
              if (isRecord(model) && Array.isArray(model.animations) && typeof character.model.animation === "string" && !model.animations.includes(character.model.animation)) {
                add("assets.model.animation", `Model “${character.model.key}” does not list animation “${character.model.animation}”.`, {
                  label,
                  index,
                  field: `characters[${characterIndex}].model.animation`,
                });
              }
              if (Object.keys(expressions).length > 0 && typeof character.expression === "string" &&
                  !has(expressions, character.expression) && !has(expressions, "neutral")) {
                ref(label, index, `characters[${characterIndex}].expression`, "expression", `${character.id}.${character.expression}`, false);
              }
            } else if (character.visible !== false) {
              ref(label, index, `characters[${characterIndex}].id`, "character", character.id, has(characters, character.id));
              if (Object.keys(expressions).length > 0 && typeof character.expression === "string" &&
                  !has(expressions, character.expression) && !has(expressions, "neutral")) {
                ref(label, index, `characters[${characterIndex}].expression`, "expression", `${character.id}.${character.expression}`, false);
              }
            }
          }
        }
      } else if (instruction.type === "say" && typeof instruction.voice === "string") {
        ref(label, index, "voice", "dialogue voice audio cue", instruction.voice, has(audio, instruction.voice));
      } else if (instruction.type === "audio" && typeof instruction.cue === "string") {
        ref(label, index, "cue", "audio cue", instruction.cue, has(audio, instruction.cue));
      } else if (instruction.type === "video" && instruction.action === "play" && typeof instruction.cue === "string") {
        ref(label, index, "cue", "video cue", instruction.cue, has(videos, instruction.cue));
      } else if (instruction.type === "ending" && typeof instruction.cg === "string" && instruction.cg.length > 0) {
        ref(label, index, "cg", "CG", instruction.cg, has(cgs, instruction.cg));
      }
    }
  }

  for (const [timelineId, timeline] of Object.entries(map(story.timelines))) {
    if (!isRecord(timeline) || !Array.isArray(timeline.audio)) continue;
    for (const [index, event] of timeline.audio.entries()) {
      if (!isRecord(event) || typeof event.cue !== "string" || event.cue.length === 0) continue;
      if (!has(audio, event.cue)) {
        add("assets.reference", `Unknown audio cue asset key “${event.cue}”.`, { field: `timelines.${timelineId}.audio[${index}].cue` });
      }
    }
  }
  return diagnostics;
}
