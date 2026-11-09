import { expect, test } from "bun:test";
import { createNovelAudioAdapter } from "../src/audio.ts";
import { createNovelEngine } from "../src/engine.ts";
import type { EngineUpdate, NovelAudioIntent } from "../src/types.ts";
import type { StoryDefinition } from "../src/types.ts";
import { NOVEL_VOICE_CHANNEL, type NovelVoicePlaybackState } from "../src/voice.ts";

const update = (audioIntents: Record<string, NovelAudioIntent>, events: EngineUpdate["events"] = [], voice: NovelVoicePlaybackState | null = null, paused = false): EngineUpdate => ({ snapshot: { audioIntents, voice, paused } as EngineUpdate["snapshot"], events });
const music = (cue: string): NovelAudioIntent => ({ action: "play", cue, loop: true });
const dialogue = (token: string, cue: string, status: NovelVoicePlaybackState["status"] = "pending"): NovelVoicePlaybackState => ({ token, lineId: `line-${token}`, cue, status });

function textSoundStory(text = "雾港的灯仍亮着，信会找到归处。"): StoryDefinition {
  return {
    id: "text-sound-test",
    version: 1,
    start: "opening",
    script: { opening: [
      { type: "say", id: "test-line", speaker: "Mira", text },
      { type: "ending", id: "test-end" },
    ] },
  };
}

function textSoundHarness(options: { text?: string; speed?: number; mode?: "manual" | "auto" | "skip"; skipSeenOnly?: boolean; enabled?: boolean; gate?: Promise<void> } = {}) {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const engine = createNovelEngine(textSoundStory(options.text), {
    preferences: {
      textSpeedCharsPerSecond: options.speed ?? 32,
      mode: options.mode ?? "manual",
      skipSeenOnly: options.skipSeenOnly ?? true,
    },
  });
  const adapter = createNovelAudioAdapter({ request: async (capability, params) => {
    calls.push({ capability, params });
    if (options.gate && capability === "media.audio.play") await options.gate;
  } }, {
    text_default: "audio/text-default.wav",
    text_mira: "audio/text-mira.wav",
  }, {
    textSounds: { defaultCue: "text_default", speakers: { Mira: "text_mira" }, minIntervalMs: 100 },
    initialTextSoundsEnabled: options.enabled ?? true,
  });
  const unsubscribe = engine.subscribe(update => adapter.apply(update));
  engine.start();
  return { adapter, calls, engine, dispose: () => { unsubscribe(); engine.dispose(); adapter.dispose(); } };
}

test("frame snapshots do not restart BGM, restore intent changes once, effects stay bounded", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({ request: async (capability, params) => { calls.push({ capability, params }); } }, { storm: "audio/storm.wav", dawn: "audio/dawn.wav", click: "audio/click.wav" });
  for (let i = 0; i < 100; i++) adapter.apply(update({ music: music("storm") }));
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);
  adapter.apply(update({ music: music("dawn") }));
  for (let i = 0; i < 12; i++) adapter.apply(update({ music: music("dawn") }, [{ type: "audioCue", sequence: i, cue: "click", channel: null, action: "play", loop: false, location: { label: "test", index: i } }]));
  await adapter.settled();
  expect(new Set(calls.filter(call => String(call.params.channel).startsWith("effect-")).map(call => call.params.channel)).size).toBe(4);
  const musicPlays = calls.filter(call => call.params.channel === "music" && call.capability === "media.audio.play");
  expect(musicPlays).toHaveLength(2);
  expect(musicPlays.every(call => call.params.restart === undefined)).toBe(true);
  expect(calls.filter(call => String(call.params.channel).startsWith("effect-") && call.capability === "media.audio.play")
    .every(call => call.params.restart === true)).toBe(true);
  adapter.dispose(); await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.stop")).toHaveLength(5);
});

test("native commands for a channel preserve order and errors remain observable", async () => {
  const calls: string[] = [];
  const statuses: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const adapter = createNovelAudioAdapter({ request: async capability => {
    calls.push(capability);
    if (capability === "media.audio.play") await gate;
    if (capability === "media.audio.resume") throw new Error("capability unavailable");
  } }, { storm: "audio/storm.wav" }, { onStatus: status => statuses.push(status) });
  adapter.apply(update({ music: music("storm") }));
  adapter.setSuspended(true); adapter.setSuspended(false); adapter.setVolume(0.2);
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toEqual(["media.audio.play"]);
  release!(); await adapter.settled();
  expect(calls).toEqual(["media.audio.play", "media.audio.pause", "media.audio.resume", "media.audio.volume"]);
  expect(statuses).toContain("unavailable");
  expect(() => adapter.setVolume(2)).toThrow();
  adapter.dispose(); await adapter.settled();
});

test("missing audio cues report a structured adapter status without native dispatch", async () => {
  const calls: string[] = [];
  const statuses: Array<{ status: string; detail?: string }> = [];
  const adapter = createNovelAudioAdapter({
    request: async capability => { calls.push(capability); },
  }, {}, {
    onStatus: (status, detail) => statuses.push({ status, ...(detail === undefined ? {} : { detail }) }),
  });

  adapter.apply(update({ music: music("missing-storm") }));
  await adapter.settled();

  expect(calls).toEqual([]);
  expect(statuses).toEqual([{ status: "error", detail: "Unknown audio cue: missing-storm" }]);
  adapter.dispose();
  await adapter.settled();
});

