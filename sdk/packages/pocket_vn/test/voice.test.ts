import { expect, test } from "bun:test";
import { createNovelEngine, StoryValidationError } from "../src/engine.ts";
import { NOVEL_VOICE_CHANNEL, voiceBlocksAutoAdvance } from "../src/voice.ts";
import type { StoryDefinition } from "../src/types.ts";

const story: StoryDefinition = { id: "voiced", version: 1, start: "start", script: { start: [
  { type: "say", id: "one", text: "One", voice: "line-one" },
  { type: "say", id: "two", text: "Two", voice: "line-one" },
  { type: "ending", id: "end" },
] } };
const automatic = () => createNovelEngine(story, { preferences: { mode: "auto", textSpeedCharsPerSecond: 0, autoDelayMs: 100 } });

test("auto waits for actual completion and correlates repeated cues by request token", () => {
  const engine = automatic(); engine.start();
  const first = engine.getSnapshot().voice!;
  expect(first).toMatchObject({ lineId: "one", cue: "line-one", status: "pending" });
  engine.tick(100_000);
  expect(engine.getSnapshot().active?.id).toBe("one");
  engine.reportVoice({ token: first.token, status: "playing", durationMs: 1000, positionMs: 0 });
  engine.tick(100_000);
  expect(engine.getSnapshot().active?.id).toBe("one");
  engine.reportVoice({ token: first.token, status: "completed", positionMs: 1000 });
  expect(voiceBlocksAutoAdvance(engine.getSnapshot().voice)).toBe(false);
  engine.tick(0);
  const second = engine.getSnapshot().voice!;
  expect(second.lineId).toBe("two");
  expect(second.token).not.toBe(first.token);
  const unchanged = engine.getSnapshot();
  engine.reportVoice({ token: first.token, status: "completed" });
  expect(engine.getSnapshot()).toBe(unchanged);
  engine.tick(100_000);
  expect(engine.getSnapshot().active?.id).toBe("two");
});

test("manual reveal, skip and replay have independent playback intent", () => {
  const engine = createNovelEngine(story); engine.start();
  const first = engine.getSnapshot().voice!.token;
  engine.advance();
  expect(engine.getSnapshot().active?.id).toBe("one");
  expect(engine.getSnapshot().voice!.token).toBe(first);
  engine.replayVoice();
  expect(engine.getSnapshot().voice!.token).not.toBe(first);
  engine.advance();
  expect(engine.getSnapshot().active?.id).toBe("two");
  engine.rollback();
  expect(engine.getSnapshot().active?.id).toBe("one");
  expect(engine.getSnapshot().voice!.status).toBe("pending");
  engine.setPreferences({ mode: "skip", skipSeenOnly: true });
  engine.tick(0);
  expect(engine.getSnapshot().active?.id).toBe("two");
});

test("save/load excludes native facts, reissues voice and rejects stale completion", () => {
  const engine = automatic(); engine.start();
  const original = engine.getSnapshot().voice!.token;
  engine.reportVoice({ token: original, status: "playing", positionMs: 40, durationMs: 1000 });
  const save = engine.save();
  expect(JSON.stringify(save)).not.toContain(original);
  expect(JSON.stringify(save)).not.toContain("positionMs");
  engine.load(save);
  const renewed = engine.getSnapshot().voice!;
  expect(renewed.token).not.toBe(original);
  expect(renewed.status).toBe("pending");
  expect(renewed.positionMs).toBeUndefined();
  engine.reportVoice({ token: original, status: "completed" });
  engine.tick(10_000);
  expect(engine.getSnapshot().active?.id).toBe("one");
  const other = automatic(); other.load(save);
  expect(other.getSnapshot().voice!.token).not.toBe(renewed.token);
});

test("unavailable/error release auto waiting; completion while paused cannot advance", () => {
  for (const status of ["error", "unavailable"] as const) {
    const engine = automatic(); engine.start(); engine.tick(100);
    engine.pause();
    engine.reportVoice({ token: engine.getSnapshot().voice!.token, status, error: "Asset unavailable" });
    engine.tick(1000);
    expect(engine.getSnapshot().active?.id).toBe("one");
    engine.resume(); engine.tick(0);
    expect(engine.getSnapshot().active?.id).toBe("two");
    const token = engine.getSnapshot().voice!.token;
    engine.reportVoice({ token, status: "completed" });
    const snapshot = engine.getSnapshot();
    engine.reportVoice({ token, status: "paused" });
    expect(engine.getSnapshot()).toBe(snapshot);
  }
});

test("voice validation is atomic and its transport channel is reserved", () => {
  expect(() => createNovelEngine({ ...story, script: { start: [{ type: "say", id: "bad", text: "", voice: "" }] } })).toThrow(StoryValidationError);
  expect(() => createNovelEngine({ ...story, script: { start: [{ type: "audio", cue: "x", channel: NOVEL_VOICE_CHANNEL }] } })).toThrow(StoryValidationError);
  const engine = automatic(); engine.start();
  const snapshot = engine.getSnapshot();
  expect(() => engine.reportVoice({ token: snapshot.voice!.token, status: "playing", durationMs: NaN })).toThrow();
  expect(engine.getSnapshot()).toBe(snapshot);
  engine.dispose();
  expect(engine.getSnapshot().voice).toBeNull();
});
