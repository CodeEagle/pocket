import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { NativeSession, readNativeArtifacts, textOf, type Frame, type DrawOp } from "./native_session.ts";

const repo = resolve(import.meta.dir, "../../..");
const directory = resolve(repo, "demo/assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
const compact = (text: string) => text.replace(/[\s\u200b\ufeff]/g, "");
const painted = (frame: Frame, label: string) => compact(textOf(frame)).includes(compact(label));
function visible(frame: Frame, label: string): DrawOp | undefined {
  return frame.ops?.find(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(compact(label))) return false;
    const x = op.x! + op.w! / 2, y = op.y! + op.h! / 2;
    const clip = op.clip ?? { x: 0, y: 0, w: frame.width!, h: frame.height! };
    return x >= Math.max(0, clip.x!) && x <= Math.min(frame.width!, clip.x! + clip.w!) && y >= Math.max(0, clip.y!) && y <= Math.min(frame.height!, clip.y! + clip.h!);
  });
}
async function seekAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let n = 0; n < 12; n++) {
    if (visible(frame, label)) return frame;
    const clip = frame.ops?.find(op => op.type === "text" && op.clip && op.clip.w! >= 180 && op.clip.h! >= 120)?.clip;
    assert.ok(clip, `real scroll area exists for ${label}`);
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag({ x, y: clip.y! + clip.h! * 0.8 }, { x, y: clip.y! + clip.h! * 0.2 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`Cannot reach ${label}: ${textOf(frame)}`);
}
async function advanceTo(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let n = 0; n < 100; n++) {
    if (painted(frame, label) && (label !== "RETURN" || painted(frame, "cháo hén"))) return frame;
    const hint = ["轻触续读", "轻触显全", "轻触继续"].map(text => visible(frame, text)).find(Boolean);
    if (hint) frame = await session.tap(hint.text!, frame);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`Cannot reach ${label}: ${textOf(frame)}`);
}

for (const [width, height] of [[390, 844], [1920, 1080]]) {
  test(`real Lantern rich text, paused note and history use the pinned Core (${width}x${height})`, async () => {
    const session = new NativeSession(artifacts, { width, height });
    const evidence: { name: string; frame: Frame }[] = [];
    let completed = false;
    try {
      let frame = await session.settle(await session.boot(), 24);
      frame = await session.tap("启程 · 开始新的故事", frame);
      for (let n = 0; n < 240 && !session.storage["lantern.slot.auto"]; n++) frame = await session.frame();
      assert.ok(session.storage["lantern.slot.auto"], "park the actual main auto-save before the replay");
      frame = await session.tap("手札", frame);
      frame = await seekAction(session, frame, "返回扉页");
      frame = await session.tap("返回扉页", frame);
      const mainBefore = JSON.stringify(session.storage["lantern.slot.auto"]);
      frame = await seekAction(session, frame, "信纸上的第二层海");
      frame = await session.tap("信纸上的第二层海", frame);
      frame = await advanceTo(session, frame, "RETURN");
      frame = await session.settle(frame, 60);
      assert.ok(painted(frame, "轻触续读"), "the fully revealed link remains at its manual local pause");
      assert.ok(!painted(frame, "不是返航指令"), "the suffix was not revealed past the manual marker");
      assert.ok(painted(frame, "cháo hén"), "real ruby fragments are painted above the completed base range");
      const body = visible(frame, "灯下") as (DrawOp & { fontSlot: number; size: number }) | undefined;
      const ruby = visible(frame, "cháo hén") as (DrawOp & { fontSlot: number; size: number }) | undefined;
      const link = visible(frame, "RETURN") as (DrawOp & { fontSlot: number; size: number }) | undefined;
      const base = visible(frame, "潮痕");
      assert.ok(body && ruby && link && base, "actual Core text fragments expose the body, ruby, base and styled link");
      assert.notEqual(link.fontSlot, body.fontSlot, "strong text uses a real distinct bold atlas slot");
      assert.notEqual(link.color, body.color, "semantic accent changes the actual text drawing color");
      assert.ok(ruby.size < body.size && ruby.y! < base.y!, "ruby uses a smaller baked font above its real base");
      evidence.push({ name: "core-rich-link-at-manual-pause", frame });
      frame = await session.tap("RETURN", frame);
      assert.ok(painted(frame, "信笺注记") && painted(frame, "铅笔补写的注记"), "Core-provided link hit rectangles open the JS note");
      frame = await session.settle(frame, 90);
      evidence.push({ name: "note-global-pause", frame });
      frame = await session.tap("返回", frame);
      assert.ok(painted(frame, "RETURN") && !painted(frame, "不是返航指令"), "note open/close did not consume the local marker or advance the line");
      frame = await advanceTo(session, frame, "第一束光发出后");
      frame = await session.tap("回声", frame);
      frame = await session.settle(frame, 4);
      evidence.push({ name: "rich-history-mounted", frame });
      assert.ok(painted(frame, "RETURN"), "the real completed rich line is present in backlog");
      frame = await session.tap("RETURN", frame);
      assert.ok(painted(frame, "铅笔补写的注记"), "a historical link opens its preserved note");
      frame = await session.tap("返回", frame);
      assert.ok(painted(frame, "沿途回声"), "closing a historical note returns to the journal");
      frame = await session.tap("返回", frame);
      frame = await session.tap("遮住灯，等对岸的回答", frame);
      frame = await advanceTo(session, frame, "一封信里，终于容得下两个人的声音");
      evidence.push({ name: "reader-choice-ending", frame });
      assert.equal(JSON.stringify(session.storage["lantern.slot.auto"]), mainBefore, "rich replay and its notes leave the parked main auto-save unchanged");
      completed = true;
    } finally {
      const out = process.env.POCKET_RICH_TEXT_EVIDENCE;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(resolve(out, `lantern-${width}x${height}-frames.json`), JSON.stringify({ width, height, completed, mainSaveUnchanged: completed, evidence }, null, 2));
      }
      await session.quit();
    }
  }, 180_000);
}