test("native activation restores persistent JS intent without replaying transient cues", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
    onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  }, { storm: "audio/storm.wav", click: "audio/click.wav" });
  adapter.apply(update({ music: music("storm"), sfx: { action: "play", cue: "click", loop: false } }, [
    { type: "audioCue", sequence: 1, cue: "click", channel: null, action: "play", loop: false, location: { label: "test", index: 0 } },
  ]));
  await adapter.settled();
  const activation = (active: boolean) => listener?.({ method: "media.audio.activation", params: { active } });
  activation(false); activation(true);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music"]);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(3);
  adapter.setSuspended(true);
  activation(true);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume")).toHaveLength(1);
  adapter.setSuspended(false);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music", "music"]);
  adapter.apply(update({ music: { action: "stop", cue: "storm", loop: true } }));
  activation(true);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume")).toHaveLength(2);
  adapter.dispose(); await adapter.settled();
  expect(listener).toBeUndefined();
});

test("dialogue playback is token keyed and native facts arrive asynchronously", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const facts: Array<{ token: string; status: string; positionMs?: number; durationMs?: number }> = [];
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  let applying = false;
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
    onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  }, { letter: "audio/letter.wav" }, {
    onVoicePlayback: fact => {
      facts.push(fact);
      expect(applying).toBe(false);
    },
  });
  const first = dialogue("voice-1-1", "letter");
  applying = true;
  adapter.apply(update({}, [], first));
  adapter.apply(update({}, [], first));
  applying = false;
  await adapter.settled();

  const voicePlays = calls.filter(call => call.capability === "media.audio.play");
  expect(voicePlays).toHaveLength(1);
  const firstPlaybackId = voicePlays[0]?.params.playbackId;
  expect(firstPlaybackId).toBe("novel-voice-0");
  expect(firstPlaybackId).not.toBe(first.token);
  expect(voicePlays[0]?.params).toMatchObject({
    channel: NOVEL_VOICE_CHANNEL,
    asset: "audio/letter.wav",
    loop: false,
    playbackId: firstPlaybackId,
    restart: true,
  });

  listener?.({ method: "media.audio.playback", params: {
    channel: NOVEL_VOICE_CHANNEL, playbackId: firstPlaybackId, status: "playing", positionMs: 80, durationMs: 540,
  } });
  expect(facts).toEqual([]);
  await Promise.resolve();
  expect(facts).toEqual([{ token: first.token, status: "playing", positionMs: 80, durationMs: 540 }]);

  const second = dialogue("voice-1-2", "letter");
  adapter.apply(update({}, [], second));
  await adapter.settled();
  const secondPlaybackId = calls.filter(call => call.capability === "media.audio.play" && call.params.channel === NOVEL_VOICE_CHANNEL).at(-1)?.params.playbackId;
  listener?.({ method: "media.audio.playback", params: {
    channel: NOVEL_VOICE_CHANNEL, playbackId: firstPlaybackId, status: "completed", positionMs: 540, durationMs: 540,
  } });
  listener?.({ method: "media.audio.playback", params: {
    channel: NOVEL_VOICE_CHANNEL, playbackId: secondPlaybackId, status: "completed", positionMs: 540, durationMs: 540,
  } });
  await Promise.resolve();
  await adapter.settled();
  expect(facts.map(fact => [fact.token, fact.status])).toEqual([
    [first.token, "playing"], [second.token, "completed"],
  ]);
  expect(calls.filter(call => call.capability === "media.audio.stop")).toHaveLength(1);

  adapter.dispose();
  await adapter.settled();
  expect(listener).toBeUndefined();
});

test("unknown and unavailable voice cues release auto-wait asynchronously", async () => {
  const facts: Array<{ token: string; status: string; error?: string }> = [];
  const adapter = createNovelAudioAdapter({
    request: async () => { throw new Error("audio capability unavailable"); },
  }, {}, { onVoicePlayback: fact => facts.push(fact) });
  const unknown = dialogue("voice-2-1", "missing");
  adapter.apply(update({}, [], unknown));
  expect(facts).toEqual([]);
  await Promise.resolve();
  expect(facts).toEqual([{ token: unknown.token, status: "error", error: "Unknown audio cue: missing" }]);

  const unavailableAdapter = createNovelAudioAdapter({
    request: async () => { throw new Error("audio capability unavailable"); },
  }, { line: "audio/line.wav" }, { onVoicePlayback: fact => facts.push(fact) });
  const unavailable = dialogue("voice-2-2", "line");
  unavailableAdapter.apply(update({}, [], unavailable));
  await unavailableAdapter.settled();
  expect(facts.at(-1)).toEqual({ token: unavailable.token, status: "unavailable", error: "audio capability unavailable" });
  unavailableAdapter.dispose();
  await unavailableAdapter.settled();
  adapter.dispose();
});

test("asset localization updates resolve on later snapshots without eager playback", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { bed: "audio/bed-en.wav", line: "audio/line-en.wav" });
  const updateWithBed = update({ music: music("bed") });
  adapter.apply(updateWithBed);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);

  adapter.setAssets({ bed: "audio/bed-zh.wav", line: "audio/line-zh.wav" });
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);
  adapter.apply(updateWithBed);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play").at(-1)?.params.asset).toBe("audio/bed-zh.wav");

  const oldLine = dialogue("voice-3-1", "line");
  adapter.apply(update({}, [], oldLine));
  await adapter.settled();
  adapter.setAssets({ bed: "audio/bed-zh.wav", line: "audio/line-ja.wav" });
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === NOVEL_VOICE_CHANNEL)).toHaveLength(1);
  adapter.apply(update({}, [], dialogue("voice-3-2", "line")));
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === NOVEL_VOICE_CHANNEL).at(-1)?.params.asset).toBe("audio/line-ja.wav");

  adapter.dispose();
  await adapter.settled();
});

