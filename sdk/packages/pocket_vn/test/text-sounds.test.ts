import { expect, test } from "bun:test";
import {
  DEFAULT_NOVEL_TEXT_SOUND_INTERVAL_MS,
  parseNovelTextSounds,
  resolveNovelTextSoundCue,
  validateNovelTextSounds,
} from "../src/text-sounds.ts";

const cues = new Set(["text_default", "text_mira", "text_ren"]);

test("text-sound profiles validate cue references and copy speaker mappings", () => {
  const source = {
    defaultCue: "text_default",
    speakers: { Mira: "text_mira", Ren: "text_ren" },
    minIntervalMs: 120,
  };
  expect(validateNovelTextSounds(source, cues)).toEqual([]);
  const parsed = parseNovelTextSounds(source, cues)!;
  expect(parsed).toEqual(source);
  expect(parsed.speakers).not.toBe(source.speakers);
  expect(resolveNovelTextSoundCue(parsed, "Mira")).toBe("text_mira");
  expect(resolveNovelTextSoundCue(parsed, "Unknown")).toBe("text_default");
  expect(resolveNovelTextSoundCue(parsed, null)).toBe("text_default");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.speakers)).toBe(true);
});

test("text-sound profiles accept omission and validate schema, cue IDs, and pacing bounds", () => {
  expect(parseNovelTextSounds(undefined)).toBeUndefined();
  expect(parseNovelTextSounds({ defaultCue: "text_default" }, cues)).toEqual({ defaultCue: "text_default" });
  expect(DEFAULT_NOVEL_TEXT_SOUND_INTERVAL_MS).toBe(100);
  expect(validateNovelTextSounds({ defaultCue: "missing" }, cues)).toEqual([
    expect.objectContaining({ path: "textSounds.defaultCue", code: "cue" }),
  ]);
  expect(validateNovelTextSounds({ speakers: ["text_mira"] }, cues)).toContainEqual(
    expect.objectContaining({ path: "textSounds.speakers", code: "schema" }),
  );
  expect(validateNovelTextSounds({ minIntervalMs: 39 })).toContainEqual(
    expect.objectContaining({ path: "textSounds.minIntervalMs", code: "interval" }),
  );
  expect(validateNovelTextSounds({ minIntervalMs: 1001 })).toContainEqual(
    expect.objectContaining({ path: "textSounds.minIntervalMs", code: "interval" }),
  );
  expect(validateNovelTextSounds({ extra: true })).toContainEqual(
    expect.objectContaining({ path: "textSounds.extra", code: "schema" }),
  );
  expect(() => parseNovelTextSounds({ defaultCue: "unknown" }, cues)).toThrow(/not registered/);
});
