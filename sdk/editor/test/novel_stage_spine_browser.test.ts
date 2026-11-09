import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { NativeSession, type DrawOp } from "../../../demo/js/tests/native_session.ts";

const repository = resolve(import.meta.dir, "../../..");
const source = join(repository, "demo/js/apps/lantern");

const story = {
  id: "stage-spine-editor-test",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "room", characters: [
        {
          id: "mira", expression: "worried", position: { x: 112, y: 116 }, visible: true,
          model: { key: "mira_spine", animation: "alert", loop: true, skin: "worried" },
          scale: 1, rotation: -2, layer: 0,
        },
        { id: "ren", expression: "neutral", position: { x: -48, y: 116 }, visible: true, scale: 0.92, rotation: 2, layer: 1 },
      ] },
      { type: "say", id: "stage-spine-pause-one", speaker: "Mira", text: "Pause one." },
      { type: "scene", background: "room", characters: [
        { id: "mira", expression: "hopeful", model: { key: "mira_spine", animation: "settle", loop: true, skin: "hopeful" }, layer: 2 },
        { id: "ren", expression: "worried", layer: 3 },
      ] },
      { type: "say", id: "stage-spine-pause-two", speaker: "Mira", text: "Pause two." },
      { type: "scene", background: "room", characters: [{ id: "mira", visible: false }, { id: "ren", visible: true }] },
      { type: "say", id: "stage-spine-test-line", speaker: "Mira", text: "The editor stage previews the same animated Spine mesh." },
      { type: "ending", id: "stage-spine-test-end", text: "Done." },
    ],
  },
};

const assets = {
  backgrounds: { room: "art/room.png" },
  characters: { ren: { neutral: "art/ren.png", worried: "art/ren.png" } },
  cgs: {},
  audio: {},
  models: {
    mira_spine: {
      kind: "spine",
      source: "models/mira.spine.json",
      atlas: "models/mira.atlas",
      textures: {
        "mira-neutral.png": "art/mira-neutral.png",
        "mira-worried.png": "art/mira-worried.png",
        "mira-hopeful.png": "art/mira-hopeful.png",
      },
      animations: ["idle", "alert", "settle"],
    },
  },
};