test("only unfinished voice resumes after lifecycle return", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
    onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  }, { bed: "audio/bed.wav", line: "audio/line.wav" });
  const voice = dialogue("voice-4-1", "line", "paused");
  adapter.apply(update({ music: music("bed") }, [], voice));
  await adapter.settled();
  listener?.({ method: "media.audio.activation", params: { active: false } });
  listener?.({ method: "media.audio.activation", params: { active: true } });
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music", NOVEL_VOICE_CHANNEL]);

  const playbackId = calls.find(call => call.capability === "media.audio.play" && call.params.channel === NOVEL_VOICE_CHANNEL)?.params.playbackId;
  listener?.({ method: "media.audio.playback", params: {
    channel: NOVEL_VOICE_CHANNEL, playbackId, status: "completed", positionMs: 100, durationMs: 100,
  } });
  await Promise.resolve();
  adapter.apply(update({ music: music("bed") }, [], dialogue(voice.token, "line", "completed")));
  listener?.({ method: "media.audio.activation", params: { active: true } });
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music", NOVEL_VOICE_CHANNEL, "music"]);
  adapter.dispose();
  await adapter.settled();
});

test("engine menu pause suspends only voice and deduplicates lifecycle pause", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { bed: "audio/bed.wav", line: "audio/line.wav" });
  const intents = { music: music("bed") };
  const voice = dialogue("voice-5-1", "line");
  adapter.apply(update(intents, [], voice));
  await adapter.settled();

  adapter.apply(update(intents, [], voice, true));
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.pause").map(call => call.params.channel)).toEqual([NOVEL_VOICE_CHANNEL]);
  expect(calls.filter(call => call.capability === "media.audio.pause").some(call => call.params.channel === "music")).toBe(false);

  adapter.setSuspended(true);
  adapter.setSuspended(false);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.pause").map(call => call.params.channel)).toEqual([NOVEL_VOICE_CHANNEL, "music"]);
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music"]);

  adapter.apply(update(intents, [], dialogue(voice.token, "line", "paused"), false));
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music", NOVEL_VOICE_CHANNEL]);

  adapter.dispose();
  await adapter.settled();
});

test("failed voice resume reports a terminal fact for the active token", async () => {
  const facts: Array<{ token: string; status: string; error?: string }> = [];
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const adapter = createNovelAudioAdapter({
    request: async capability => {
      if (capability === "media.audio.resume") throw new Error("audio capability unavailable");
    },
    onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  }, { line: "audio/line.wav" }, { onVoicePlayback: fact => facts.push(fact) });
  const current = dialogue("voice-6-1", "line", "paused");
  adapter.apply(update({}, [], current));
  await adapter.settled();
  listener?.({ method: "media.audio.activation", params: { active: false } });
  listener?.({ method: "media.audio.activation", params: { active: true } });
  await adapter.settled();
  await Promise.resolve();
  expect(facts).toEqual([{ token: current.token, status: "unavailable", error: "audio capability unavailable" }]);
  adapter.dispose();
  await adapter.settled();
});

test("grouped mix updates live music, effects, custom channels and voice without replay", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, {
    bed: "audio/bed.wav",
    wind: "audio/wind.wav",
    click: "audio/click.wav",
    line: "audio/line.wav",
  });
  adapter.apply(update({
    music: music("bed"),
    ambience: music("wind"),
    custom: music("wind"),
  }, [
    { type: "audioCue", sequence: 1, cue: "click", channel: null, action: "play", loop: false, location: { label: "test", index: 0 } },
  ], dialogue("mix-voice-1", "line")));
  await adapter.settled();

  const initialPlays = calls.filter(call => call.capability === "media.audio.play");
  expect(initialPlays.map(call => [call.params.channel, call.params.volume])).toEqual([
    ["music", 0.7],
    ["ambience", 0.7],
    ["custom", 0.7],
    ["effect-0", 0.7],
    [NOVEL_VOICE_CHANNEL, 0.7],
  ]);

  expect(adapter.getMix()).toEqual({ master: 0.7, music: 1, effects: 1, voice: 1 });
  adapter.setMix({ master: 0.5, music: 0.5, effects: 0.2, voice: 0.8 });
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.volume").map(call => [call.params.channel, call.params.volume])).toEqual([
    ["music", 0.25],
    ["ambience", 0.1],
    ["custom", 0.1],
    ["effect-0", 0.1],
    [NOVEL_VOICE_CHANNEL, 0.4],
  ]);

  const repeated = { master: 0.5, music: 0.5, effects: 0.2, voice: 0.8 } as const;
  adapter.setMix(repeated);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.volume")).toHaveLength(5);

  adapter.setMix({ music: 0.25 });
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.volume").at(-1)).toMatchObject({
    params: { channel: "music", volume: 0.125 },
  });
  expect(calls.filter(call => call.capability === "media.audio.volume")).toHaveLength(6);

  adapter.apply(update({ music: music("bed"), later_custom: music("wind") }));
  await adapter.settled();
  const newCustomPlay = calls.find(call => call.capability === "media.audio.play" && call.params.channel === "later_custom");
  expect(newCustomPlay?.params.volume).toBe(0.1);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(6);
  adapter.dispose();
  await adapter.settled();
});

