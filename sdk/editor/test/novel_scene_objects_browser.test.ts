import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { NativeSession, center, textOf, type DrawOp, type Frame, type NativeArtifacts } from "../../../demo/js/tests/native_session.ts";
import { resolveNovelCameraPose } from "../../packages/pocket_vn/src/camera.ts";
import { resolveNovelSceneObjectGeometry, orderedNovelStageItems } from "../../packages/pocket_vn/src/scene-objects.ts";

const repository = resolve(import.meta.dir, "../../..");
const projectSource = join(repository, "demo/js/apps/lantern");
const qaDirectory = process.env.POCKET_SCENE_OBJECT_QA;
const objectAssetPaths = {
  crop: "art/fx/sea-mist.png",
  behind: "art/ren-neutral.png",
  front: "art/mira-neutral.png",
};

type SceneObject = {
  id: string;
  image: string;
  frame: { x: number; y: number; w: number; h: number };
  aspectRatio?: number;
  crop?: { x: number; y: number; w: number; h: number };
  layer?: number;
  interaction?: {
    label: string;
    effects: Array<{ type: "set"; variable: string; value: unknown } | { type: "inc"; variable: string; amount: number }>;
    when?: { op: "falsy"; value: { type: "variable"; name: string } };
    hit?: { x: number; y: number; w: number; h: number };
  };
};

const initialStory = {
  id: "scene-objects-acceptance",
  version: 1,
  start: "start",
  variableDefinitions: {
    cropHits: { lifetime: "save", defaultValue: 0 },
    behindHits: { lifetime: "save", defaultValue: 0 },
    frontHits: { lifetime: "save", defaultValue: 0 },
    frontLatched: { lifetime: "save", defaultValue: false },
  },
  script: {
    start: [
      {
        type: "scene",
        background: "station",
        camera: { x: 18, y: -8, scale: 1.22 },
        cameraMotion: { durationMs: 1200, easing: "easeInOut" },
        objects: [],
        authorSceneNote: { keep: ["source", "metadata"] },
      },
      { type: "say", id: "object-lab", text: "Inspect the independent scene objects." },
      { type: "scene", camera: { x: -12, y: 6, scale: 1.1 } },
      { type: "say", id: "inherited-objects", text: "The omitted object list inherits the existing stage." },
      { type: "scene", objects: [] },
      { type: "say", id: "cleared-objects", text: "The explicit empty list clears the stage objects." },
      { type: "ending", id: "scene-objects-finished", text: "The object acceptance route is complete." },
    ],
  },
};

const authoredObjects: SceneObject[] = [
  {
    id: "crop-window",
    image: "cropSource",
    frame: { x: 0.08, y: 0.24, w: 0.22, h: 0.2 },
    aspectRatio: 1,
    crop: { x: 0.52, y: 0.12, w: 0.4, h: 0.7 },
    layer: 2,
    interaction: {
      label: "Inspect cropped window",
      effects: [{ type: "inc", variable: "cropHits", amount: 1 }],
    },
  },
  {
    id: "behind-object",
    image: "objectBehind",
    frame: { x: 0.57, y: 0.29, w: 0.26, h: 0.23 },
    layer: 3,
    interaction: {
      label: "Behind object",
      effects: [{ type: "inc", variable: "behindHits", amount: 1 }],
    },
  },
  {
    id: "front-object",
    image: "objectFront",
    frame: { x: 0.57, y: 0.29, w: 0.26, h: 0.23 },
    layer: 9,
    interaction: {
      label: "Front object",
      effects: [
        { type: "inc", variable: "frontHits", amount: 1 },
        { type: "set", variable: "frontLatched", value: true },
      ],
      when: { op: "falsy", value: { type: "variable", name: "frontLatched" } },
    },
  },
];

const ui = {
  "player.menu": "Journal",
  "panel.menu": "Journey journal",
  "panel.save": "Save this moment",
  "panel.load": "Load a save",
  "panel.back": "Back",
  "menu.continue": "Continue reading",
  "menu.save": "Save this moment",
  "menu.load": "Load a save",
  "title.start": "Start new story",
  "title.load": "Load saved story",
  "title.resume": "Resume story",
  "slot.quick": "Quick save",
  "slot.quickSave": "Quick save now",
  "slot.quickSaved": "Quick save updated",
  "player.rollback": "Rollback",
};

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recordFrame(name: string, frame: Frame): void {
  if (!qaDirectory) return;
  const path = join(qaDirectory, name.endsWith(".json") ? name : `${name}.json`);
  writeFileSync(path, `${JSON.stringify(frame, null, 2)}\n`);
}