test("real Chromium stage previews the registered Spine model through transforms, save/reopen, and teardown", { timeout: 120_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-stage-spine-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  mkdirSync(join(project, "art"), { recursive: true });
  mkdirSync(join(project, "models"), { recursive: true });
  mkdirSync(join(project, "assets", "audio"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json", "fonts.json"]) {
    cpSync(join(source, name), join(project, name));
  }
  cpSync(join(source, "fonts"), join(project, "fonts"), { recursive: true });
  cpSync(join(source, "models/mira.spine.json"), join(project, "models/mira.spine.json"));
  cpSync(join(source, "models/mira.atlas"), join(project, "models/mira.atlas"));
  for (const name of ["mira-neutral.png", "mira-worried.png", "mira-hopeful.png", "ren-neutral.png"]) {
    cpSync(join(source, `art/${name}`), join(project, `art/${name === "ren-neutral.png" ? "ren.png" : name}`));
  }
  cpSync(join(source, "art/station.png"), join(project, "art/room.png"));
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  writeFileSync(join(project, "images.json"), JSON.stringify(Object.fromEntries([
    "art/room.png", "art/ren.png", "art/mira-neutral.png", "art/mira-worried.png", "art/mira-hopeful.png",
  ].map(path => [path, { linear: true }]))));
  writeFileSync(join(project, "app.tsx"), `import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createNovelAnimationDriver, createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { createBundledNovelSpineFactory } from "@pocket/vn/spine";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import storyDocument from "./story.json";
import assetsDocument from "./novel.assets.json";

function App() {
  const engine = createNovelEngine(storyDocument as StoryDefinition);
  const animations = createNovelAnimationDriver();
  const removeClock = attachNovelClock(engine, { animations });
  const spine = createBundledNovelSpineFactory();
  onCleanup(() => { removeClock(); engine.dispose(); });
  return <NovelView engine={engine} assets={assetsDocument as NovelAssets} title="Spine Stage Guest Test" modelFactory={spine} animations={animations} onNewGame={() => engine.start()} />;
}

mount(App);
`);
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "stage-spine-editor", appId: "pocket.demo.lantern", name: "Spine Stage Editor", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));

  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let nativeSession: NativeSession | undefined;
  const pageErrors: string[] = [];
  try {
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=stage-spine-editor`);
    await page.getByRole("button", { name: "舞台编辑", exact: true }).click();
    await page.getByLabel("舞台场景", { exact: true }).selectOption("0");
    const firstCanvas = page.locator('canvas[data-model-preview-character="mira"]');
    await firstCanvas.waitFor();
    await page.waitForFunction(() => Number(document.querySelector('canvas[data-model-preview-character="mira"]')?.getAttribute("data-frame-count")) >= 3);
    const canvasPixels = async (locator: typeof firstCanvas) => locator.evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Spine stage preview has no 2D canvas context");
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let alphaPixels = 0;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index++) {
        const value = pixels[index]!;
        if ((index & 3) === 3 && value > 24) alphaPixels++;
        hash = Math.imul(hash ^ value, 16777619);
      }
      return { alphaPixels, hash: hash >>> 0, frameCount: Number(canvas.dataset.frameCount), meshCount: Number(canvas.dataset.meshCount) };
    });
    const initialPixels = await canvasPixels(firstCanvas);
    assert.ok(initialPixels.alphaPixels > 500, `the transparent stage canvas must contain the real Spine mesh pixels: ${JSON.stringify(initialPixels)}`);
    assert.ok(initialPixels.meshCount > 0, "the shared official Spine painter must produce at least one mesh");
    await page.evaluate(() => { (window as any).__firstStageSpineCanvas = document.querySelector('canvas[data-model-preview-character="mira"]'); });
    await page.waitForTimeout(220);
    const animatedPixels = await canvasPixels(firstCanvas);
    assert.ok(animatedPixels.frameCount > initialPixels.frameCount, "the selected scene's official Spine animation must keep advancing");
    assert.notEqual(animatedPixels.hash, initialPixels.hash, "the actual animated Spine canvas pixels must change across frames");

    const editNumber = async (label: string, value: string): Promise<void> => {
      const field = page.getByLabel(label, { exact: true });
      await field.fill(value);
      await field.press("Tab");
    };
    await editNumber("X", "146");
    await editNumber("均匀缩放", "1.25");
    await editNumber("层级", "2");
    const editedPlacement = await page.locator('.nv-authoring-character[data-character-id="mira"]').evaluate(element => {
      const item = element as HTMLElement;
      return {
        left: parseFloat(item.style.left),
        transform: item.style.transform,
        layer: item.style.zIndex,
        order: [...(item.parentElement?.children ?? [])].map(child => (child as HTMLElement).dataset.characterId),
        hasSameCanvas: item.querySelector("canvas") === (window as any).__firstStageSpineCanvas,
      };
    });
    assert.ok(Math.abs(editedPlacement.left - (146 / 360 * 100)) < 0.01, "model position edits must move its real stage canvas in 360×640 coordinates");
    assert.match(editedPlacement.transform, /scale\(1\.25\)/);
    assert.equal(editedPlacement.layer, "2");
    assert.deepEqual(editedPlacement.order, ["ren", "mira"], "the real model actor must follow the edited layer ordering");
    assert.equal(editedPlacement.hasSameCanvas, true, "position/scale/layer edits must retain the live Spine controller canvas");
    await page.waitForFunction(initial => Number(document.querySelector('canvas[data-model-preview-character="mira"]')?.getAttribute("data-frame-count")) > initial, animatedPixels.frameCount);
    const savedFrameCount = await firstCanvas.getAttribute("data-frame-count");
    assert.ok(Number(savedFrameCount) > animatedPixels.frameCount, "the same animated mesh remains live while the author edits transforms");

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("已保存至项目 story.json 与 novel.assets.json。", { exact: true }).waitFor();
    const savedStory = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
    const savedMira = savedStory.script.start[0].characters.find((character: { id: string }) => character.id === "mira");
    assert.deepEqual(savedMira.position, { x: 146, y: 116 });
    assert.equal(savedMira.scale, 1.25);
    assert.equal(savedMira.layer, 2);

    const screenshotDirectory = join(repository, "sdk/.pocket-build/stage-spine-preview-20261108");
    mkdirSync(screenshotDirectory, { recursive: true });
    const stageScreenshot = join(screenshotDirectory, "edited-stage.png");
    await page.locator(".nv-authoring-stage").screenshot({ path: stageScreenshot });
    assert.ok(existsSync(stageScreenshot), "the real Spine and Ren stage composition is retained for visual review");

    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 60_000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const buildStatus = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/stage-spine-editor/status`)).json() as { builtRevision: number; revision: number };
    assert.equal(buildStatus.builtRevision, buildStatus.revision, "the saved Spine stage project must pass the Editor's pinned buildGuest pipeline");
    const artifactDirectory = join(workspace, "builds", "stage-spine-editor", String(buildStatus.builtRevision));
    const bytecodePath = join(artifactDirectory, "app.qjbc");
    const pakPath = join(artifactDirectory, "app.pak");
    const metadataPath = join(artifactDirectory, "app.bytecode.json");
    assert.ok(existsSync(bytecodePath) && existsSync(pakPath) && existsSync(metadataPath), "the isolated build must contain Guest QJBC, PAK, and metadata");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    const nativeProbe = join(repository, "sdk/.pocket-build/current-native-tools/bin/pocket_probe");
    assert.ok(existsSync(nativeProbe), `pinned pocket_probe is required: ${nativeProbe}`);
    const previousProbe = process.env.POCKET_NATIVE_PROBE;
    process.env.POCKET_NATIVE_PROBE = nativeProbe;
    try {
      nativeSession = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 45_000 });
      let frame = await nativeSession.boot();
      assert.ok((frame.ops ?? []).some(op => op.type === "text" && op.text === "启程 · 开始新的故事"), "the Guest must expose its real new-game input");
      frame = await nativeSession.tap("启程 · 开始新的故事", frame);
      frame = await nativeSession.settle(frame, 80);
      const modelTriangles = (value: { ops?: DrawOp[] }) => (value.ops ?? []).filter(op => op.type === "textureTriangle" && (op as DrawOp & { asset?: string }).asset?.includes("mira-"));
      const renOps = (value: { ops?: DrawOp[] }) => (value.ops ?? []).filter(op => (op.type === "image" || op.type === "textureTriangle") && (op as DrawOp & { asset?: string }).asset === "art/ren.png");
      const firstSceneTriangles = modelTriangles(frame);
      assert.ok(firstSceneTriangles.length > 10, `the built Guest must execute the official Spine model into native triangles; ops=${JSON.stringify((frame.ops ?? []).filter(op => op.type === "textureTriangle").slice(0, 2))}`);
      assert.ok(renOps(frame).length > 0, "the other visible actor must reach the same native frame");
      const modelPoints = firstSceneTriangles.flatMap(op => op.points ?? []);
      const modelBounds = {
        minX: Math.min(...modelPoints.map(point => point.x)), maxX: Math.max(...modelPoints.map(point => point.x)),
        minY: Math.min(...modelPoints.map(point => point.y)), maxY: Math.max(...modelPoints.map(point => point.y)),
      };
      assert.ok(modelBounds.minX >= 146 && modelBounds.minY >= 116, `Spine geometry must honor the saved authored position: ${JSON.stringify(modelBounds)}`);
      assert.ok(modelBounds.maxY > 500 && modelBounds.maxY - modelBounds.minY > 380, `Spine geometry must honor the saved 1.25 scale/rotation while the view clips at its right edge: ${JSON.stringify(modelBounds)}`);
      const firstMira = (frame.ops ?? []).findIndex(op => op.type === "textureTriangle" && (op as DrawOp & { asset?: string }).asset?.includes("mira-"));
      const lastRen = (frame.ops ?? []).findLastIndex(op => (op.type === "image" || op.type === "textureTriangle") && (op as DrawOp & { asset?: string }).asset === "art/ren.png");
      assert.ok(firstMira > lastRen && lastRen >= 0, "the built Guest must render the edited higher Mira layer after Ren");
      const initialModelGeometry = JSON.stringify(firstSceneTriangles.map(op => op.points));
      frame = await nativeSession.settle(frame, 45);
      assert.notEqual(JSON.stringify(modelTriangles(frame).map(op => op.points)), initialModelGeometry, "the native Guest's real animated Spine geometry must change while the authored scene is active");

      frame = await nativeSession.tapPoint({ x: 180, y: 470 });
      frame = await nativeSession.settle(frame, 20);
      const secondSceneTriangles = modelTriangles(frame);
      assert.ok(secondSceneTriangles.some(op => (op as DrawOp & { asset?: string }).asset?.includes("mira-hopeful.png")), "the second authored model intent must reach the Guest with its new skin");
      const secondFirstMira = (frame.ops ?? []).findIndex(op => op.type === "textureTriangle" && (op as DrawOp & { asset?: string }).asset?.includes("mira-"));
      const secondLastRen = (frame.ops ?? []).findLastIndex(op => (op.type === "image" || op.type === "textureTriangle") && (op as DrawOp & { asset?: string }).asset === "art/ren.png");
      assert.ok(secondFirstMira < secondLastRen && secondLastRen >= 0, "the second scene must honor its authored Ren-over-Mira draw order");

      frame = await nativeSession.tapPoint({ x: 180, y: 470 });
      frame = await nativeSession.settle(frame, 20);
      assert.equal(modelTriangles(frame).length, 0, "the hidden Mira must leave the Guest draw list after real input advances to the third scene");
    } finally {
      await nativeSession?.quit();
      nativeSession = undefined;
      if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    }

    await page.reload();
    await page.getByRole("button", { name: "舞台编辑", exact: true }).click();
    await page.getByLabel("舞台场景", { exact: true }).selectOption("0");
    const reopenedCanvas = page.locator('canvas[data-model-preview-character="mira"]');
    await reopenedCanvas.waitFor();
    await page.waitForFunction(() => Number(document.querySelector('canvas[data-model-preview-character="mira"]')?.getAttribute("data-frame-count")) >= 2);
    const reopened = await page.locator('.nv-authoring-character[data-character-id="mira"]').evaluate(element => ({
      left: parseFloat((element as HTMLElement).style.left),
      transform: (element as HTMLElement).style.transform,
      layer: (element as HTMLElement).style.zIndex,
    }));
    assert.ok(Math.abs(reopened.left - (146 / 360 * 100)) < 0.01);
    assert.match(reopened.transform, /scale\(1\.25\)/);
    assert.equal(reopened.layer, "2");

    await reopenedCanvas.evaluate(element => { (window as any).__sceneZeroCanvas = element; });
    await page.getByLabel("舞台场景", { exact: true }).selectOption("2");
    const secondCanvas = page.locator('canvas[data-model-preview-character="mira"]');
    await secondCanvas.waitFor();
    await page.waitForFunction(() => Number(document.querySelector('canvas[data-model-preview-character="mira"]')?.getAttribute("data-frame-count")) >= 2);
    const secondIsDistinct = await secondCanvas.evaluate(element => element !== (window as any).__sceneZeroCanvas);
    assert.equal(secondIsDistinct, true, "changing to a different authored animation/skin must dispose the old controller and create the new pose");
    const sceneZeroAfterDispose = await page.evaluate(() => {
      const canvas = (window as any).__sceneZeroCanvas as HTMLCanvasElement;
      return { frameCount: canvas.getAttribute("data-frame-count"), width: canvas.width, height: canvas.height };
    });
    assert.deepEqual([sceneZeroAfterDispose.width, sceneZeroAfterDispose.height], [0, 0], "disposing the prior scene must release its preview backing store");
    await page.waitForTimeout(120);
    const stoppedSceneZeroCanvas = await page.evaluate(() => (window as any).__sceneZeroCanvas.getAttribute("data-frame-count"));
    assert.equal(stoppedSceneZeroCanvas, sceneZeroAfterDispose.frameCount, "the prior scene's animation loop must stop after disposal");

    await secondCanvas.evaluate(element => { (window as any).__sceneOneCanvas = element; });
    await page.getByLabel("舞台场景", { exact: true }).selectOption("4");
    await page.locator('canvas[data-model-preview-character="mira"]').waitFor({ state: "detached" });
    const sceneOneAfterDispose = await page.evaluate(() => {
      const canvas = (window as any).__sceneOneCanvas as HTMLCanvasElement;
      return { frameCount: canvas.getAttribute("data-frame-count"), width: canvas.width, height: canvas.height };
    });
    assert.deepEqual([sceneOneAfterDispose.width, sceneOneAfterDispose.height], [0, 0], "hiding the model must release its preview backing store");
    await page.waitForTimeout(120);
    const stoppedSceneOneCanvas = await page.evaluate(() => (window as any).__sceneOneCanvas.getAttribute("data-frame-count"));
    assert.equal(stoppedSceneOneCanvas, sceneOneAfterDispose.frameCount, "hiding the model must stop its animation loop after disposal");
    await page.getByLabel("舞台场景", { exact: true }).selectOption("0");
    const activeBeforeTabExit = page.locator('canvas[data-model-preview-character="mira"]');
    await activeBeforeTabExit.waitFor();
    await page.waitForFunction(() => Number(document.querySelector('canvas[data-model-preview-character="mira"]')?.getAttribute("data-frame-count")) >= 2);
    await activeBeforeTabExit.evaluate(element => { (window as any).__stageExitCanvas = element; });
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.waitForTimeout(120);
    assert.equal(await page.locator("canvas[data-model-preview-character]").count(), 0, "leaving the stage editor must detach all model preview surfaces");
    const stageExitAfterDispose = await page.evaluate(() => {
      const canvas = (window as any).__stageExitCanvas as HTMLCanvasElement;
      return { frameCount: canvas.getAttribute("data-frame-count"), width: canvas.width, height: canvas.height };
    });
    assert.deepEqual([stageExitAfterDispose.width, stageExitAfterDispose.height], [0, 0], "leaving the stage editor must release the active preview backing store");
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => (window as any).__stageExitCanvas.getAttribute("data-frame-count")), stageExitAfterDispose.frameCount, "leaving the stage editor must stop the active animation loop");
    assert.deepEqual(pageErrors, [], "the real Spine stage preview must not raise browser errors");
  } finally {
    await nativeSession?.quit();
    await browser?.close();
    await server?.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