test("explicit music groups route custom main and replay channels through the existing mix", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, {
    bed: "audio/bed.wav",
    replay: "audio/replay.wav",
    wind: "audio/wind.wav",
  }, {
    initialMix: { master: 0.7, music: 0.4, effects: 0.2 },
  });
  const main = {
    music: music("bed"),
    "harbor-bed": { action: "play", cue: "wind", loop: true, group: "music", gain: 0.5 } as const,
    "rain-bed": { action: "play", cue: "wind", loop: true, group: "effects", gain: 0.5 } as const,
  };
  adapter.apply(update(main), "main");
  await adapter.settled();
  const initialPlays = calls.filter(call => call.capability === "media.audio.play");
  expect(initialPlays.map(call => call.params.channel)).toEqual(["music", "harbor-bed", "rain-bed"]);
  [0.28, 0.14, 0.07].forEach((volume, index) => expect(initialPlays[index]?.params.volume).toBeCloseTo(volume));

  adapter.setMix({ music: 0.8, effects: 0.5 });
  await adapter.settled();
  const groupedVolumes = calls.filter(call => call.capability === "media.audio.volume");
  expect(groupedVolumes.map(call => call.params.channel)).toEqual(["music", "harbor-bed", "rain-bed"]);
  [0.56, 0.28, 0.175].forEach((volume, index) => expect(groupedVolumes[index]?.params.volume).toBeCloseTo(volume));

  // Changing only a cue's authored group changes the effective volume without replay.
  adapter.apply(update({
    ...main,
    "harbor-bed": { action: "play", cue: "wind", loop: true, group: "effects", gain: 0.5 },
  }), "main");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(3);
  expect(calls.filter(call => call.capability === "media.audio.volume").at(-1)).toMatchObject({
    params: { channel: "harbor-bed", volume: 0.175 },
  });

  adapter.apply(update({
    music: { action: "play", cue: "replay", loop: true, gain: 0.25 },
    "harbor-bed": { action: "play", cue: "wind", loop: true, group: "music", gain: 0.5 },
    "rain-bed": { action: "play", cue: "wind", loop: true, group: "effects", gain: 0.5 },
  }), "replay");
  await adapter.settled();
  expect(calls.find(call => call.capability === "media.audio.play" && call.params.channel === "replay-harbor-bed")?.params.volume)
    .toBeCloseTo(0.28);
  expect(calls.find(call => call.capability === "media.audio.play" && call.params.channel === "replay-rain-bed")?.params.volume)
    .toBeCloseTo(0.175);
  expect(calls.find(call => call.capability === "media.audio.play" && call.params.channel === "music-preview")?.params.volume)
    .toBeCloseTo(0.14);

  adapter.setMix({ music: 0.2, effects: 0.1 });
  await adapter.settled();
  const latestVolumes = new Map(calls.filter(call => call.capability === "media.audio.volume")
    .map(call => [String(call.params.channel), Number(call.params.volume)]));
  expect(latestVolumes.get("replay-harbor-bed")).toBeCloseTo(0.07);
  expect(latestVolumes.get("replay-rain-bed")).toBeCloseTo(0.035);
  expect(latestVolumes.get("music-preview")).toBeCloseTo(0.035);

  adapter.dispose();
  await adapter.settled();
});

test("timeline crossfade plays two grouped loops, applies both gains, and honors stop events", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const story: StoryDefinition = {
    id: "audio-adapter-timeline-crossfade", version: 1, start: "start",
    timelines: { crossfade: {
      durationMs: 100,
      audio: [
        { atMs: 0, cue: "theme-a", channel: "harbor-a", loop: true, group: "music" },
        { atMs: 25, cue: "theme-b", channel: "harbor-b", loop: true, group: "music" },
        { atMs: 75, cue: "stop-a", action: "stop", channel: "harbor-a" },
        { atMs: 100, cue: "stop-b", action: "stop", channel: "harbor-b" },
      ],
      audioGains: [
        { channel: "harbor-a", keyframes: [{ atMs: 0, value: 1 }, { atMs: 100, value: 0 }] },
        { channel: "harbor-b", keyframes: [{ atMs: 0, value: 0 }, { atMs: 100, value: 1 }] },
      ],
    } },
    script: { start: [
      { type: "scene", timeline: "crossfade" },
      { type: "say", id: "end", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { "theme-a": "audio/a.wav", "theme-b": "audio/b.wav" }, {
    initialMix: { master: 0.5, music: 0.8, effects: 0.1 },
  });
  const unsubscribe = engine.subscribe(update => adapter.apply(update));
  engine.start();
  await adapter.settled();
  engine.tick(25);
  await adapter.settled();
  engine.tick(50);
  await adapter.settled();
  engine.tick(25);
  await adapter.settled();

  const plays = calls.filter(call => call.capability === "media.audio.play");
  expect(plays.map(call => call.params.channel)).toEqual(["harbor-a", "harbor-b"]);
  expect(plays[0]?.params.volume).toBeCloseTo(0.4);
  expect(plays[1]?.params.volume).toBeCloseTo(0.1);
  const volumes = calls.filter(call => call.capability === "media.audio.volume");
  expect(volumes.map(call => call.params.channel)).toEqual(["harbor-a", "harbor-b"]);
  expect(volumes[0]?.params.volume).toBeCloseTo(0.3);
  expect(volumes[1]?.params.volume).toBeCloseTo(0.3);
  expect(calls.filter(call => call.capability === "media.audio.stop").map(call => call.params.channel))
    .toEqual(["harbor-a", "harbor-b"]);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(2);

  unsubscribe();
  engine.dispose();
  adapter.dispose();
  await adapter.settled();
});

test("intent gain composes with grouped mix while omitted gain and repeated snapshots stay inert", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { bed: "audio/bed.wav", wind: "audio/wind.wav", click: "audio/click.wav" }, {
    initialMix: { master: 0.7, music: 0.5, effects: 0.5 },
  });
  const legacy = {
    music: music("bed"),
    ambience: { action: "play", cue: "wind", loop: true, gain: 0 } as const,
    custom: { action: "play", cue: "click", loop: true, gain: 0.5 } as const,
  };
  for (let index = 0; index < 24; index++) adapter.apply(update(legacy));
  await adapter.settled();

  expect(calls.filter(call => call.capability === "media.audio.play").map(call => [call.params.channel, call.params.volume])).toEqual([
    ["music", 0.35], ["ambience", 0], ["custom", 0.175],
  ]);
  expect(calls.filter(call => call.capability === "media.audio.volume")).toHaveLength(0);

  adapter.apply(update({
    music: { ...music("bed"), gain: 0.25 },
    ambience: { action: "play", cue: "wind", loop: true, gain: 0.4 },
    custom: { action: "play", cue: "click", loop: true, gain: 0.5 },
  }));
  await adapter.settled();
  const gainVolumes = calls.filter(call => call.capability === "media.audio.volume");
  expect(gainVolumes.map(call => call.params.channel)).toEqual(["music", "ambience"]);
  expect(gainVolumes.map(call => call.params.volume)).toEqual([0.0875, expect.any(Number)]);
  expect(gainVolumes[1]?.params.volume).toBeCloseTo(0.14);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(3);
  expect(calls.filter(call => call.capability === "media.audio.stop")).toHaveLength(0);

  adapter.setMix({ master: 0.5, music: 0.4, effects: 0.2 });
  await adapter.settled();
  adapter.apply(update({
    music: { ...music("bed"), gain: 0.25 },
    ambience: { action: "play", cue: "wind", loop: true, gain: 0.4 },
    custom: { action: "play", cue: "click", loop: true, gain: 0.5 },
  }));
  await adapter.settled();
  const mixedVolumes = calls.filter(call => call.capability === "media.audio.volume").slice(2);
  expect(mixedVolumes.map(call => call.params.channel)).toEqual(["music", "ambience", "custom"]);
  expect(mixedVolumes.map(call => call.params.volume)).toEqual([0.05, expect.any(Number), 0.05]);
  expect(mixedVolumes[1]?.params.volume).toBeCloseTo(0.04);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(3);
  expect(calls.filter(call => call.capability === "media.audio.stop")).toHaveLength(0);
  adapter.dispose();
  await adapter.settled();
});

