import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  NativeSession,
  readNativeArtifacts,
  textOf,
  type Frame,
} from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE = resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK = resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA = resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before text-sound acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before text-sound acceptance");

function plays(session: NativeSession) {
  return session.requests.filter(request =>
    request.capability === "media.audio.play" &&
    typeof request.params.channel === "string" &&
    String(request.params.channel).startsWith("effect-"));
}

test("native Lantern settings persist the off-by-default toggle and use the real story cue", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 60_000 });
  try {
    let frame: Frame = await session.boot();
    frame = await session.tap("阅读偏好", frame);
    frame = await session.settle(frame, 3);
    const settings = textOf(frame);
    for (const label of [
      "文字速度",
      "自动间隔",
      "总音量",
      "音乐",
      "音效",
      "语音",
      "文字提示音 · 关闭",
      "游戏语言",
    ]) {
      assert.ok(settings.includes(label), `360×640 settings must expose ${label}\n${settings}`);
    }

    frame = await session.tap("文字提示音 · 关闭", frame);
    frame = await session.settle(frame, 3);
    assert.match(textOf(frame), /文字提示音 · 开启/);
    assert.equal(session.storage["lantern.audio.textSoundsEnabled"], true);

    frame = await session.tap("返回", frame);
    frame = await session.tap("启程 · 开始新的故事", frame);
    for (let index = 0; index < 100 && plays(session).length === 0; index++) frame = await session.frame();
    const glyphs = plays(session);
    assert.ok(glyphs.length > 0, `real JS story reveal must request text audio\n${textOf(frame)}`);
    assert.equal(glyphs[0]?.params.asset, "audio/text_narrator.wav");
    assert.ok(
      new Set(glyphs.map(request => request.params.channel)).size <= 4,
      "dialogue blips must reuse the four bounded effects channels",
    );
    assert.equal(session.storage["lantern.slot.auto"]?.state?.active?.id, "arrival_01");
  } finally {
    await session.quit();
  }
}, 90_000);