function assetOf(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function imageOp(frame: Frame, asset: string): DrawOp | undefined {
  return (frame.ops ?? []).find(op => op.type === "image" && assetOf(op) === asset);
}

function latestSave(session: NativeSession, slot: "auto" | "quick" = "auto"): Record<string, any> | undefined {
  return session.storage[`scene-objects.slot.${slot}`] as Record<string, any> | undefined;
}

async function waitForSave(
  session: NativeSession,
  predicate: (save: Record<string, any> | undefined) => boolean,
  frames = 180,
): Promise<Record<string, any>> {
  let frame: Frame | undefined;
  for (let index = 0; index < frames; index += 1) {
    const save = latestSave(session);
    if (predicate(save)) return save!;
    frame = await session.frame();
  }
  throw new Error(`native guest save did not reach the expected state; latest=${JSON.stringify(latestSave(session))}; painted=${frame ? textOf(frame) : "<no frame>"}`);
}

async function waitForText(session: NativeSession, initial: Frame, text: string, frames = 120): Promise<Frame> {
  let frame = initial;
  const needle = text.replace(/\s/g, "");
  for (let index = 0; index < frames; index += 1) {
    if (textOf(frame).replace(/\s/g, "").includes(needle)) return frame;
    frame = await session.frame();
  }
  throw new Error(`native guest did not paint ${JSON.stringify(text)}; painted=${textOf(frame)}`);
}

function visibleTextOp(frame: Frame, label: string): DrawOp {
  const expected = label.replace(/\s/g, "");
  const found = (frame.ops ?? []).find(op => op.type === "text" && typeof op.text === "string" && op.text.replace(/\s/g, "") === expected);
  assert.ok(found, `frame is missing painted text ${JSON.stringify(label)}; actual=${textOf(frame)}`);
  return found!;
}

async function tapText(session: NativeSession, frame: Frame, text: string): Promise<Frame> {
  return session.tapPoint(center(visibleTextOp(frame, text), text));
}

async function waitForSlotData(session: NativeSession, initial: Frame, frames = 180): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < frames; index += 1) {
    if (!textOf(frame).includes("Loading")) return frame;
    frame = await session.frame();
  }
  throw new Error(`native save-slot panel did not finish reading storage; painted=${textOf(frame)}`);
}

function autoSaveWriteCount(session: NativeSession): number {
  const individual = session.storageSets.filter(request => request.key === "scene-objects.slot.auto").length;
  const batched = session.storageBatches.flat().filter(operation => operation.type === "set" && operation.key === "scene-objects.slot.auto").length;
  return individual + batched;
}

async function waitForAutoSaveAfter(
  session: NativeSession,
  initial: Frame,
  previousWrites: number,
  predicate: (save: Record<string, any> | undefined) => boolean,
  frames = 180,
): Promise<{ frame: Frame; save: Record<string, any> }> {
  let frame = initial;
  for (let index = 0; index < frames; index += 1) {
    const save = latestSave(session);
    if (autoSaveWriteCount(session) > previousWrites && predicate(save)) return { frame, save: save! };
    frame = await session.frame();
  }
  throw new Error(`native engine did not publish the loaded state through autosave; latest=${JSON.stringify(latestSave(session))}; painted=${textOf(frame)}`);
}

function cloned<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hostPointForStagePoint(
  point: { x: number; y: number },
  width: number,
  height: number,
  camera: Record<string, number>,
): { x: number; y: number } {
  const pose = resolveNovelCameraPose(camera as any);
  return {
    x: width / 2 + (point.x - width / 2) * pose.scale + pose.x,
    y: height / 2 + (point.y - height / 2) * pose.scale + pose.y,
  };
}

function sceneObjectHitCenter(
  object: SceneObject,
  width: number,
  height: number,
  camera: Record<string, number>,
): { x: number; y: number } {
  const geometry = resolveNovelSceneObjectGeometry(object, width, height);
  assert.ok(geometry, `object ${object.id} must have finite shared Guest geometry`);
  return hostPointForStagePoint({
    x: geometry!.frame.x + geometry!.hit.x + geometry!.hit.width / 2,
    y: geometry!.frame.y + geometry!.hit.y + geometry!.hit.height / 2,
  }, width, height, camera);
}