test("timeline gain reaches audio as volume across suspension, save load and rollback", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const story: StoryDefinition = {
    id: "audio-gain-adapter-save-rollback", version: 1, start: "start",
    timelines: { fade: {
      durationMs: 100,
      audio: [{ atMs: 0, cue: "bed", channel: "music", loop: true }],
      audioGains: [{ channel: "music", keyframes: [
        { atMs: 0, value: 1 }, { atMs: 100, value: 0.2 },
      ] }],
    } },
    script: { start: [
      { type: "scene", timeline: "fade" },
      { type: "say", id: "one", text: "" },
      { type: "say", id: "two", text: "" },
    ] },
  };
  const engine = createNovelEngine(story);
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { bed: "audio/bed.wav" });
  const unsubscribe = engine.subscribe(current => adapter.apply(current));
  engine.start();
  await adapter.settled();
  engine.tick(50);
  await adapter.settled();

  adapter.setSuspended(true);
  await adapter.settled();
  engine.tick(10);
  await adapter.settled();
  adapter.setSuspended(false);
  await adapter.settled();
  engine.advance();
  engine.tick(20);
  await adapter.settled();
  const saved = engine.save();
  engine.tick(10);
  await adapter.settled();
  engine.load(JSON.parse(JSON.stringify(saved)));
  await adapter.settled();
  engine.rollback();
  await adapter.settled();

  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);
  const volumeCalls = calls.filter(call => call.capability === "media.audio.volume");
  expect(volumeCalls.map(call => call.params.channel)).toEqual(Array(6).fill("music"));
  [0.42, 0.364, 0.252, 0.196, 0.252, 0.364].forEach((volume, index) => {
    expect(volumeCalls[index]?.params.volume).toBeCloseTo(volume);
  });
  expect(calls.filter(call => call.capability === "media.audio.pause").map(call => call.params.channel)).toEqual(["music"]);
  expect(calls.filter(call => call.capability === "media.audio.resume").map(call => call.params.channel)).toEqual(["music"]);
  unsubscribe();
  engine.dispose();
  adapter.dispose();
  await adapter.settled();
});

test("replay named intents use an isolated transport channel and stop before main resumes", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, {
    main: "audio/main.wav", replay: "audio/replay.wav", wind: "audio/wind.wav",
  }, { initialMix: { master: 0.7, music: 0.5, effects: 0.4 } });
  const mainWind = { action: "play", cue: "wind", loop: true, gain: 0.5 } as const;
  const replayWind = { action: "play", cue: "wind", loop: true, gain: 0.25 } as const;
  const mainIntents = { music: music("main"), "harbor-wind": mainWind };
  const replayIntents = {
    music: { action: "play", cue: "replay", loop: true, gain: 0.2 } as const,
    "harbor-wind": replayWind,
  };
  adapter.apply(update(mainIntents), "main");
  await adapter.settled();
  adapter.apply(update(replayIntents), "replay");
  await adapter.settled();

  const replayChannel = "replay-harbor-wind";
  const replayWindPlay = calls.find(call => call.capability === "media.audio.play" && call.params.channel === replayChannel);
  expect(replayWindPlay?.params).toMatchObject({ asset: "audio/wind.wav" });
  expect(replayWindPlay?.params.volume).toBeCloseTo(0.07);
  const replayMusicPlay = calls.find(call => call.capability === "media.audio.play" && call.params.channel === "music-preview");
  expect(replayMusicPlay?.params).toMatchObject({ asset: "audio/replay.wav" });
  expect(replayMusicPlay?.params.volume).toBeCloseTo(0.07);
  expect(calls.find(call => call.capability === "media.audio.play" && call.params.channel === "harbor-wind")?.params.volume).toBeCloseTo(0.14);

  adapter.apply(update({
    music: { action: "play", cue: "replay", loop: true, gain: 0.8 },
    "harbor-wind": { action: "play", cue: "wind", loop: true, gain: 0.5 },
  }), "replay");
  await adapter.settled();
  const replayVolumes = calls.filter(call => call.capability === "media.audio.volume");
  expect(replayVolumes.map(call => call.params.channel)).toEqual([replayChannel, "music-preview"]);
  expect(replayVolumes[0]?.params.volume).toBeCloseTo(0.14);
  expect(replayVolumes[1]?.params.volume).toBeCloseTo(0.28);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(4);

  const stopWind = {
    type: "audioCue", sequence: 3, cue: "wind", action: "stop", channel: "harbor-wind", loop: false,
    location: { label: "replay", index: 3 },
  } as const;
  adapter.apply(update({
    music: { action: "play", cue: "replay", loop: true, gain: 0.8 },
    "harbor-wind": { action: "stop", cue: "wind", loop: false },
  }, [stopWind]), "replay");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.stop" && call.params.channel === replayChannel)).toHaveLength(1);

  adapter.apply(update(mainIntents), "main");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.stop" && call.params.channel === "music-preview")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.resume" && call.params.channel === "music")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "music")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "harbor-wind")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === replayChannel)).toHaveLength(1);
  adapter.dispose();
  await adapter.settled();
});

