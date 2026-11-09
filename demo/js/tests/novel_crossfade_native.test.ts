import { visibleTextOp, waitForText, revealVisibleAction, tapVisibleAction, tapUntilText } from "./novel_interaction.ts";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  diagnoseStoryLocale,
  localizeStory,
  type StoryLocaleCatalogCollection,
} from "../../../sdk/packages/pocket_vn/src/localization.ts";
import type { StoryDefinition } from "../../../sdk/packages/pocket_vn/src/types.ts";
import {
  NativeSession,
  readNativeArtifacts,
  textOf,
  type Frame,
} from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const appDirectory = resolve(import.meta.dir, "../apps/lantern");
const guestDirectory = resolve(repositoryRoot, "demo/assets/apps/lantern");
const story = JSON.parse(readFileSync(resolve(appDirectory, "story.json"), "utf8")) as StoryDefinition;
const localeDocument = JSON.parse(readFileSync(resolve(appDirectory, "novel.locales.json"), "utf8")) as {
  catalogs: StoryLocaleCatalogCollection;
};
const assets = JSON.parse(readFileSync(resolve(appDirectory, "novel.assets.json"), "utf8")) as {
  audio: Record<string, string>;
};
const compact = (value: string): string => value.replace(/[\s\u200b\ufeff]/g, "");

function instructionById(id: string): Record<string, any> | undefined {
  return Object.values(story.script).flat().find(instruction => instruction.type === "say" && instruction.id === id) as Record<string, any> | undefined;
}

test("Lantern's discoverable score handoff keeps the original ensemble and has complete Chinese and English story IDs", () => {
  const entries = story.replayEntries ?? [];
  const entry = entries.find(candidate => candidate.id === "score_handoff_showcase");
  assert.deepEqual(entry, {
    id: "score_handoff_showcase",
    title: "风暴交给晨光",
    location: { label: "score_handoff_showcase", index: 0 },
  }, "the new title is always unlocked through the existing story replay catalog");
  assert.ok(story.script.score_handoff_showcase?.[0]?.type === "scene");
  assert.ok(story.script.score_handoff_showcase?.some(instruction => instruction.type === "ending" && instruction.id === "score_handoff_complete"));

  const timeline = (story.timelines as Record<string, any>).score_handoff;
  assert.equal(timeline.durationMs, 14000);
  assert.deepEqual(timeline.audio.filter((cue: any) => cue.channel), [
    { atMs: 0, cue: "music_storm", channel: "score-storm", loop: true, group: "music" },
    { atMs: 4800, cue: "music_dawn", channel: "score-dawn", loop: true, group: "music" },
    { atMs: 10400, cue: "music_storm", action: "stop", channel: "score-storm" },
    { atMs: 14000, cue: "music_dawn", action: "stop", channel: "score-dawn" },
  ], "only named play cues declare the music group; each loop has one authored stop");
  assert.deepEqual(timeline.audioGains.map((track: any) => [
    track.channel,
    track.keyframes.map((keyframe: any) => [keyframe.atMs, keyframe.value]),
  ]), [
    ["score-storm", [[0, 1], [4800, 1], [10400, 0]]],
    ["score-dawn", [[0, 0], [4800, 0], [10400, 1], [12200, 1], [14000, 0]]],
  ]);

  const oldEnsemble = entries.find(candidate => candidate.id === "timeline_showcase");
  assert.ok(oldEnsemble, "the existing six-second Lighthouse Ensemble replay remains registered");
  const crescendo = (story.timelines as Record<string, any>).harbor_crescendo;
  assert.equal(crescendo.durationMs, 6000);
  assert.deepEqual(crescendo.audioGains[0].keyframes.map((keyframe: any) => keyframe.value), [0, 0.85, 0.4, 0]);

  for (const cue of ["music_storm", "music_dawn"]) {
    const path = assets.audio[cue];
    assert.ok(path?.endsWith(".wav"), `${cue} resolves to its registered WAV`);
    assert.ok(statSync(resolve(appDirectory, "assets", path)).size > 44, `${cue} is a real non-empty WAV asset`);
  }

  for (const locale of ["zh", "en"] as const) {
    const catalog = localeDocument.catalogs[locale]!;
    const localized = localizeStory(story, localeDocument.catalogs, locale).story;
    const replay = localized.replayEntries?.find(candidate => candidate.id === "score_handoff_showcase");
    assert.equal(replay?.title, catalog.replays?.score_handoff_showcase);
    for (const id of ["score_handoff_01", "score_handoff_02", "score_handoff_03"]) {
      const localizedLine = instructionById(id);
      assert.ok(localizedLine, `source has stable line ${id}`);
      assert.ok(catalog.lines?.[id], `${locale} catalog supplies ${id}`);
      const translated = Object.values(localized.script).flat().find(instruction => instruction.type === "say" && instruction.id === id) as Record<string, any> | undefined;
      assert.equal(translated?.text, catalog.lines?.[id]);
    }
    const ending = catalog.endings?.score_handoff_complete;
    assert.ok(ending, `${locale} catalog supplies the replay ending`);
    assert.equal(localized.script.score_handoff_showcase?.find(instruction => instruction.type === "ending")?.text, ending);
    const issues = diagnoseStoryLocale(story, catalog, { assetRegistry: JSON.parse(readFileSync(resolve(appDirectory, "novel.assets.json"), "utf8")) });
    assert.equal(issues.some(issue => issue.path.startsWith("lines.score_handoff_") || issue.path === "endings.score_handoff_complete" || issue.path === "replays.score_handoff_showcase"), false);
  }
});