function transformedRect(
  rect: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  camera: Record<string, number>,
) {
  const a = hostPointForStagePoint({ x: rect.x, y: rect.y }, width, height, camera);
  const b = hostPointForStagePoint({ x: rect.x + rect.width, y: rect.y + rect.height }, width, height, camera);
  return { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
}

test("Editor saves/reopens independent scene objects and the pinned Guest routes real camera-aware object hits", { timeout: 300_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-vn-scene-objects-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "scene-objects-acceptance";
  const qa = qaDirectory;
  await mkdir(project, { recursive: true });
  await mkdir(join(project, "art"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "fonts.json", "novel.locales.json"]) {
    await cp(join(projectSource, name), join(project, name));
  }
  await cp(join(projectSource, "fonts"), join(project, "fonts"), { recursive: true });
  await writeFile(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "pocket.demo.scene-objects", name: "Scene Objects Acceptance", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  await writeFile(join(project, "story.json"), `${JSON.stringify(initialStory, null, 2)}\n`);
  const assets = {
    backgrounds: {
      station: "art/station.png",
      cropSource: objectAssetPaths.crop,
      objectBehind: objectAssetPaths.behind,
      objectFront: objectAssetPaths.front,
    },
    characters: {}, cgs: {}, audio: {},
  };
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  await mkdir(join(project, "art/fx"), { recursive: true });
  for (const source of ["art/station.png", "art/ren-neutral.png", "art/mira-neutral.png", "art/fx/sea-mist.png"]) {
    await cp(join(projectSource, source), join(project, source));
  }
  await writeFile(join(project, "images.json"), `${JSON.stringify({
    "art/station.png": { linear: true },
    [objectAssetPaths.crop]: { linear: true },
    [objectAssetPaths.behind]: { linear: true },
    [objectAssetPaths.front]: { linear: true },
  }, null, 2)}\n`);
  await writeFile(join(project, "app.tsx"), `import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { FocusScope, Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient, type PlatformStorageOperation } from "@pocket/ui/platform";
import { createNovelEngine, createNovelSlotManager, NOVEL_UI_DEFAULT_MESSAGES, NOVEL_UI_EN_MESSAGES, type StoryDefinition, type NovelAssets, type JsonValue } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView } from "@pocket/vn/view";
import storyDocument from "./story.json";
import assetsDocument from "./novel.assets.json";
const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host, media: false });
const slots = createNovelSlotManager({
  get: key => platform.storage.get(key),
  set: (key, value) => platform.storage.set(key, value as any),
  remove: key => platform.storage.remove(key),
  keys: () => platform.storage.keys(),
  batch: operations => platform.storage.batch(operations as unknown as readonly PlatformStorageOperation[]),
}, { prefix: "scene-objects.slot." });
const storage = {
  read: slots.read,
  write: async (slot: string, value: any) => slots.write(slot, value as JsonValue),
  list: slots.list, delete: slots.delete, copy: slots.copy, move: slots.move, swap: slots.swap,
};
const ui = { ...NOVEL_UI_DEFAULT_MESSAGES, ...NOVEL_UI_EN_MESSAGES, ${JSON.stringify(ui).slice(1, -1)} };
function App() {
  const engine = createNovelEngine(storyDocument as StoryDefinition, { preferences: { textSpeedCharsPerSecond: 0 } });
  const [snapshot, setSnapshot] = createSignal(engine.getSnapshot());
  const detachClock = attachNovelClock(engine);
  let autoSaveQueue: Promise<void> = Promise.resolve();
  const unsubscribe = engine.subscribe(update => {
    setSnapshot(update.snapshot);
    if (update.snapshot.started && update.snapshot.phase !== "disposed") {
      const save = engine.save();
      autoSaveQueue = autoSaveQueue.catch(() => undefined).then(() => slots.write("auto", save as unknown as JsonValue));
    }
  });
  onCleanup(() => { unsubscribe(); detachClock(); engine.dispose(); platform.dispose(); host.dispose(); });
  return <FocusScope class="relative w-full h-full" autoFocus>
    <NovelView engine={engine} host={host} storage={storage} assets={assetsDocument as NovelAssets} title="Scene Objects" ui={ui} onNewGame={() => engine.start()} />
    <Focusable debugName="scene-object-test-pause" class="absolute left-1 top-1 px-2 py-1" onPress={() => snapshot().paused ? engine.resume() : engine.pause()}>
      <View class="bg-[#07110d] p-1"><Text class="text-xs text-white">{snapshot().paused ? "Resume engine" : "Pause engine"}</Text></View>
    </Focusable>
  </FocusScope>;
}
mount(App);
`);

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const browserErrors: string[] = [];
  let nativeSession: NativeSession | undefined;
  const originalProbe = process.env.POCKET_NATIVE_PROBE;
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => browserErrors.push(error.message));

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    const objectsField = page.locator('[data-scene-objects-json="true"][data-location="start:0"]');
    await objectsField.waitFor();
    assert.equal(await objectsField.getAttribute("data-location"), "start:0");
    assert.deepEqual(JSON.parse(await objectsField.inputValue()), []);

    await objectsField.fill(JSON.stringify(authoredObjects, null, 2));
    await objectsField.press("Tab");
    await page.waitForFunction(() => {
      const value = (document.querySelector('[data-scene-objects-json="true"][data-location="start:0"]') as HTMLTextAreaElement | null)?.value;
      return !!value && JSON.parse(value).length === 3;
    });
    await clickNovelHistory(page, "undo");
    assert.deepEqual(JSON.parse(await objectsField.inputValue()), [], "undo restores an explicit empty object array");
    await clickNovelHistory(page, "redo");
    assert.deepEqual(JSON.parse(await objectsField.inputValue()), authoredObjects, "redo restores the complete object declarations");

    await page.getByRole("button", { name: "舞台编辑", exact: true }).click();
    await page.getByLabel("舞台标签", { exact: true }).selectOption("start");
    await page.getByLabel("舞台场景", { exact: true }).selectOption("0");
    const stage = page.locator(".nv-authoring-stage");
    const cropObject = page.locator('[data-scene-object-id="crop-window"]');
    await cropObject.waitFor();
    const stageBox = await stage.boundingBox();
    const cropBox = await cropObject.boundingBox();
    assert.ok(stageBox && cropBox, "the Editor must paint the authored object on its real stage canvas");
    const cropChoice = page.locator('[data-scene-object-choice="crop-window"]');
    await cropChoice.click();
    await page.locator("[data-scene-object-inspector]").waitFor();
    assert.equal(await page.locator("[data-scene-object-inspector] input[type=number]").first().inputValue(), "0.08");
    const cameraScale = Number(await page.locator(".nv-authoring-cast").getAttribute("data-camera-scale"));
    assert.ok(cameraScale > 0);
    const dragStart = { x: cropBox.x + cropBox.width / 2, y: cropBox.y + cropBox.height / 2 };
    await page.evaluate(() => {
      const trace: Array<Record<string, unknown>> = [];
      (window as Window & { __sceneObjectPointerTrace?: Array<Record<string, unknown>> }).__sceneObjectPointerTrace = trace;
      for (const type of ["pointerdown", "pointermove", "pointerup"] as const) {
        document.addEventListener(type, event => {
          const pointer = event as PointerEvent;
          trace.push({ type, x: pointer.clientX, y: pointer.clientY, target: (pointer.target as HTMLElement | null)?.closest?.("[data-scene-object-id]")?.getAttribute("data-scene-object-id") ?? null });
        }, true);
      }
    });
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x + 24, dragStart.y + 12, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const item = document.querySelector('[data-scene-object-id="crop-window"]') as HTMLElement | null;
      return !!item && JSON.parse(item.dataset.frame ?? "{}").x > 0.08;
    });
    const movedCrop = await cropObject.getAttribute("data-frame");
    assert.ok(movedCrop);
    const movedCropFrame = JSON.parse(movedCrop!) as SceneObject["frame"];
    const expectedDeltaX = 24 / stageBox.width / cameraScale;
    const expectedDeltaY = 12 / stageBox.height / cameraScale;
    const pointerTrace = await page.evaluate(() => (window as Window & { __sceneObjectPointerTrace?: Array<Record<string, unknown>> }).__sceneObjectPointerTrace ?? []);
    assert.ok(Math.abs(movedCropFrame.x - (0.08 + expectedDeltaX)) <= 0.002, `drag moves the authored frame by its pointer delta only; ${JSON.stringify({ x: movedCropFrame.x, expectedX: 0.08 + expectedDeltaX, stageBox, cropBox, cameraScale, pointerTrace })}`);
    assert.ok(Math.abs(movedCropFrame.y - (0.24 + expectedDeltaY)) <= 0.002, `aspect-ratio centering must not add a y offset; y=${movedCropFrame.y} expected=${0.24 + expectedDeltaY}`);
    await page.screenshot({ path: join(qa ?? temporary, "scene-objects-editor-drag.png"), fullPage: true });
    await clickNovelHistory(page, "undo");
    await page.waitForFunction(() => Number(JSON.parse((document.querySelector('[data-scene-object-id="crop-window"]') as HTMLElement | null)?.dataset.frame ?? "{}").x) === 0.08);
    await clickNovelHistory(page, "redo");
    await page.waitForFunction(() => Number(JSON.parse((document.querySelector('[data-scene-object-id="crop-window"]') as HTMLElement | null)?.dataset.frame ?? "{}").x) > 0.08);

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const storyPath = join(project, "story.json");
    const savedStory = JSON.parse(await readFile(storyPath, "utf8"));
    const savedObjects = savedStory.script.start[0].objects as SceneObject[];
    assert.equal(savedObjects.length, 3);
    assert.ok(savedObjects[0]!.frame.x > 0.08, "the stage drag updates the normalized object frame in story.json");
    assert.deepEqual(savedStory.script.start[0].authorSceneNote, { keep: ["source", "metadata"] });
    if (qa) {
      await mkdir(qa, { recursive: true });
      await writeFile(join(qa, "saved-story.json"), `${JSON.stringify(savedStory, null, 2)}\n`);
      await cp(join(project, "novel.assets.json"), join(qa, "fixture-novel.assets.json"));
      await cp(join(project, "app.tsx"), join(qa, "fixture-app.tsx"));
    }

    await page.reload();
    const reopenedObjectsField = page.locator('[data-scene-objects-json="true"][data-location="start:0"]');
    await reopenedObjectsField.waitFor();
    assert.deepEqual(JSON.parse(await reopenedObjectsField.inputValue()), savedObjects, "the editor reopens the exact saved object list after reload");
    assert.deepEqual(JSON.parse(await readFile(storyPath, "utf8")), savedStory);
    await page.waitForFunction(() => {
      const build = document.querySelector<HTMLButtonElement>("#novel-build");
      return !!build && !build.disabled && document.querySelector("#novel-save-state")?.dataset.dirty === "false";
    });
    assert.match(await page.locator("#novel-diagnostics").innerText(), /结构检查通过/, "the saved fixture must pass Editor validation before it can use the canonical buildGuest pipeline");
    await page.screenshot({ path: join(qa ?? temporary, "scene-objects-editor-reopen.png"), fullPage: true });

    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 90_000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as { builtRevision: number; revision: number };
    assert.equal(status.builtRevision, status.revision, "the saved source must compile at the current Editor revision");
    const artifactDirectory = join(workspace, "builds", projectId, String(status.builtRevision));
    const bytecodePath = join(artifactDirectory, "app.qjbc");
    const pakPath = join(artifactDirectory, "app.pak");
    const metadataPath = join(artifactDirectory, "app.bytecode.json");
    assert.ok(existsSync(bytecodePath) && existsSync(pakPath) && existsSync(metadataPath), "the saved Editor revision must produce all pinned Guest artifacts");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    const artifacts: NativeArtifacts = { bytecodePath, pakPath, metadataPath, runtimeAbi: String(metadata.runtimeAbi) };
    const nativeProbe = process.env.POCKET_NATIVE_PROBE;
    assert.ok(nativeProbe && existsSync(nativeProbe), "the actual release pocket_probe must be pinned for the Guest run");
    nativeSession = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 120_000 });

    let frame = await nativeSession.boot();
    recordFrame("guest-title", frame);
    frame = await tapText(nativeSession, frame, "Start new story");
    frame = await waitForText(nativeSession, frame, "Inspect the independent scene objects.");
    let save = await waitForSave(nativeSession, item => item?.state?.active?.id === "object-lab" && item.state.stage.objects?.length === 3);
    recordFrame("guest-active-stage", frame);
    assert.equal(save.state.active.kind, "say");
    assert.equal(save.state.active.id, "object-lab");
    assert.equal(save.state.variables.cropHits, 0);
    assert.equal(save.state.stage.objects.length, 3);

    const initialCamera = save.state.stage.camera;
    assert.ok(initialCamera.motion && initialCamera.motion.elapsedMs < initialCamera.motion.durationMs, "the scene-object hit runs while canonical camera motion is active");
    const cropGeometry = resolveNovelSceneObjectGeometry(savedObjects[0] as any, frame.width!, frame.height!);
    assert.ok(cropGeometry, "the shared SDK geometry must resolve the persisted cropped object");
    assert.deepEqual(cropGeometry!.hit, { x: 0, y: 0, width: cropGeometry!.frame.width, height: cropGeometry!.frame.height }, "source crop does not shrink the full-frame default hit area");
    const cropImage = imageOp(frame, objectAssetPaths.crop);
    assert.ok(cropImage, "the cropped source image is painted by the native Guest");
    assert.ok((cropImage as DrawOp & { uv?: number[] }).uv, "the native cropped image exposes its source window in the actual draw operation");
    const cropLabelCenter = center(visibleTextOp(frame, "Inspect cropped window"), "camera-transformed crop object label");
    const visibleHit = transformedRect({
      x: cropGeometry!.frame.x + cropGeometry!.hit.x,
      y: cropGeometry!.frame.y + cropGeometry!.hit.y,
      width: cropGeometry!.hit.width,
      height: cropGeometry!.hit.height,
    }, frame.width!, frame.height!, initialCamera);
    assert.ok(cropLabelCenter.x >= visibleHit.x && cropLabelCenter.x <= visibleHit.x + visibleHit.width
      && cropLabelCenter.y >= visibleHit.y && cropLabelCenter.y <= visibleHit.y + visibleHit.height,
      "the real camera-transformed label and shared normalized hit geometry must agree");
    frame = await nativeSession.tapPoint(cropLabelCenter);
    save = await waitForSave(nativeSession, item => item?.state?.variables?.cropHits === 1);
    recordFrame("guest-crop-hit-during-camera", frame);
    assert.equal(save.state.active.id, "object-lab", "object interactions do not advance the active say");
    assert.equal(save.state.backlog.length, 0, "object interactions do not append a dialogue backlog entry");
    assert.equal(save.state.variables.cropHits, 1);
    assert.ok(save.state.stage.camera.motion.elapsedMs < save.state.stage.camera.motion.durationMs, "the current camera motion remains in progress after the hit");

    const objectItems = orderedNovelStageItems(save.state.stage).filter(item => item.kind === "object").map(item => item.id);
    assert.deepEqual(objectItems, ["crop-window", "behind-object", "front-object"], "shared stage ordering places the higher layer last");
    const orderInFrame = [objectAssetPaths.behind, objectAssetPaths.front]
      .map(asset => (frame.ops ?? []).findIndex(op => op.type === "image" && assetOf(op) === asset));
    assert.ok(orderInFrame[0]! >= 0 && orderInFrame[1]! > orderInFrame[0]!, "the actual native draw list paints the upper object after the overlapping lower object");

    frame = await nativeSession.tapPoint(sceneObjectHitCenter(savedObjects[2]!, frame.width!, frame.height!, save.state.stage.camera));
    save = await waitForSave(nativeSession, item => item?.state?.variables?.frontHits === 1);
    recordFrame("guest-front-overlap-hit", frame);
    assert.equal(save.state.variables.behindHits, 0, "the topmost overlapping object consumes the hit exactly once");
    assert.equal(save.state.variables.frontLatched, true);
    assert.equal(save.state.active.id, "object-lab");

    // A hit inside the visible crop frame is valid even when it maps to pixels
    // outside the un-cropped source region. This point is derived from the
    // actual normalized frame and the canonical camera pose.
    const currentCamera = save.state.stage.camera;
    const cropEdgePoint = hostPointForStagePoint({
      x: cropGeometry!.frame.x + cropGeometry!.frame.width * 0.08,
      y: cropGeometry!.frame.y + cropGeometry!.frame.height * 0.5,
    }, frame.width!, frame.height!, currentCamera);
    const beforeCropEdge = save.state.variables.cropHits;
    frame = await nativeSession.tapPoint(cropEdgePoint);
    save = await waitForSave(nativeSession, item => item?.state?.variables?.cropHits === beforeCropEdge + 1);
    recordFrame("guest-crop-frame-edge-hit", frame);
    assert.equal(save.state.active.id, "object-lab");

    // Click a stage point outside the cropped object's frame and all object hit
    // rectangles. The canonical say and every object variable must remain put.
    const outsideFrame = { x: 144, y: 307 };
    const outsideStagePoint = hostPointForStagePoint(outsideFrame, frame.width!, frame.height!, save.state.stage.camera);
    const projected = transformedRect(cropGeometry!.frame, frame.width!, frame.height!, save.state.stage.camera);
    assert.ok(outsideStagePoint.x < projected.x || outsideStagePoint.x > projected.x + projected.width || outsideStagePoint.y < projected.y || outsideStagePoint.y > projected.y + projected.height,
      "negative sample must be outside the cropped object's visible frame");
    for (const object of save.state.stage.objects as SceneObject[]) {
      const geometry = resolveNovelSceneObjectGeometry(object, frame.width!, frame.height!);
      assert.ok(geometry, `negative-hit check requires finite geometry for ${object.id}`);
      const objectHit = transformedRect({
        x: geometry!.frame.x + geometry!.hit.x,
        y: geometry!.frame.y + geometry!.hit.y,
        width: geometry!.hit.width,
        height: geometry!.hit.height,
      }, frame.width!, frame.height!, save.state.stage.camera);
      assert.ok(outsideStagePoint.x < objectHit.x || outsideStagePoint.x > objectHit.x + objectHit.width
        || outsideStagePoint.y < objectHit.y || outsideStagePoint.y > objectHit.y + objectHit.height,
        `negative pointer sample must miss every object hit rect; object=${object.id}; pointer=${JSON.stringify(outsideStagePoint)}; hit=${JSON.stringify(objectHit)}`);
    }
    assert.ok(outsideStagePoint.x >= 0 && outsideStagePoint.x < frame.width! && outsideStagePoint.y >= 0 && outsideStagePoint.y < frame.height!,
      "negative pointer sample remains inside the native guest viewport");
    const beforeOutside = cloned(save.state);
    frame = await nativeSession.tapPoint(outsideStagePoint);
    save = await waitForSave(nativeSession, item => item?.state?.variables?.cropHits === beforeOutside.variables.cropHits);
    recordFrame("guest-outside-object-frame", frame);
    assert.equal(save.state.active.id, beforeOutside.active.id, "a point outside the object and hit frame cannot advance the current say");
    assert.equal(save.state.variables.frontHits, beforeOutside.variables.frontHits);
    assert.equal(save.state.variables.behindHits, beforeOutside.variables.behindHits);

    frame = await tapText(nativeSession, frame, "Pause engine");
    save = await waitForSave(nativeSession, item => item?.state?.paused === true);
    const pausedVariables = cloned(save.state.variables);
    const pausedCropPoint = sceneObjectHitCenter(savedObjects[0]!, frame.width!, frame.height!, save.state.stage.camera);
    frame = await nativeSession.tapPoint(pausedCropPoint);
    await nativeSession.settle(frame, 4);
    assert.deepEqual(latestSave(nativeSession)?.state?.variables, pausedVariables, "a paused engine rejects a real pointer hit on the scene object");
    recordFrame("guest-paused-object-hit", frame);
    frame = await tapText(nativeSession, frame, "Resume engine");
    await waitForSave(nativeSession, item => item?.state?.paused === false);
    frame = await tapText(nativeSession, frame, "Journal");
    save = await waitForSave(nativeSession, item => item?.state?.paused === true);
    const menuVariables = cloned(save.state.variables);
    frame = await nativeSession.tapPoint(cropEdgePoint);
    await nativeSession.settle(frame, 4);
    assert.deepEqual(latestSave(nativeSession)?.state?.variables, menuVariables, "opening the real menu pauses the engine and prevents object activation under the overlay");
    recordFrame("guest-menu-object-hit", frame);
    frame = await tapText(nativeSession, frame, "Continue reading");
    await waitForSave(nativeSession, item => item?.state?.paused === false);

    frame = await tapText(nativeSession, frame, "Journal");
    frame = await waitForText(nativeSession, frame, "Quick save now");
    frame = await tapText(nativeSession, frame, "Quick save now");
    save = await waitForSave(nativeSession, item => item?.state?.active?.id === "object-lab");
    const quickSave = latestSave(nativeSession, "quick");
    assert.ok(quickSave, "the official player quick-save control must write through the native storage capability");
    assert.equal(quickSave!.state?.stage?.objects?.length, 3);
    assert.equal(quickSave!.state?.variables?.frontHits, save.state.variables.frontHits);
    assert.ok(nativeSession.storageSets.some(request => request.key === "scene-objects.slot.quick"), "the guest quick save reaches the native storage boundary");
    recordFrame("guest-quick-saved", frame);

    const quickCopy = cloned(quickSave!);
    const reopenedSession = new NativeSession(artifacts, { width: 360, height: 640, storage: cloned(nativeSession.storage), deadlineMs: 120_000 });
    try {
      let reopenedFrame = await reopenedSession.boot();
      reopenedFrame = await tapText(reopenedSession, reopenedFrame, "Load saved story");
      reopenedFrame = await waitForText(reopenedSession, reopenedFrame, "Quick save");
      reopenedFrame = await waitForSlotData(reopenedSession, reopenedFrame);
      const beforeQuickLoadWrites = autoSaveWriteCount(reopenedSession);
      reopenedFrame = await tapText(reopenedSession, reopenedFrame, "Quick save");
      let loaded = await waitForAutoSaveAfter(reopenedSession, reopenedFrame, beforeQuickLoadWrites, item => item?.state?.active?.id === "object-lab" && item.state.stage.objects?.length === 3);
      reopenedFrame = loaded.frame;
      let reopened = loaded.save;
      if (reopened.state.paused) {
        const beforeResumeWrites = autoSaveWriteCount(reopenedSession);
        reopenedFrame = await tapText(reopenedSession, reopenedFrame, "Resume engine");
        loaded = await waitForAutoSaveAfter(reopenedSession, reopenedFrame, beforeResumeWrites, item => item?.state?.paused === false && item.state.active?.id === "object-lab");
        reopenedFrame = loaded.frame;
        reopened = loaded.save;
      }
      reopenedFrame = await waitForText(reopenedSession, reopenedFrame, "Inspect the independent scene objects.");
      assert.doesNotMatch(textOf(reopenedFrame), /Load a save/, "the native quick-load action must close the title load panel before gameplay input");
      recordFrame("guest-modern-save-reloaded", reopenedFrame);
      assert.deepEqual(reopened.state.variables, quickCopy.state.variables);
      assert.deepEqual(reopened.state.stage.objects, quickCopy.state.stage.objects);
      assert.equal(reopened.state.stage.camera.x, quickCopy.state.stage.camera.x);
      assert.equal(reopened.state.active.id, "object-lab");

      const legacySave = cloned(quickCopy);
      delete legacySave.state.stage.objects;
      for (const checkpoint of legacySave.state.rollbackHistory ?? []) delete checkpoint.stage.objects;
      const legacySession = new NativeSession(artifacts, {
        width: 360,
        height: 640,
        storage: { "scene-objects.slot.quick": legacySave },
        deadlineMs: 120_000,
      });
      try {
        let legacyFrame = await legacySession.boot();
        legacyFrame = await tapText(legacySession, legacyFrame, "Load saved story");
        legacyFrame = await waitForText(legacySession, legacyFrame, "Quick save");
        legacyFrame = await waitForSlotData(legacySession, legacyFrame);
        const beforeLegacyLoadWrites = autoSaveWriteCount(legacySession);
        legacyFrame = await tapText(legacySession, legacyFrame, "Quick save");
        let legacyLoad = await waitForAutoSaveAfter(legacySession, legacyFrame, beforeLegacyLoadWrites, item => item?.state?.active?.id === "object-lab");
        legacyFrame = legacyLoad.frame;
        let legacyLoaded = legacyLoad.save;
        if (legacyLoaded.state.paused) {
          const beforeLegacyResumeWrites = autoSaveWriteCount(legacySession);
          legacyFrame = await tapText(legacySession, legacyFrame, "Resume engine");
          legacyLoad = await waitForAutoSaveAfter(legacySession, legacyFrame, beforeLegacyResumeWrites, item => item?.state?.paused === false && item?.state?.active?.id === "object-lab");
          legacyFrame = legacyLoad.frame;
          legacyLoaded = legacyLoad.save;
        }
        legacyFrame = await waitForText(legacySession, legacyFrame, "Inspect the independent scene objects.");
        assert.equal(legacyLoaded.state.stage.objects?.length ?? 0, 0, "old saves with no stage.objects load as an empty object composition");
        assert.equal(legacyLoaded.state.variables.frontHits, quickCopy.state.variables.frontHits);
        assert.equal(legacyLoaded.state.active.id, "object-lab");
        recordFrame("guest-legacy-save-loaded", legacyFrame);
        assert.doesNotMatch(textOf(legacyFrame), /Load a save/, "the legacy quick-load action must leave the storage panel before the player advances");
        const beforeLegacyAdvanceWrites = autoSaveWriteCount(legacySession);
        legacyFrame = await tapText(legacySession, legacyFrame, "Inspect the independent scene objects.");
        legacyLoad = await waitForAutoSaveAfter(legacySession, legacyFrame, beforeLegacyAdvanceWrites, item => item?.state?.active?.id === "inherited-objects");
        legacyFrame = legacyLoad.frame;
        assert.equal(legacyLoad.save.state.stage.objects?.length ?? 0, 0, "an old save with no object field keeps an empty object stage after executing a later omitted-object scene");
        recordFrame("guest-legacy-save-continues-empty", legacyFrame);
      } finally { await legacySession.quit(); }

      const beforeLoadedObjectHitWrites = autoSaveWriteCount(reopenedSession);
      reopenedFrame = await reopenedSession.tapPoint(sceneObjectHitCenter(savedObjects[0]!, reopenedFrame.width!, reopenedFrame.height!, reopened.state.stage.camera));
      let objectHit = await waitForAutoSaveAfter(reopenedSession, reopenedFrame, beforeLoadedObjectHitWrites,
        item => item?.state?.variables?.cropHits === quickCopy.state.variables.cropHits + 1);
      reopenedFrame = objectHit.frame;
      assert.equal(objectHit.save.state.variables.frontHits, quickCopy.state.variables.frontHits);
      assert.equal(objectHit.save.state.variables.frontLatched, true);
      assert.equal(objectHit.save.state.active.id, "object-lab", "a restored scene-object hit does not advance the restored dialogue");
      assert.deepEqual(objectHit.save.state.stage.objects, quickCopy.state.stage.objects, "the actual loaded Guest paints and retains the saved object composition");
      recordFrame("guest-modern-save-object-hit", reopenedFrame);

      const beforeAdvanceWrites = autoSaveWriteCount(reopenedSession);
      reopenedFrame = await tapText(reopenedSession, reopenedFrame, "Inspect the independent scene objects.");
      let advanced = await waitForAutoSaveAfter(reopenedSession, reopenedFrame, beforeAdvanceWrites,
        item => item?.state?.active?.id === "inherited-objects");
      reopenedFrame = advanced.frame;
      assert.equal(advanced.save.state.variables.cropHits, quickCopy.state.variables.cropHits + 1);
      assert.equal(advanced.save.state.stage.objects?.length, 3);
      recordFrame("guest-object-state-after-say-checkpoint", reopenedFrame);

      const beforeCheckpointHitWrites = autoSaveWriteCount(reopenedSession);
      reopenedFrame = await reopenedSession.tapPoint(sceneObjectHitCenter(
        savedObjects[0]!, reopenedFrame.width!, reopenedFrame.height!, advanced.save.state.stage.camera,
      ));
      const checkpointHit = await waitForAutoSaveAfter(reopenedSession, reopenedFrame, beforeCheckpointHitWrites,
        item => item?.state?.variables?.cropHits === quickCopy.state.variables.cropHits + 2);
      reopenedFrame = checkpointHit.frame;
      assert.equal(checkpointHit.save.state.active.id, "inherited-objects", "the second object hit also leaves the active say in place");

      const beforeRollbackWrites = autoSaveWriteCount(reopenedSession);
      reopenedFrame = await tapText(reopenedSession, reopenedFrame, "Rollback");
      const rolledBack = await waitForAutoSaveAfter(reopenedSession, reopenedFrame, beforeRollbackWrites,
        item => item?.state?.active?.id === "object-lab" && item?.state?.variables?.cropHits === quickCopy.state.variables.cropHits + 1);
      reopenedFrame = rolledBack.frame;
      const afterRollback = rolledBack.save;
      recordFrame("guest-rollback-restores-object-effects", reopenedFrame);
      assert.equal(afterRollback.state.variables.frontHits, quickCopy.state.variables.frontHits);
      assert.equal(afterRollback.state.variables.frontLatched, true);
      assert.equal(afterRollback.state.active.id, "object-lab");
      assert.equal(afterRollback.state.variables.cropHits, quickCopy.state.variables.cropHits + 1,
        "rollback restores the dialogue checkpoint's object-effect value, preserving the earlier hit and discarding the later one");
      assert.deepEqual(afterRollback.state.stage.objects, quickCopy.state.stage.objects);

      // Scene instructions distinguish omitted objects (inherit) from [] (clear).
      reopenedFrame = await tapText(reopenedSession, reopenedFrame, "Inspect the independent scene objects.");
      reopenedFrame = await waitForText(reopenedSession, reopenedFrame, "The omitted object list inherits the existing stage.");
      let inherited = await waitForSave(reopenedSession, item => item?.state?.active?.id === "inherited-objects");
      assert.equal(inherited.state.stage.objects?.length, 3);
      recordFrame("guest-omitted-objects-inherit", reopenedFrame);
      reopenedFrame = await tapText(reopenedSession, reopenedFrame, "The omitted object list inherits the existing stage.");
      reopenedFrame = await waitForText(reopenedSession, reopenedFrame, "The explicit empty list clears the stage objects.");
      const cleared = await waitForSave(reopenedSession, item => item?.state?.active?.id === "cleared-objects");
      assert.equal(cleared.state.stage.objects?.length ?? 0, 0);
      assert.equal(imageOp(reopenedFrame, objectAssetPaths.front), undefined, "an explicit empty object list removes the previously visible stage objects");
      recordFrame("guest-explicit-empty-clears", reopenedFrame);
    } finally { await reopenedSession.quit(); }

    assert.deepEqual(browserErrors, [], `Editor browser errors: ${browserErrors.join(" | ")}`);
    const sourceFiles = [
      join(repository, "sdk/packages/pocket_vn/src/scene-objects.ts"),
      join(repository, "sdk/packages/pocket_vn/src/engine.ts"),
      join(repository, "sdk/packages/pocket_vn/src/types.ts"),
      join(repository, "sdk/packages/pocket_vn/src/view.tsx"),
      join(repository, "sdk/packages/pocket_vn/src/editor-runtime.ts"),
      join(repository, "sdk/editor/client/novel.js"),
      join(repository, "sdk/editor/client/novel.css"),
      join(repository, "sdk/editor/client/novel-stage.js"),
      join(repository, "sdk/editor/client/novel-stage.css"),
      join(repository, "sdk/editor/novel.ts"),
      join(import.meta.dir, "novel_scene_objects_browser.test.ts"),
    ];
    if (qa) {
      const sourceHashes: Record<string, string> = {};
      for (const path of sourceFiles) sourceHashes[path.replace(`${repository}/`, "")] = hash(await readFile(path));
      const compilerPath = join(process.env.POCKET_TOOLS_PACKAGE ?? "", "compiler/tools/build.ts");
      assert.ok(existsSync(compilerPath), `pinned PocketJS compiler source must exist at ${compilerPath}`);
      await writeFile(join(qa, "guest-manifest.json"), `${JSON.stringify({
        projectId,
        builtRevision: status.builtRevision,
        runtimeAbi: metadata.runtimeAbi,
        entryFormat: metadata.entryFormat,
        savedStoryPath: "saved-story.json",
        savedStorySha256: hash(await readFile(join(qa, "saved-story.json"))),
        fixtureAssetsPath: "fixture-novel.assets.json",
        fixtureAssetsSha256: hash(await readFile(join(qa, "fixture-novel.assets.json"))),
        fixtureAppPath: "fixture-app.tsx",
        fixtureAppSha256: hash(await readFile(join(qa, "fixture-app.tsx"))),
        bytecodeSha256: hash(await readFile(bytecodePath)),
        pakSha256: hash(await readFile(pakPath)),
        metadataSha256: hash(await readFile(metadataPath)),
        compilerPath,
        compilerSha256: hash(await readFile(compilerPath)),
        bunPath: process.execPath,
        nativeProbe,
        nativeProbeSha256: hash(await readFile(nativeProbe)),
        pocketToolsPackage: process.env.POCKET_TOOLS_PACKAGE ?? null,
        sourceHashes,
      }, null, 2)}\n`);
    }
  } finally {
    if (nativeSession) await nativeSession.quit();
    if (originalProbe === undefined) delete process.env.POCKET_NATIVE_PROBE;
    else process.env.POCKET_NATIVE_PROBE = originalProbe;
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}, 300_000);