test("replay channel mapping handles a main-name collision and long authored channel names", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { wind: "audio/wind.wav" });
  const collision = "replay-harbor-wind";
  adapter.apply(update({ [collision]: { action: "play", cue: "wind", loop: true } }));
  await adapter.settled();

  const longChannel = `harbor-${"very-long-".repeat(12)}`;
  adapter.apply(update({
    "harbor-wind": { action: "play", cue: "wind", loop: true },
    [longChannel]: { action: "play", cue: "wind", loop: true, gain: 0.5 },
  }), "replay");
  await adapter.settled();
  const mappedChannels = calls.filter(call => call.capability === "media.audio.play" &&
    call.params.channel !== collision).map(call => String(call.params.channel));
  expect(mappedChannels).toEqual(["replay-harbor-wind-1", expect.stringMatching(/^replay-[0-9a-f]{8}$/)]);
  expect(mappedChannels.every(channel => channel.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(channel))).toBe(true);
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === collision)).toHaveLength(1);

  adapter.apply(update({
    "harbor-wind": { action: "stop", cue: "wind", loop: false },
    [longChannel]: { action: "play", cue: "wind", loop: true, gain: 0.75 },
  }), "replay");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play" &&
    String(call.params.channel).startsWith("replay-") && call.params.channel !== collision)).toHaveLength(2);
  expect(calls.filter(call => call.capability === "media.audio.volume").map(call => call.params.channel)).toEqual([mappedChannels[1]]);
  adapter.apply(update({ [collision]: { action: "play", cue: "wind", loop: true } }), "main");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.stop" && call.params.channel === "replay-harbor-wind-1")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.stop" && call.params.channel === mappedChannels[1])).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.stop" && call.params.channel === collision)).toHaveLength(0);
  adapter.dispose();
  await adapter.settled();
});

test("slow native volume requests coalesce intermediate timeline gain ticks", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  let releaseVolume: (() => void) | undefined;
  let reportVolumeStarted: (() => void) | undefined;
  let volumeGate: Promise<void> | null = null;
  const volumeStarted = new Promise<void>(resolve => { reportVolumeStarted = resolve; });
  let observedVolume = false;
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => {
      calls.push({ capability, params });
      if (capability === "media.audio.volume" && volumeGate) {
        if (!observedVolume) {
          observedVolume = true;
          reportVolumeStarted!();
        }
        await volumeGate;
      }
    },
  }, { bed: "audio/bed.wav" });
  const groupedIntent = (gain: number) => ({ action: "play", cue: "bed", loop: true, group: "music", gain } as const);
  adapter.apply(update({ "harbor-bed": groupedIntent(1) }));
  await adapter.settled();

  volumeGate = new Promise<void>(resolve => { releaseVolume = resolve; });
  adapter.apply(update({ "harbor-bed": groupedIntent(0.2) }));
  await volumeStarted;
  expect(calls.filter(call => call.capability === "media.audio.volume")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.volume")[0]?.params.channel).toBe("harbor-bed");
  expect(calls.filter(call => call.capability === "media.audio.volume")[0]?.params.volume).toBeCloseTo(0.14);
  for (let index = 21; index <= 99; index++) {
    adapter.apply(update({ "harbor-bed": groupedIntent(index / 100) }));
  }
  releaseVolume!();
  await adapter.settled();

  const finalVolumes = calls.filter(call => call.capability === "media.audio.volume").map(call => call.params.volume);
  expect(finalVolumes).toHaveLength(2);
  expect(finalVolumes[0]).toBeCloseTo(0.14);
  expect(finalVolumes[1]).toBeCloseTo(0.693);
  expect(calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);
  adapter.dispose();
  await adapter.settled();
});

test("source changes stop the shared transient effect pool before new-source cues", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { click: "audio/click.wav" });
  const cue = (sequence: number) => ({
    type: "audioCue", sequence, cue: "click", channel: null, action: "play", loop: false,
    location: { label: "test", index: sequence },
  } as const);
  adapter.apply(update({}, [cue(1)]), "main");
  await adapter.settled();
  adapter.apply(update({}, [cue(2)]), "replay");
  await adapter.settled();
  adapter.apply(update({}, [cue(3)]), "main");
  await adapter.settled();

  expect(calls.filter(call => call.capability === "media.audio.play").map(call => call.params.channel)).toEqual([
    "effect-0", "effect-1", "effect-2",
  ]);
  expect(calls.filter(call => call.capability === "media.audio.stop").map(call => call.params.channel)).toEqual([
    "effect-0", "effect-1",
  ]);
  adapter.dispose();
  await adapter.settled();
});