function activeMainSave(session: NativeSession): unknown {
  return session.storage["lantern.slot.auto"];
}

function audioRequests(session: NativeSession, capability: string, channel: string) {
  return session.requests.filter(request => request.capability === capability && request.params.channel === channel);
}

function audioVolumes(session: NativeSession, channel: string): number[] {
  return audioRequests(session, "media.audio.volume", channel)
    .map(request => request.params.volume)
    .filter((value): value is number => typeof value === "number");
}

test("real Lantern QJBC input reaches the new gallery score handoff, crossfades both music channels, and restores the parked journey", { timeout: 240_000 }, async () => {
  process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(guestDirectory, "app.qjbc");
  process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(guestDirectory, "app.pak");
  process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(guestDirectory, "app.bytecode.json");
  const artifacts = readNativeArtifacts("POCKET_LANTERN");
  assert.ok(existsSync(artifacts.bytecodePath), "selected real Lantern QJBC exists");
  assert.ok(existsSync(artifacts.pakPath), "selected real Lantern PAK exists");

  const mix = { master: 0.7, music: 0.75, effects: 0.25, voice: 1 };
  const session = new NativeSession(artifacts, {
    width: 360,
    height: 640,
    storage: { "lantern.audio.mix": mix },
    deadlineMs: 180_000,
  });
  try {
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await waitForText(session, frame, "23点08分");
    for (let attempt = 0; attempt < 120 && (!activeMainSave(session) || audioRequests(session, "media.audio.play", "music").length === 0); attempt += 1) {
      frame = await session.frame();
    }
    assert.ok(activeMainSave(session), "the actual Lantern main route establishes a durable save before the replay");
    assert.equal(audioRequests(session, "media.audio.play", "music")[0]?.params.asset, "audio/music_storm.wav");
    const mainPlayCount = audioRequests(session, "media.audio.play", "music").length;

    frame = await session.tap("手札", frame);
    frame = await session.settle(frame, 3);
    frame = await tapVisibleAction(session, frame, "雾港纪念");
    frame = await revealVisibleAction(session, frame, "回看 · 风暴交给晨光");
    assert.ok(visibleTextOp(frame, "回看 · 风暴交给晨光"), "new replay is reachable through the real title/gallery UI");
    const requestsAtReplayStart = session.requests.length;
    frame = await tapVisibleAction(session, frame, "回看 · 风暴交给晨光");
    frame = await waitForText(session, frame, "雾退到海峡另一边");
    const parkedSave = JSON.parse(JSON.stringify(activeMainSave(session)));
    const autoWritesBeforeReplay = session.storageSets.filter(params => params.key === "lantern.slot.auto").length;
    const requestBoundary = session.requests.length;

    frame = await tapUntilText(session, frame, "我总写");
    let attempts = 0;
    while (audioRequests(session, "media.audio.play", "replay-score-storm").length === 0 && attempts < 8) {
      frame = await session.tapPoint({ x: 180, y: 470 });
      frame = await session.settle(frame, 1);
      attempts += 1;
    }
    const stormPlay = audioRequests(session, "media.audio.play", "replay-score-storm")[0];
    assert.ok(stormPlay, "native Guest executes the first timeline score cue on its replay-owned named channel");
    assert.equal(stormPlay?.params.asset, "audio/music_storm.wav");
    assert.equal(stormPlay?.params.loop, true);
    assert.ok(Math.abs(Number(stormPlay?.params.volume) - 0.525) < 0.02, "explicit music routing uses master × music (.7 × .75), not effects (.7 × .25)");

    const trace: Array<{ frame: number; storm: number | null; dawn: number | null; effects: number | null }> = [];
    const overlapFrames: Array<{ frame: number; storm: number; dawn: number }> = [];
    let closeFrame = -1;
    for (let tick = 0; tick < 940; tick += 1) {
      frame = await session.frame();
      if (tick % 30 === 0) {
        const storm = audioVolumes(session, "replay-score-storm").at(-1) ?? Number(stormPlay!.params.volume);
        const dawnPlay = audioRequests(session, "media.audio.play", "replay-score-dawn")[0];
        const dawn = dawnPlay
          ? audioVolumes(session, "replay-score-dawn").at(-1) ?? Number(dawnPlay.params.volume)
          : null;
        const effectPlay = session.requests.find(request => request.capability === "media.audio.play" && request.params.asset === "audio/station_bell.wav");
        const effects = effectPlay ? Number(effectPlay.params.volume) : null;
        trace.push({ frame: tick, storm, dawn, effects });
        if (dawn !== null && storm > 0.1 && dawn > 0.1) overlapFrames.push({ frame: tick, storm, dawn });
      }
      if (compact(textOf(frame)).includes(compact("最后一笔落下"))) {
        closeFrame = tick;
        break;
      }
    }
    frame = await waitForText(session, frame, "最后一笔落下", 20);
    assert.ok(closeFrame >= 0, "the shared 14-second timeline reaches its authored closing line");
    const dawnPlay = audioRequests(session, "media.audio.play", "replay-score-dawn")[0];
    assert.ok(dawnPlay, "the second real score starts on its own replay channel");
    assert.equal(dawnPlay?.params.asset, "audio/music_dawn.wav");
    assert.equal(dawnPlay?.params.loop, true);
    assert.ok(Math.abs(Number(dawnPlay?.params.volume)) < 0.02, "the dawn score joins at its authored zero gain");
    const stormLevels = [Number(stormPlay?.params.volume), ...audioVolumes(session, "replay-score-storm")];
    const dawnLevels = [Number(dawnPlay?.params.volume), ...audioVolumes(session, "replay-score-dawn")];
    assert.ok(stormLevels.some(value => value < 0.04), "the old score fades from full music gain toward zero");
    assert.ok(Math.max(...dawnLevels) > 0.48, "the new score rises through the same timeline toward full music gain");
    assert.ok(dawnLevels.at(-1)! < 0.04, "the dawn tail fades before its authored stop");
    assert.ok(overlapFrames.length > 0, "the trace observes both named music players above zero at the same time");
    const bell = session.requests.find(request => request.capability === "media.audio.play" && request.params.asset === "audio/station_bell.wav");
    assert.ok(bell, "the score handoff keeps its separate bell effects cue");
    assert.ok(Math.abs(Number(bell?.params.volume) - 0.175) < 0.02, "the bell uses master × effects (.7 × .25) while both scores use music");
    assert.ok(audioRequests(session, "media.audio.stop", "replay-score-storm").length > 0, "the storm native channel is released at the fade boundary");
    assert.ok(audioRequests(session, "media.audio.stop", "replay-score-dawn").length > 0, "the dawn native channel is released at the timeline endpoint");
    assert.equal(JSON.stringify(activeMainSave(session)), JSON.stringify(parkedSave), "playing the isolated replay never overwrites the parked main save");
    assert.equal(session.storageSets.filter(params => params.key === "lantern.slot.auto").length, autoWritesBeforeReplay, "replay dialogue and timeline issue no main auto-save write");

    frame = await tapUntilText(session, frame, "有些告别很轻");
    const requestsAfterReplayStart = session.requests.slice(requestsAtReplayStart);
    assert.ok(requestsAfterReplayStart.some(request => request.capability === "media.audio.pause" && request.params.channel === "music"), "starting a gallery replay pauses the existing main BGM player");
    frame = await session.tap("返回原旅程", frame);
    frame = await session.settle(frame, 8);
    assert.ok(textOf(frame).includes("雾港纪念"), "exit returns to the actual gallery panel");
    assert.ok(session.requests.slice(requestsAtReplayStart).some(request => request.capability === "media.audio.resume" && request.params.channel === "music"), "leaving replay resumes the main music channel");
    assert.equal(audioRequests(session, "media.audio.play", "music").length, mainPlayCount, "resume preserves the original main player instead of restarting its BGM");
    assert.equal(JSON.stringify(activeMainSave(session)), JSON.stringify(parkedSave));
    assert.equal(session.storageSets.filter(params => params.key === "lantern.slot.auto").length, autoWritesBeforeReplay);
    console.log("NATIVE_SCORE_HANDOFF", JSON.stringify({
      qjbc: artifacts.bytecodePath,
      mainMusicPlays: mainPlayCount,
      groupMix: mix,
      replayChannels: ["replay-score-storm", "replay-score-dawn"],
      trace,
      overlapFrames,
      replayRequestCount: session.requests.length - requestBoundary,
    }));
  } finally {
    await session.quit();
  }
}, 270_000);
