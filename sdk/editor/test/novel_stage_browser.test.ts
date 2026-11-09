import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";
import { NativeSession, type DrawOp } from "../../../demo/js/tests/native_session.ts";
import { parsePakLayout } from "../../scripts/package_update.ts";

const repository = resolve(import.meta.dir, "../../..");
const source = join(repository, "demo/js/apps/lantern");
const story = {
  id: "stage-editor-test",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "room", characters: [
        { id: "mira", expression: "neutral", position: { x: 240, y: 116 }, visible: true },
        { id: "ren", expression: "neutral", position: "right", visible: true },
      ] },
      { type: "scene", characters: [{ id: "mira", expression: "neutral" }] },
      { type: "say", id: "stage-test-line", speaker: "Mira", text: "The native renderer receives these scene transforms." },
      { type: "ending", id: "stage-test-end", text: "Done." },
    ],
  },
};
const assets = {
  backgrounds: { room: "art/room.png" },
  characters: { mira: { neutral: "art/mira.png" }, ren: { neutral: "art/ren.png" } },
  cgs: {}, audio: {}, models: {},
};

test("real Chromium stage drag, transforms, layer order, undo/redo, save/reopen and Guest build", { timeout: 180_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-stage-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  mkdirSync(join(project, "art"), { recursive: true });
  mkdirSync(join(project, "assets", "audio"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json", "fonts.json"]) {
    cpSync(join(source, name), join(project, name));
  }
  cpSync(join(source, "fonts"), join(project, "fonts"), { recursive: true });
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  writeFileSync(join(project, "images.json"), JSON.stringify({ "art/room.png": { linear: true }, "art/mira.png": { linear: true }, "art/ren.png": { linear: true } }));
  writeFileSync(join(project, "app.tsx"), `import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import { Text, View } from "@pocketjs/framework/solid/components";
import storyDocument from "./story.json";
import assetsDocument from "./novel.assets.json";

function App() {
  const engine = createNovelEngine(storyDocument as StoryDefinition);
  const [actualStage, setActualStage] = createSignal("");
  onCleanup(() => engine.dispose());
  return <View class="relative w-full h-full"><NovelView engine={engine} assets={assetsDocument as NovelAssets} title="Stage Authoring Test" onNewGame={() => { engine.start(); setActualStage(JSON.stringify(engine.getSnapshot().stage)); }} /><View class="absolute left-0 top-0"><Text class="text-xs">{actualStage()}</Text></View></View>;
}

mount(App);
`);
  cpSync(join(source, "art/station.png"), join(project, "art/room.png"));
  cpSync(join(source, "art/mira-neutral.png"), join(project, "art/mira.png"));
  cpSync(join(source, "art/ren-neutral.png"), join(project, "art/ren.png"));
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "stage-editor", appId: "pocket.demo.lantern", name: "Stage Editor", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const errors: string[] = [];
  const browserEvents: string[] = [];
  const startedAt = Date.now();
  let phase = "editor navigation";
  let buildTimer: ReturnType<typeof setTimeout> | undefined;
  let buildTimerFired = false;
  const mark = (next: string): void => {
    phase = next;
    console.log(`[novel stage browser] ${next} +${Date.now() - startedAt}ms`);
  };
  const event = (message: string): void => browserEvents.push(`${message} +${Date.now() - startedAt}ms`);
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(15000);
  let nativeSession: NativeSession | undefined;
  page.on("pageerror", error => errors.push(error.message));
  page.on("close", () => event("editor page closed"));
  page.on("crash", () => event("editor page crashed"));
  page.on("requestfailed", request => event(`request failed ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`));
  browser.on("disconnected", () => event("browser disconnected"));
  const openSecondScene = async (): Promise<void> => {
    await page.getByRole("button", { name: "舞台编辑", exact: true }).click();
    await page.getByLabel("舞台场景", { exact: true }).selectOption("1");
    await page.locator('.nv-authoring-character[data-character-id="mira"]').waitFor();
    await page.locator('.nv-authoring-character[data-character-id="ren"]').waitFor();
  };
  const getPlacement = async (id: string): Promise<{ left: number; top: number; transform: string; z: string }> => {
    return await page.locator(`.nv-authoring-character[data-character-id="${id}"]`).evaluate(item => {
      const style = (item as HTMLElement).style;
      return { left: parseFloat(style.left), top: parseFloat(style.top), transform: style.transform, z: style.zIndex };
    });
  };
  const selectCharacter = async (id: string): Promise<void> => {
    await page.locator(`[data-character-choice="${id}"]`).click();
  };
  const editNumber = async (label: string, value: string): Promise<void> => {
    const field = page.getByLabel(label, { exact: true });
    await field.fill(value);
    await field.press("Tab");
  };

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=stage-editor`);
    assert.equal(response?.status(), 200);
    await openSecondScene();
    await page.getByText("由 Pocket VN 核心按故事实际路径推演至该场景之后。", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-authoring-stage img")].every(image => (image as HTMLImageElement).naturalWidth > 0));
    mark("editor loaded and stage images decoded");

    const beforeRen = await getPlacement("ren");
    const target = page.locator('.nv-authoring-character[data-character-id="ren"]');
    const targetBox = await target.boundingBox();
    const stageBox = await page.locator(".nv-authoring-stage").boundingBox();
    assert.ok(targetBox && stageBox, "selected character and stage have real browser geometry");
    const startX = Math.max(stageBox.x + 4, Math.min(stageBox.x + stageBox.width - 4, targetBox.x + targetBox.width * 0.5));
    const startY = Math.max(stageBox.y + 4, Math.min(stageBox.y + stageBox.height - 4, targetBox.y + targetBox.height * 0.5));
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let point = 1; point <= 12; point++) {
      await page.mouse.move(startX - point * 4, startY + point * 2, { steps: 2 });
    }
    await page.mouse.up();
    await page.waitForFunction(initial => {
      const item = document.querySelector('.nv-authoring-character[data-character-id="ren"]') as HTMLElement | null;
      return !!item && parseFloat(item.style.left) < initial - 5 && parseFloat(item.style.top) > 0;
    }, beforeRen.left);
    const movedRen = await getPlacement("ren");
    mark("dragged Ren on stage");

    await selectCharacter("mira");
    await editNumber("均匀缩放", "1.5");
    await page.waitForFunction(() => (document.querySelector('.nv-authoring-character[data-character-id="mira"]') as HTMLElement | null)?.style.transform.includes("scale(1.5)"));
    await editNumber("旋转 °", "23");
    await page.waitForFunction(() => (document.querySelector('.nv-authoring-character[data-character-id="mira"]') as HTMLElement | null)?.style.transform.includes("rotate(23deg)"));
    await page.getByRole("button", { name: "置于最前", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('.nv-authoring-character[data-character-id="mira"]') as HTMLElement | null)?.style.zIndex === "1");
    const transformedMira = await getPlacement("mira");
    assert.match(transformedMira.transform, /scale\(1\.5\)/);
    assert.match(transformedMira.transform, /rotate\(23deg\)/);
    assert.equal(transformedMira.z, "1");
    assert.ok(await page.locator(".nv-authoring-cast").evaluate(cast => cast.lastElementChild?.getAttribute("data-character-id") === "mira"), "shared orderedNovelCharacterIds places the raised layer last");

    // One pointer gesture has many browser move events, but exactly one undo
    // restores the complete Ren drag. The following three undos restore the
    // independent scale, rotation and layer actions.
    await clickNovelHistory(page, "undo");
    await openSecondScene();
    await selectCharacter("mira");
    assert.equal(await page.getByLabel("层级", { exact: true }).inputValue(), "0");
    await clickNovelHistory(page, "undo");
    await openSecondScene();
    await selectCharacter("mira");
    assert.equal(await page.getByLabel("旋转 °", { exact: true }).inputValue(), "0");
    await clickNovelHistory(page, "undo");
    await openSecondScene();
    await selectCharacter("mira");
    assert.equal(await page.getByLabel("均匀缩放", { exact: true }).inputValue(), "1");
    await clickNovelHistory(page, "undo");
    await openSecondScene();
    await selectCharacter("ren");
    const restoredRen = await getPlacement("ren");
    assert.equal(restoredRen.left, beforeRen.left);
    assert.equal(restoredRen.top, beforeRen.top);

    for (let index = 0; index < 4; index++) {
      await clickNovelHistory(page, "redo");
      await openSecondScene();
    }
    await selectCharacter("ren");
    const redoneRen = await getPlacement("ren");
    assert.ok(redoneRen.left < beforeRen.left - 5);
    assert.ok(redoneRen.top > beforeRen.top);
    await selectCharacter("mira");
    assert.equal(await page.getByLabel("均匀缩放", { exact: true }).inputValue(), "1.5");
    assert.equal(await page.getByLabel("旋转 °", { exact: true }).inputValue(), "23");
    assert.equal(await page.getByLabel("层级", { exact: true }).inputValue(), "1");

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByText("已保存至项目 story.json 与 novel.assets.json。", { exact: true }).waitFor();
    const saved = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
    const scene = saved.script.start[1];
    const mira = scene.characters.find((character: { id: string }) => character.id === "mira");
    const ren = scene.characters.find((character: { id: string }) => character.id === "ren");
    assert.deepEqual(mira, { id: "mira", expression: "neutral", scale: 1.5, rotation: 23, layer: 1 });
    const expectedRenX = Math.round((beforeRen.left * 3.6 - 48 * 360 / stageBox.width) * 10) / 10;
    const expectedRenY = Math.round((beforeRen.top * 6.4 + 24 * 640 / stageBox.height) * 10) / 10;
    assert.equal(ren.position.x, expectedRenX);
    assert.equal(ren.position.y, expectedRenY);

    await page.reload();
    await openSecondScene();
    await selectCharacter("mira");
    assert.equal(await page.getByLabel("均匀缩放", { exact: true }).inputValue(), "1.5");
    assert.equal(await page.getByLabel("旋转 °", { exact: true }).inputValue(), "23");
    assert.equal(await page.getByLabel("层级", { exact: true }).inputValue(), "1");
    const reopenedMira = await getPlacement("mira");
    assert.match(reopenedMira.transform, /scale\(1\.5\)/);
    assert.match(reopenedMira.transform, /rotate\(23deg\)/);
    assert.equal(reopenedMira.z, "1");
    await selectCharacter("ren");
    const reopenedRen = await getPlacement("ren");
    assert.equal(reopenedRen.left, movedRen.left);
    assert.equal(reopenedRen.top, movedRen.top);

    mark("transforms saved and reopened; arming Bun timer before Guest build");
    const buildTimerStartedAt = Date.now();
    buildTimer = setTimeout(() => {
      buildTimerFired = true;
      console.log(`[novel stage browser] independent Bun timer fired +${Date.now() - buildTimerStartedAt}ms; phase=${phase}; pageClosed=${page.isClosed()}`);
    }, 1000);
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    mark(`Guest build button click returned; timerFired=${buildTimerFired}`);
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 30000 });
    clearTimeout(buildTimer);
    buildTimer = undefined;
    mark(`Guest build notice visible; timerFired=${buildTimerFired}`);
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/stage-editor/status`)).json() as { builtRevision: number; revision: number };
    assert.equal(status.builtRevision, status.revision, "saved transforms went through the pinned buildGuest bytecode pipeline");
    mark("verified Guest build revision");

    // Run the exact QJBC created from the saved editor project through the
    // pinned native probe. This closes the authoring -> bytecode -> guest ->
    // native DrawList path for image geometry and z-order.
    const artifactDirectory = join(workspace, "builds", "stage-editor", String(status.builtRevision));
    const bytecodePath = join(artifactDirectory, "app.qjbc");
    const pakPath = join(artifactDirectory, "app.pak");
    const metadataPath = join(artifactDirectory, "app.bytecode.json");
    assert.ok(existsSync(bytecodePath) && existsSync(pakPath) && existsSync(metadataPath), "built revision must contain native Guest artifacts");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    const pakKeys = parsePakLayout(readFileSync(pakPath)).flatMap(part => part.kind === "blob" && part.key ? [part.key] : []);
    const nativeProbe = join(repository, "sdk/.pocket-build/current-native-tools/bin/pocket_probe");
    assert.ok(existsSync(nativeProbe), `pinned pocket_probe is required: ${nativeProbe}`);
    const previousProbe = process.env.POCKET_NATIVE_PROBE;
    process.env.POCKET_NATIVE_PROBE = nativeProbe;
    try {
      nativeSession = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 30_000 });
      mark("starting native Guest probe");
      let frame = await nativeSession.boot();
      mark("native Guest booted");
      assert.ok((frame.ops ?? []).some(op => op.type === "text" && op.text === "启程 · 开始新的故事"), "native title screen must render from the compiled guest");
      frame = await nativeSession.tap("启程 · 开始新的故事", frame);
      frame = await nativeSession.settle(frame, 80);
      mark("native title pointer advanced into transformed scene");
      const drawOps = frame.ops as Array<DrawOp & { asset?: string }>;
      const renOps = drawOps.filter(op => (op.type === "image" || op.type === "textureTriangle") && op.asset === "art/ren.png");
      const miraTriangles = drawOps.filter(op => op.type === "textureTriangle" && op.asset === "art/mira.png");
      assert.ok(renOps.length > 0, `edited Ren must reach native image geometry; scene=${JSON.stringify(scene)}; pak=${pakKeys.join(",")}; text=${drawOps.filter(op => op.type === "text").map(op => op.text).join(" | ")}; drawn=${JSON.stringify(drawOps.filter(op => op.type === "image" || op.type === "textureTriangle").map(op => ({ type: op.type, asset: op.asset, x: op.x, y: op.y, w: op.w, h: op.h, points: op.points })))}`);
      assert.ok(miraTriangles.length > 0, "edited Mira must reach native textured geometry");
      const renPosition = ren.position;
      const renImage = renOps.find(op => op.type === "image");
      if (renImage) {
        assert.ok(Math.abs((renImage.x ?? Number.NaN) - renPosition.x) <= 1 && Math.abs((renImage.y ?? Number.NaN) - renPosition.y) <= 1, "native Ren image must start at the editor-dragged position");
        assert.ok(Math.abs((renImage.w ?? Number.NaN) - 240) <= 1 && Math.abs((renImage.h ?? Number.NaN) - 350) <= 1, "native Ren image must keep the shared 240 × 350 quad");
      } else {
        assert.ok(renOps.some(op => op.points?.some(point => Math.abs(point.x - renPosition.x) <= 1 && Math.abs(point.y - renPosition.y) <= 1)), "native Ren geometry must start at the editor-dragged position");
      }
      const radians = 23 * Math.PI / 180;
      const miraBottomLeft = {
        x: 240 - Math.sin(radians) * 350 * 1.5,
        y: 116 + Math.cos(radians) * 350 * 1.5,
      };
      assert.ok(miraTriangles.some(op => op.points?.some(point => Math.abs(point.x - miraBottomLeft.x) <= 1 && Math.abs(point.y - miraBottomLeft.y) <= 1)), "native Mira image must use the saved uniform scale and rotation about the upper-left corner");
      const firstMira = drawOps.findIndex(op => op.type === "textureTriangle" && op.asset === "art/mira.png");
      const lastRen = drawOps.findLastIndex(op => (op.type === "image" || op.type === "textureTriangle") && op.asset === "art/ren.png");
      assert.ok(firstMira > lastRen && lastRen >= 0, "native draw order must put the edited Mira layer above Ren");
    } finally {
      await nativeSession?.quit();
      nativeSession = undefined;
      if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    }
    assert.deepEqual(errors, []);
    mark("native stage geometry assertions passed");
  } catch (error) {
    let persistedStatus = "unavailable: state file not written";
    try { persistedStatus = readFileSync(join(workspace, "states", "stage-editor.json"), "utf8"); }
    catch (value) { persistedStatus = `unavailable: ${value instanceof Error ? value.message : String(value)}`; }
    const notice = page.isClosed()
      ? "unavailable: page closed"
      : await page.locator("#novel-notice").innerText({ timeout: 1000 }).catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`);
    const status = await fetch(`http://127.0.0.1:${server.port}/api/projects/stage-editor/status`, { signal: AbortSignal.timeout(1000) })
      .then(response => response.text())
      .catch(value => `unavailable: ${value instanceof Error ? value.message : String(value)}`);
    const diagnostic = `${error instanceof Error ? error.message : String(error)}; phase=${phase}; pageClosed=${page.isClosed()}; browserEvents=${JSON.stringify(browserEvents)}; buildTimerFired=${buildTimerFired}; notice=${notice}; persistedStatus=${persistedStatus}; status=${status}; pageErrors=${JSON.stringify(errors)}`;
    console.error(`[novel stage browser] failure diagnostic: ${diagnostic}`);
    if (process.env.POCKET_VN_BROWSER_DIAGNOSTIC_HOLD === "1") await new Promise(resolve => setTimeout(resolve, 10_000));
    throw new Error(diagnostic);
  } finally {
    if (buildTimer) clearTimeout(buildTimer);
    await nativeSession?.quit();
    await browser.close();
    await server.stop(true);
    rmSync(project, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});
