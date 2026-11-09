import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "bun:test";
import { NativeSession, readNativeArtifacts, textOf, type Frame } from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
for (const [key, file] of [["BYTECODE", "app.qjbc"], ["PAK", "app.pak"], ["METADATA", "app.bytecode.json"]]) {
  process.env[`POCKET_LANTERN_GUEST_${key}`] ??= resolve(directory, file!);
}
const artifacts = readNativeArtifacts("POCKET_LANTERN");
const voiceChannel = "__pocket_vn_voice";
const saveKey = "lantern.slot.auto";
const normalizeVisibleText = (value: string): string => value.replace(/\s+/g, " ").trim();

test("QJBC voice completion gates auto and language changes retain the current interaction", async () => {
  const audioCapabilities = ["media.audio.play", "media.audio.pause", "media.audio.resume", "media.audio.stop", "media.audio.volume"];
  const session = new NativeSession(artifacts, { width: 360, height: 640, deferCapabilities: audioCapabilities, deadlineMs: 180_000 });
  let accepted = 0;
  const acceptPlays = () => {
    for (const request of session.requests.slice(accepted)) {
      if (audioCapabilities.includes(request.capability)) session.respondPending(request.capability, { accepted: true });
    }
    accepted = session.requests.length;
  };
  const frames = async (count = 6): Promise<Frame> => {
    let frame!: Frame;
    for (let index = 0; index < count; index++) { acceptPlays(); frame = await session.frame(); }
    acceptPlays(); return frame;
  };
  const pulse = async (buttons: number) => {
    session.sendEvent("input.buttons", { buttons }); await frames(1);
    session.sendEvent("input.buttons", { buttons: 0 }); return frames();
  };
  const tap = async (label: string, frame: Frame) => { await session.tap(label, frame); return frames(); };
  const active = () => session.storage[saveKey]?.state?.active;
  const voicePlays = () => session.requests.filter(request => request.capability === "media.audio.play" && request.params.channel === voiceChannel);
  const playback = (token: string, status: string) => session.sendEvent("media.audio.playback", { channel: voiceChannel, playbackId: token, status, positionMs: status === "completed" ? 13600 : 0, durationMs: 13600 });
  const arrivalThree = "That lamp should not be lit. The old relay sends light across the strait, not twenty years ahead. My sister went missing across the water twenty years ago. I sealed the signal box afterward, and for years I called that night a simple malfunction.";
  const revealArrivalThree = async (target: NativeSession, initial: Frame): Promise<Frame> => {
    let frame = initial;
    const expected = arrivalThree.replace(/\s+/g, " ");
    for (let index = 0; index < 12; index++) {
      const painted = textOf(frame).replace(/\s+/g, " ");
      if (painted.includes(expected) && painted.includes("Tap to continue")) return frame;
      if (painted.includes("Tap to reveal all")) {
        frame = await target.tap("Tap to reveal all", frame);
        frame = await target.settle(frame, 2);
      } else {
        frame = await target.frame();
      }
    }
    throw new Error(`arrival_03 did not finish its English reveal; active=${JSON.stringify(target.storage[saveKey]?.state?.active)}; text=${textOf(frame)}`);
  };
  try {
    let frame = await session.boot();
    frame = await pulse(0x2000);
    for (let index = 0; index < 300 && active()?.id !== "arrival_01"; index++) frame = await frames(1);
    assert.equal(active()?.id, "arrival_01");
    frame = await pulse(0x2000); frame = await pulse(0x2000);
    for (let index = 0; index < 300 && active()?.id !== "arrival_02"; index++) frame = await frames(1);
    assert.equal(active()?.id, "arrival_02");
    assert.equal(voicePlays().length, 1);
    const first = voicePlays()[0]!.params;
    assert.equal(first.asset, "audio/voice_mira_arrival_02.wav");
    playback(String(first.playbackId), "playing");
    frame = await frames();
    frame = await tap("自动", frame);
    frame = await frames(800);
    assert.equal(active()?.id, "arrival_02", "elapsed text/auto delay cannot replace actual voice completion");

    frame = await pulse(0x4000);
    frame = await tap("阅读偏好", frame);
    frame = await tap("游戏语言 · 中文", frame);
    assert.equal(session.storage["lantern.locale"], "en");
    assert.match(normalizeVisibleText(textOf(frame)), /Reading preferences/);
    assert.equal(active()?.id, "arrival_02", "language switch must preserve line identity");
    assert.match(active()?.text, /我送一封信/, "persisted display text stays canonical across locales");
    assert.equal(voicePlays().length, 2);
    const translated = voicePlays()[1]!.params;
    assert.equal(translated.asset, "audio/voice_mira_arrival_02_en.wav");
    assert.notEqual(translated.playbackId, first.playbackId);
    assert.equal(session.requests.filter(request => request.capability === "media.audio.play" && request.params.channel === "music").length, 1, "language switch must retain unchanged music");

    frame = await pulse(0x4000);
    frame = await pulse(0x4000);
    playback(String(first.playbackId), "completed");
    frame = await frames(30);
    assert.equal(active()?.id, "arrival_02", "old language completion must not advance the replacement voice");
    frame = await tap("Replay voice", frame);
    assert.equal(active()?.id, "arrival_02", "replay input must not bubble into dialogue advance");
    assert.equal(voicePlays().length, 3, "replay must issue a fresh tokenized native play");
    const replay = voicePlays()[2]!.params;
    assert.notEqual(replay.playbackId, translated.playbackId);
    playback(String(translated.playbackId), "completed");
    frame = await frames(10);
    assert.equal(active()?.id, "arrival_02");
    playback(String(replay.playbackId), "completed");
    frame = await frames(30);
    assert.equal(active()?.id, "arrival_03", "current voice completion must wake and advance auto");
    frame = await pulse(0x2000);
    const persisted = JSON.parse(JSON.stringify(session.storage));
    frame = await revealArrivalThree(session, frame);
    assert.equal(active()?.id, "arrival_03", "revealing the resumed line must not advance dialogue");
    assert.match(textOf(frame).replace(/\s+/g, " "), /old relay sends light across the strait/);
    await session.quit();
    const resumed = new NativeSession(artifacts, { width: 360, height: 640, storage: persisted });
    try {
      let restored = await resumed.boot();
      assert.match(textOf(restored), /Continue · Resume your journey/, "a fresh guest must restore the language preference on its title page");
      restored = await resumed.tap("Continue · Resume your journey", restored);
      restored = await resumed.settle(restored, 40);
      restored = await revealArrivalThree(resumed, restored);
      assert.match(textOf(restored).replace(/\s+/g, " "), /old relay sends light across the strait/, "Continue must rebase the canonical save into English and restore its exact line");
      assert.match(textOf(restored), /Tap to continue/, "the restored line must reach its real fully revealed prompt");
      assert.equal(resumed.storage[saveKey].state.active.id, "arrival_03");
    } finally { await resumed.quit(); }
  } finally { session.forceKill(); }
}, 180_000);
