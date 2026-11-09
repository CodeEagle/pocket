import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { resolveNovelCameraPose } from "../../../sdk/packages/pocket_vn/src/camera.ts";
import { resolveNovelBackgroundLayerPose } from "../../../sdk/packages/pocket_vn/src/background-layers.ts";
import { localizeStory, type StoryLocaleCatalogCollection } from "../../../sdk/packages/pocket_vn/src/localization.ts";
import { NativeSession, readNativeArtifacts, textOf, type Frame, type DrawOp } from "./native_session.ts";

const app = resolve(import.meta.dir, "../apps/lantern");
const built = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(built, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(built, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(built, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
const sourceStory = JSON.parse(readFileSync(resolve(app, "story.json"), "utf8"));
const assets = JSON.parse(readFileSync(resolve(app, "novel.assets.json"), "utf8"));
const localeDocument = JSON.parse(readFileSync(resolve(app, "novel.locales.json"), "utf8"));
const story = localizeStory(sourceStory, localeDocument.catalogs as StoryLocaleCatalogCollection, "zh", { assetRegistry: assets }).story;
const seed = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/lantern-v3-native-save.json"), "utf8"));
const menu = Object.values(story.script).flat().find((item: any) => item.type === "choice" && item.id === "parallax_showcase_menu") as any;
const replay = story.replayEntries.find((entry: any) => entry.id === "parallax_showcase");
const initialScene = story.script[replay?.location.label]?.find((item: any) => item.type === "scene" && item.backgroundLayers?.length >= 2);
const compact = (text: string) => text.replace(/\s/g, "");
const assetOf = (op: DrawOp) => (op as DrawOp & { asset?: string }).asset;
const opsFor = (frame: Frame, path: string) => (frame.ops ?? []).filter(op => assetOf(op) === path);
// Geometry and source UVs only: fading alpha cannot masquerade as camera motion.
const geometry = (frame: Frame, path: string) => JSON.stringify(opsFor(frame, path).map(op => ({
  type: op.type, x: op.x, y: op.y, w: op.w, h: op.h, points: op.points,
  uv: (op as DrawOp & { uv?: number[] }).uv, uvs: op.uvs, clip: op.clip,
  transform: (op as DrawOp & { transform?: number[] }).transform,
  matrix: (op as DrawOp & { matrix?: number[] }).matrix,
})));
type ImageBounds = { x: number; y: number; width: number; height: number };
function uncroppedImageBounds(frame: Frame, path: string): ImageBounds {
  const images = opsFor(frame, path).filter(op => op.type === "image");
  assert.equal(images.length, 1, `each parallax plane is one native image op: ${path}`);
  const op = images[0]!;
  const uv = (op as DrawOp & { uv?: number[] }).uv;
  assert.ok(uv && uv.length === 4 && uv[2]! > uv[0]! && uv[3]! > uv[1]!, `native image op exposes a valid source crop: ${path}`);
  assert.ok([op.x, op.y, op.w, op.h].every(value => typeof value === "number"), `native image op exposes its viewport rect: ${path}`);
  // Image ops report a fixed clipped viewport rect. Reverse its UV crop to
  // recover the full source-image bounds before comparing transformed planes.
  const width = op.w! / (uv![2]! - uv![0]!);
  const height = op.h! / (uv![3]! - uv![1]!);
  return { x: op.x! - uv![0]! * width, y: op.y! - uv![1]! * height, width, height };
}
function assertParallaxPose(frame: Frame, baseline: ReadonlyMap<string, ImageBounds>, targetLabel: string): void {
  const scene = story.script[targetLabel]?.find((item: any) => item.type === "scene" && item.camera) as any;
  assert.ok(scene?.camera, `${targetLabel} authors an explicit target camera pose`);
  const camera = resolveNovelCameraPose(scene.camera);
  const centerX = (frame.width ?? 390) / 2;
  const centerY = (frame.height ?? 844) / 2;
  const layers = new Map<string, number>(initialScene.backgroundLayers.map((layer: any) => [assets.backgrounds[layer.background], layer.parallax]));
  const base = assets.backgrounds[initialScene.background];
  for (const [path, before] of baseline) {
    const factor = path === base ? 1 : layers.get(path);
    assert.equal(typeof factor, "number", `plane has an authored parallax factor: ${path}`);
    const pose = path === base ? camera : resolveNovelBackgroundLayerPose(scene.camera, factor!);
    const expectedWidth = before.width * pose.scale;
    const expectedHeight = before.height * pose.scale;
    const beforeCenterX = before.x + before.width / 2;
    const beforeCenterY = before.y + before.height / 2;
    const expectedCenterX = centerX + pose.x + pose.scale * (beforeCenterX - centerX);
    const expectedCenterY = centerY + pose.y + pose.scale * (beforeCenterY - centerY);
    const expected = {
      x: expectedCenterX - expectedWidth / 2,
      y: expectedCenterY - expectedHeight / 2,
      width: expectedWidth,
      height: expectedHeight,
    };
    const actual = uncroppedImageBounds(frame, path);
    for (const key of ["x", "y", "width", "height"] as const) {
      assert.ok(Math.abs(actual[key] - expected[key]) <= 1,
        `${path} matches ${targetLabel} camera at parallax ${factor}: ${key} expected=${expected[key]} actual=${actual[key]} fullBounds=${JSON.stringify(actual)}`);
    }
  }
}
function visible(frame: Frame, label: string): boolean {
  return (frame.ops ?? []).some(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(compact(label))) return false;
    if ([op.x, op.y, op.w, op.h].some(value => typeof value !== "number")) return false;
    const clip = op.clip;
    const left = Math.max(op.x!, clip?.x ?? 0, 0);
    const top = Math.max(op.y!, clip?.y ?? 0, 0);
    const right = Math.min(op.x! + op.w!, (clip?.x ?? 0) + (clip?.w ?? frame.width ?? Number.POSITIVE_INFINITY), frame.width ?? Number.POSITIVE_INFINITY);
    const bottom = Math.min(op.y! + op.h!, (clip?.y ?? 0) + (clip?.h ?? frame.height ?? Number.POSITIVE_INFINITY), frame.height ?? Number.POSITIVE_INFINITY);
    const centerX = op.x! + op.w! / 2;
    const centerY = op.y! + op.h! / 2;
    return right > left && bottom > top && centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
  });
}
async function reveal(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let i = 0; i < 16; i++) {
    if (visible(frame, label)) return frame;
    const clip = (frame.ops ?? []).find(op => op.type === "text" && op.clip && (op.clip.h ?? 0) > 120)?.clip;
    assert.ok(clip, `gallery scroll viewport is painted: ${textOf(frame)}`);
    const x = clip.x! + clip.w! / 2;
    frame = await session.drag({ x, y: clip.y! + clip.h! * 0.82 }, { x, y: clip.y! + clip.h! * 0.22 }, 8, 3);
    frame = await session.settle(frame, 3);
  }
  throw new Error(`replay action is not reachable: ${label}; ${textOf(frame)}`);
}
async function atMenu(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  let stable = 0;
  let previous = "";
  const scenePaths = [assets.backgrounds[initialScene.background], ...initialScene.backgroundLayers.map((layer: any) => assets.backgrounds[layer.background])];
  for (let i = 0; i < 600; i++) {
    if (menu.options.every((option: any) => compact(textOf(frame)).includes(compact(option.text)))) {
      // Settle on the rendered stage geometry/UVs only. Full-screen rect color
      // also captures fades and is not evidence of camera motion completion.
      const signature = JSON.stringify(scenePaths.map((path: string) => geometry(frame, path)));
      stable = signature === previous ? stable + 1 : 0;
      previous = signature;
      if (stable >= 8) return frame;
      frame = await session.frame();
    } else {
      stable = 0;
      previous = "";
      frame = await session.tapPoint({ x: session.width / 2, y: session.height * 0.86 });
    }
  }
  throw new Error(`parallax menu not reached: ${textOf(frame)}`);
}