test("transient pool plays keep default gain when a persistent channel shares the slot name", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { click: "audio/click.wav" });
  const cue = {
    type: "audioCue", sequence: 1, cue: "click", channel: null, action: "play", loop: false,
    location: { label: "test", index: 1 },
  } as const;
  adapter.apply(update({
    "effect-0": { action: "play", cue: "click", loop: true, gain: 0.2 },
  }, [cue]));
  await adapter.settled();

  const playVolumes = calls.filter(call => call.capability === "media.audio.play").map(call => call.params.volume);
  expect(playVolumes).toHaveLength(2);
  expect(playVolumes[0]).toBeCloseTo(0.14);
  expect(playVolumes[1]).toBe(0.7);
  adapter.dispose();
  await adapter.settled();
});

test("master-only setVolume preserves group gains and mix validation is atomic", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { bed: "audio/bed.wav", click: "audio/click.wav" }, {
    initialMix: { master: 0.6, music: 0.5, effects: 0.25, voice: 0.75 },
  });
  adapter.apply(update({ music: music("bed"), ambience: music("click") }));
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play").map(call => call.params.volume)).toEqual([0.3, 0.15]);

  adapter.setVolume(0.4);
  await adapter.settled();
  expect(adapter.getMix()).toEqual({ master: 0.4, music: 0.5, effects: 0.25, voice: 0.75 });
  expect(calls.filter(call => call.capability === "media.audio.volume").map(call => call.params.volume)).toEqual([0.2, 0.1]);

  expect(() => adapter.setMix({ master: 0.2, effects: 2 })).toThrow();
  expect(adapter.getMix()).toEqual({ master: 0.4, music: 0.5, effects: 0.25, voice: 0.75 });
  expect(() => adapter.setMix({ effects: Number.NaN })).toThrow();
  expect(() => adapter.setMix({ custom: 0.4 } as never)).toThrow();
  expect(() => adapter.setVolume(2)).toThrow();
  adapter.dispose();
  await adapter.settled();
});

test("explicit stop events restart an unchanged persistent cue after a new-game boundary", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, { bed: "audio/bed.wav" });
  const persistent = { music: music("bed") };
  const location = { label: "start", index: 0 };
  adapter.apply(update(persistent));
  await adapter.settled();

  adapter.apply(update(persistent, [
    { type: "audioCue", sequence: 1, cue: "bed", action: "stop", channel: "music", loop: false, location },
    { type: "audioCue", sequence: 2, cue: "bed", action: "play", channel: "music", loop: true, location },
  ]));
  await adapter.settled();

  expect(calls.filter(call => call.params.channel === "music").map(call => call.capability)).toEqual([
    "media.audio.play",
    "media.audio.stop",
    "media.audio.play",
  ]);
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "music")).toHaveLength(2);
  adapter.dispose();
  await adapter.settled();
});

test("replay music uses one overlay channel and resumes the original main player", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
  }, {
    main: "audio/main.wav",
    replay: "audio/replay.wav",
    preview: "audio/preview.wav",
  }, { initialMix: { master: 0.5, music: 0.6 } });

  adapter.apply(update({ music: music("main") }), "main");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "music")).toHaveLength(1);

  adapter.apply(update({ music: music("replay") }), "replay");
  await adapter.settled();
  const mainPause = calls.findIndex(call => call.capability === "media.audio.pause" && call.params.channel === "music");
  const replayPlay = calls.findIndex(call => call.capability === "media.audio.play" && call.params.channel === "music-preview");
  expect(mainPause).toBeGreaterThanOrEqual(0);
  expect(replayPlay).toBeGreaterThan(mainPause);
  expect(calls[replayPlay]?.params).toMatchObject({
    asset: "audio/replay.wav",
    loop: true,
    volume: 0.3,
    restart: true,
  });

  adapter.previewMusic("preview");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "music-preview").at(-1)?.params.asset)
    .toBe("audio/preview.wav");

  adapter.setSuspended(true);
  adapter.setSuspended(false);
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.resume" && call.params.channel === "music")).toHaveLength(0);
  expect(calls.filter(call => call.capability === "media.audio.resume" && call.params.channel === "music-preview")).toHaveLength(1);

  adapter.stopMusicPreview();
  await adapter.settled();
  expect(adapter.getMusicPreviewCue()).toBeNull();
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "music-preview").at(-1)?.params.asset)
    .toBe("audio/replay.wav");

  adapter.apply(update({ music: music("main") }), "main");
  await adapter.settled();
  expect(calls.filter(call => call.capability === "media.audio.play" && call.params.channel === "music")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.stop" && call.params.channel === "music-preview")).toHaveLength(1);
  expect(calls.filter(call => call.capability === "media.audio.resume" && call.params.channel === "music")).toHaveLength(1);
  adapter.dispose();
  await adapter.settled();
});

test("voice playback facts reject a stale transport id when a core token is reused", async () => {
  const calls: Array<{ capability: string; params: Record<string, string | number | boolean> }> = [];
  const facts: Array<{ token: string; status: string }> = [];
  let listener: ((event: { method: string; params: Record<string, unknown> }) => void) | undefined;
  const adapter = createNovelAudioAdapter({
    request: async (capability, params) => { calls.push({ capability, params }); },
    onEvent: callback => { listener = callback; return () => { listener = undefined; }; },
  }, { line: "audio/line.wav" }, { onVoicePlayback: fact => facts.push({ token: fact.token, status: fact.status }) });
  const sameMainToken = dialogue("same-main-token", "line");
  adapter.apply(update({}, [], sameMainToken), "main");
  await adapter.settled();
  const firstId = calls.filter(call => call.capability === "media.audio.play" && call.params.channel === NOVEL_VOICE_CHANNEL).at(-1)?.params.playbackId;

  adapter.apply(update({}, [], dialogue("replay-token", "line")), "replay");
  await adapter.settled();
  adapter.apply(update({}, [], sameMainToken), "main");
  await adapter.settled();
  const currentId = calls.filter(call => call.capability === "media.audio.play" && call.params.channel === NOVEL_VOICE_CHANNEL).at(-1)?.params.playbackId;
  expect(currentId).not.toBe(firstId);

  listener?.({ method: "media.audio.playback", params: {
    channel: NOVEL_VOICE_CHANNEL, playbackId: firstId, status: "completed", positionMs: 100, durationMs: 100,
  } });
  listener?.({ method: "media.audio.playback", params: {
    channel: NOVEL_VOICE_CHANNEL, playbackId: currentId, status: "completed", positionMs: 100, durationMs: 100,
  } });
  await Promise.resolve();
  expect(facts).toEqual([{ token: "same-main-token", status: "completed" }]);
  adapter.dispose();
  await adapter.settled();
});

