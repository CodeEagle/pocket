import { strict as assert } from "node:assert";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { NativeSession, readNativeArtifacts, textOf, type Frame, type DrawOp } from "./native_session.ts";
import { resolveNovelSceneObjectGeometry } from "../../../sdk/packages/pocket_vn/src/scene-objects.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";
import type { StoryDefinition } from "../../../sdk/packages/pocket_vn/src/types.ts";

const repo = resolve(import.meta.dir, "../../..");
const directory = resolve(repo, "demo/assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(directory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(directory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(directory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
const story = JSON.parse(readFileSync(resolve(repo, "demo/js/apps/lantern/story.json"), "utf8")) as StoryDefinition;
const scene = story.script.object_inspection_entry!.find(op => op.type === "scene");
assert.equal(scene?.type, "scene");
const objects = scene!.type === "scene" ? scene!.objects! : [];
const compact = (value: string) => value.replace(/[\s\u200b\ufeff]/g, "");
const painted = (frame: Frame, text: string) => compact(textOf(frame)).includes(compact(text));
function visible(frame: Frame, label: string): DrawOp | undefined {
  return frame.ops?.find(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(compact(label))) return false;
    const x = op.x! + op.w! / 2, y = op.y! + op.h! / 2;
    const clip = op.clip ?? { x: 0, y: 0, w: frame.width!, h: frame.height! };
    return x >= Math.max(0, clip.x!) && x <= Math.min(frame.width!, clip.x! + clip.w!) && y >= Math.max(0, clip.y!) && y <= Math.min(frame.height!, clip.y! + clip.h!);
  });
}
async function revealAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let n = 0; n < 12; n++) {
    if (visible(frame, label)) return frame;
    const clipped = frame.ops?.find(op => op.type === "text" && op.clip && op.clip.w! >= 180 && op.clip.h! >= 120)?.clip;
    assert.ok(clipped, `scroll area exists before seeking ${label}`);
    const x = clipped.x! + clipped.w! / 2;
    frame = await session.drag({ x, y: clipped.y! + clipped.h! * 0.8 }, { x, y: clipped.y! + clipped.h! * 0.2 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`action not reachable: ${label}; ${textOf(frame)}`);
}
async function advanceTo(session: NativeSession, initial: Frame, target: string, width: number, height: number): Promise<Frame> {
  let frame = initial;
  const layout = createNovelViewportLayout({ width, height }, { top: 0, right: 0, bottom: 0, left: 0 });
  for (let n = 0; n < 180; n++) {
    if (painted(frame, target)) return frame;
    if (painted(frame, "轻触显全") || painted(frame, "轻触继续")) {
      frame = await session.tapPoint({ x: layout.dialogueLeft + layout.dialogueWidth / 2, y: layout.height - layout.dialogueBottom - layout.dialogueHeight * 0.35 });
    }
    frame = await session.settle(frame, 2);
  }
  throw new Error(`dialogue did not reach ${target}; ${textOf(frame)}`);
}

for (const [width, height] of [[390, 844], [1920, 1080]]) {
  test(`actual Lantern object inspection uses optional picture clicks and keeps the main save (${width}x${height})`, async () => {
    const session = new NativeSession(artifacts, { width, height });
    const evidence: Array<{ name: string; frame: Frame }> = [];
    try {
      let frame = await session.settle(await session.boot(), 24);
      frame = await session.tap("启程 · 开始新的故事", frame);
      for (let n = 0; n < 240 && !session.storage["lantern.slot.auto"]; n++) frame = await session.frame();
      assert.ok(session.storage["lantern.slot.auto"], "a nonempty actual main autosave is parked before replay");
      frame = await session.settle(frame, 70);
      const mesh = (value: Frame) => value.ops?.filter(op => op.type === "textureTriangle" && String((op as any).asset).includes("mira-")) ?? [];
      assert.ok(mesh(frame).length > 10, "the existing real Spine actor remains mounted after stage item ordering changes");
      const initialMesh = JSON.stringify(mesh(frame).map(op => op.points));
      frame = await session.settle(frame, 24);
      assert.notEqual(JSON.stringify(mesh(frame).map(op => op.points)), initialMesh, "existing actor animation continues across canonical ticks");
      frame = await session.tap("手札", frame);
      const pausedMesh = JSON.stringify(mesh(frame).map(op => op.points));
      frame = await session.settle(frame, 24);
      assert.equal(JSON.stringify(mesh(frame).map(op => op.points)), pausedMesh, "the menu still pauses the existing model");
      frame = await revealAction(session, frame, "返回扉页");
      frame = await session.tap("返回扉页", frame);
      const mainBefore = JSON.stringify(session.storage["lantern.slot.auto"]);
      frame = await revealAction(session, frame, "灯下的两件证物");
      frame = await session.tap("灯下的两件证物", frame);
      frame = await advanceTo(session, frame, "它们可以按任意顺序查看", width, height);
      frame = await session.settle(frame, 8);
      evidence.push({ name: "inspection-before-clicks", frame });
      const geometry = (id: string) => {
        const object = objects.find(item => item.id === id)!;
        const box = resolveNovelSceneObjectGeometry(object, width, height)!;
        return { x: box.frame.x + box.hit.x + box.hit.width / 2, y: box.frame.y + box.hit.y + box.hit.height / 2 };
      };
      frame = await session.tapPoint(geometry("tide_letter"));
      frame = await session.tapPoint(geometry("tide_letter"));
      assert.ok(painted(frame, "它们可以按任意顺序查看"), "optional object effects do not advance the active dialogue");
      frame = await advanceTo(session, frame, "已经留下1份检查记录", width, height);
      evidence.push({ name: "exactly-one-record-after-repeat-click", frame });
      frame = await advanceTo(session, frame, "再检查桌上的物件", width, height);
      frame = await session.tap("再检查桌上的物件", frame);
      frame = await advanceTo(session, frame, "它们可以按任意顺序查看", width, height);
      frame = await session.tapPoint(geometry("tide_lamp"));
      frame = await advanceTo(session, frame, "两件证物，一条返航的光路", width, height);
      frame = await session.settle(frame, 60);
      evidence.push({ name: "both-objects-actual-ending", frame });
      assert.ok(!painted(frame, "检查信笺的水痕") && !painted(frame, "查看灯罩里的盐晶"), "the scene clear removed object images and input controls");
      assert.equal(JSON.stringify(session.storage["lantern.slot.auto"]), mainBefore, "inspection effects and replay completion never write the parked main autosave");
      frame = await session.tap("返回原旅程", frame);
      frame = await session.settle(frame, 8);
      assert.equal(JSON.stringify(session.storage["lantern.slot.auto"]), mainBefore);
      evidence.push({ name: "returned-main-save-preserved", frame });
    } finally {
      const out = process.env.POCKET_SCENE_OBJECT_EVIDENCE;
      if (out) { mkdirSync(out, { recursive: true }); writeFileSync(resolve(out, `lantern-${width}x${height}-frames.json`), JSON.stringify(evidence, null, 2)); }
      await session.quit();
    }
  }, 60_000);
}