test("native parallax replay moves actual image planes, clears and restores them without changing main progress", async () => {
  assert.ok(replay && menu && initialScene, "the built story supplies the independent parallax replay");
  const paths = initialScene.backgroundLayers.map((layer: any) => assets.backgrounds[layer.background]);
  assert.ok(paths.length >= 2 && paths.every(Boolean));
  const base = assets.backgrounds[initialScene.background];
  const session = new NativeSession(artifacts, { width: 390, height: 844, storage: structuredClone(seed.storage), deadlineMs: 120_000 });
  const main = JSON.stringify(session.storage["lantern.slot.auto"]);
  const autoWrites = () => session.storageSets.filter(params => params.key === "lantern.slot.auto").length;
  try {
    let frame = await session.boot();
    const writes = autoWrites();
    const storageMutationCount = () => session.requests.filter(request =>
      request.capability === "platform.storage.set" ||
      request.capability === "platform.storage.remove" ||
      request.capability === "platform.storage.batch").length;
    const mutations = storageMutationCount();
    frame = await session.tap("雾港纪念", frame);
    frame = await reveal(session, frame, `回看 · ${replay.title}`);
    frame = await session.tap(`回看 · ${replay.title}`, frame);
    frame = await atMenu(session, frame);
    for (const path of [base, ...paths]) assert.ok(opsFor(frame, path).length, `actual Guest paints ${path}`);
    const before = new Map([base, ...paths].map(path => [path, geometry(frame, path)]));
    const baseline = new Map([base, ...paths].map(path => [path, uncroppedImageBounds(frame, path)]));
    const select = async (id: string) => {
      const option = menu.options.find((item: any) => item.id === id);
      assert.ok(option, `real replay option ${id} exists`);
      frame = await session.tap(option.text, frame);
      frame = await atMenu(session, frame);
      assert.equal(JSON.stringify(session.storage["lantern.slot.auto"]), main);
      assert.equal(autoWrites(), writes);
      assert.equal(storageMutationCount(), mutations, "the replay issues no mutation to any native storage key");
    };
    await select("parallax_pan");
    assertParallaxPose(frame, baseline, "parallax_showcase_pan");
    for (const path of [base, ...paths.filter((_path: string, index: number) => initialScene.backgroundLayers[index].parallax > 0)]) assert.notEqual(geometry(frame, path), before.get(path), `pointer-selected pan changes geometry/UVs of ${path}`);
    const panned = geometry(frame, base);
    await select("parallax_zoom");
    assertParallaxPose(frame, baseline, "parallax_showcase_zoom");
    assert.notEqual(geometry(frame, base), panned, "pointer-selected zoom changes the base image geometry/UVs");
    await select("parallax_clear");
    assert.ok(opsFor(frame, base).length, "clearing overlays retains the base image");
    for (const path of paths) assert.equal(opsFor(frame, path).length, 0, `cleared plane is removed: ${path}`);
    await select("parallax_restore");
    for (const path of paths) assert.ok(opsFor(frame, path).length, `restore repaints ${path}`);
    const exit = menu.options.find((item: any) => item.id === "parallax_exit");
    frame = await session.tap(exit.text, frame);
    const ending = story.script[exit.target]?.find((item: any) => item.type === "ending");
    assert.ok(ending?.text, "the replay exit has its own authored ending");
    for (let attempt = 0; attempt < 300 && !compact(textOf(frame)).includes(compact(ending.text)); attempt++) {
      frame = await session.tapPoint({ x: session.width / 2, y: session.height * 0.86 });
    }
    assert.ok(compact(textOf(frame)).includes(compact(ending.text)), "the actual exit input reaches the replay ending");
    frame = await session.tap("返回原旅程", frame);
    for (let attempt = 0; attempt < 120 && !compact(textOf(frame)).includes(compact("已收集")); attempt++) frame = await session.frame();
    assert.ok(compact(textOf(frame)).includes(compact("已收集")), "replay exit restores the gallery panel that launched this replay");
    assert.equal(JSON.stringify(session.storage["lantern.slot.auto"]), main);
    assert.equal(autoWrites(), writes);
    assert.equal(storageMutationCount(), mutations);
    console.log("NATIVE_PARALLAX_REPLAY", JSON.stringify({ viewport: [390, 844], planes: paths, mainSaveBytes: Buffer.byteLength(main), mainWritesDuringReplay: autoWrites() - writes }));
  } finally { await session.quit(); }
}, 150_000);
