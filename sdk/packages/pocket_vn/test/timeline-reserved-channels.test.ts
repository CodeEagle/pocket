import { expect, test } from "bun:test";
import {
  createNovelEngine,
  NOVEL_VOICE_CHANNEL,
  novelTimelineDefinitionIssue,
  novelTimelineStoryIssue,
  StoryValidationError,
} from "../src/index.ts";
import type { StoryDefinition } from "../src/types.ts";

const gainTrack = (channel: string) => ({
  channel,
  keyframes: [{ atMs: 0, value: 0 }, { atMs: 64, value: 1 }],
});

test("timeline gain tracks reject the six audio identities reserved by the SDK", () => {
  const reservedChannels = [NOVEL_VOICE_CHANNEL, "effect-0", "effect-1", "effect-2", "effect-3", "music-preview"];

  for (const channel of reservedChannels) {
    const issue = novelTimelineDefinitionIssue(
      { durationMs: 64, audioGains: [gainTrack(channel)] },
      "story.timelines.fade",
    );
    expect(issue).toContain("story.timelines.fade.audioGains[0].channel");
    if (channel === NOVEL_VOICE_CHANNEL) {
      expect(issue).toBe("story.timelines.fade.audioGains[0].channel is reserved for dialogue voice");
    } else {
      expect(issue).toBe(`story.timelines.fade.audioGains[0].channel '${channel}' is reserved by the SDK`);
    }
  }
});

test("timeline gain channels preserve public, user-owned, and replay-mapped names", () => {
  for (const channel of ["music", "ambience", "effect-4", "replay-music", "replay-effect-0", "replay-custom"]) {
    expect(novelTimelineDefinitionIssue({ durationMs: 64, audioGains: [gainTrack(channel)] })).toBeNull();
  }
});

test("timeline gain channels keep the native 64-character grammar boundary", () => {
  const valid64 = `a${"b".repeat(63)}`;
  const invalid65 = `a${"b".repeat(64)}`;

  expect(novelTimelineDefinitionIssue({ durationMs: 64, audioGains: [gainTrack(valid64)] })).toBeNull();
  expect(novelTimelineDefinitionIssue({ durationMs: 64, audioGains: [gainTrack(invalid65)] }))
    .toBe("timeline.audioGains[0].channel must be 1 to 64 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit");
  expect(novelTimelineDefinitionIssue({ durationMs: 64, audioGains: [gainTrack("music:main")] }))
    .toContain("timeline.audioGains[0].channel must be 1 to 64 ASCII letters");
});

test("shared story validation and engine construction report the reserved channel field path", () => {
  const story: StoryDefinition = {
    id: "timeline-reserved-channel",
    version: 1,
    start: "start",
    timelines: { fade: { durationMs: 64, audioGains: [gainTrack("effect-2")] } },
    script: { start: [{ type: "say", id: "line", text: "Ready." }] },
  };
  const expected = "story.timelines.fade.audioGains[0].channel 'effect-2' is reserved by the SDK";

  expect(novelTimelineStoryIssue(story)).toBe(expected);

  let thrown: unknown;
  try {
    createNovelEngine(story);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(StoryValidationError);
  expect((thrown as Error).message).toBe(expected);
});