test("glyph audio follows fractional reveal time across 8, 16 and 32 ms virtual ticks", async () => {
  for (const stepMs of [8, 16, 32]) {
    const harness = textSoundHarness();
    let elapsed = 0;
    for (let attempt = 0; attempt < 40 && !harness.calls.some(call => call.capability === "media.audio.play"); attempt++) {
      harness.engine.tick(stepMs);
      elapsed += stepMs;
      await harness.adapter.settled();
    }
    await harness.adapter.settled();
    const firstBlip = harness.calls.find(call => call.capability === "media.audio.play");
    expect(firstBlip?.params).toMatchObject({ channel: "effect-0", asset: "audio/text-mira.wav", loop: false });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThanOrEqual(160);
    harness.dispose();
    await harness.adapter.settled();
  }
});

test("glyph audio is off by default, ignores whitespace and reveal-all, and resets on pause or skip", async () => {
  const off = textSoundHarness({ enabled: false });
  expect(off.adapter.getTextSoundsEnabled()).toBe(false);
  for (let i = 0; i < 12; i++) off.engine.tick(16);
  await off.adapter.settled();
  expect(off.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  off.adapter.setTextSoundsEnabled(true);
  expect(off.adapter.getTextSoundsEnabled()).toBe(true);
  off.engine.advance();
  await off.adapter.settled();
  expect(off.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  off.dispose();
  await off.adapter.settled();

  const spaces = textSoundHarness({ text: "        " });
  for (let i = 0; i < 7; i++) spaces.engine.tick(16);
  await spaces.adapter.settled();
  expect(spaces.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  spaces.dispose();
  await spaces.adapter.settled();

  const paused = textSoundHarness();
  for (let i = 0; i < 4; i++) paused.engine.tick(16);
  paused.engine.pause();
  paused.engine.resume();
  for (let i = 0; i < 4; i++) paused.engine.tick(16);
  await paused.adapter.settled();
  expect(paused.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  for (let i = 0; i < 4; i++) paused.engine.tick(16);
  await paused.adapter.settled();
  expect(paused.calls.filter(call => call.capability === "media.audio.play").length).toBeGreaterThan(0);
  paused.dispose();
  await paused.adapter.settled();

  const skipped = textSoundHarness({ mode: "skip", skipSeenOnly: false });
  skipped.engine.tick(1000);
  await skipped.adapter.settled();
  expect(skipped.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  skipped.dispose();
  await skipped.adapter.settled();
});

test("native backpressure keeps at most one pending glyph sound", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const harness = textSoundHarness({ gate });
  for (let i = 0; i < 8; i++) harness.engine.tick(16);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const pending = harness.calls.filter(call => call.capability === "media.audio.play");
  expect(pending).toHaveLength(1);
  for (let i = 0; i < 20; i++) harness.engine.tick(16);
  expect(harness.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);
  release!();
  await harness.adapter.settled();
  expect(harness.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(1);
  harness.dispose();
  await harness.adapter.settled();
});

test("glyph sounds stay silent while host audio is suspended and do not replay missed progress", async () => {
  const harness = textSoundHarness();
  harness.adapter.setSuspended(true);
  for (let i = 0; i < 10; i++) harness.engine.tick(16);
  await harness.adapter.settled();
  expect(harness.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  harness.adapter.setSuspended(false);
  for (let i = 0; i < 4; i++) harness.engine.tick(16);
  await harness.adapter.settled();
  expect(harness.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(0);
  for (let i = 0; i < 4; i++) harness.engine.tick(16);
  await harness.adapter.settled();
  expect(harness.calls.filter(call => call.capability === "media.audio.play").length).toBeGreaterThan(0);
  harness.dispose();
  await harness.adapter.settled();
});

test("a queued glyph cue is canceled when the preference changes before native dispatch", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const harness = textSoundHarness({ gate });
  const location = { label: "opening", index: 0 };
  harness.adapter.apply(update({}, [0, 1, 2, 3].map(sequence => ({
    type: "audioCue" as const,
    sequence,
    cue: "text_mira",
    channel: null,
    action: "play" as const,
    loop: false,
    location,
  }))));
  for (let i = 0; i < 6; i++) await Promise.resolve();
  for (let i = 0; i < 8; i++) harness.engine.tick(16);
  expect(harness.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(4);

  // The first four native requests are held in flight. The next cue shares
  // effect-0's channel queue but has not crossed the host request boundary.
  harness.adapter.setTextSoundsEnabled(false);
  release!();
  await harness.adapter.settled();
  expect(harness.calls.filter(call => call.capability === "media.audio.play")).toHaveLength(4);

  // Skipping the pending cue must preserve the already-live effect-0 channel
  // and all three peers for later grouped-volume updates.
  harness.adapter.setMix({ effects: 0.5 });
  await harness.adapter.settled();
  expect(harness.calls.filter(call => call.capability === "media.audio.volume").map(call => call.params.channel).sort()).toEqual([
    "effect-0", "effect-1", "effect-2", "effect-3",
  ]);
  harness.dispose();
  await harness.adapter.settled();
});
