import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

test("camera editor preserves metadata through undo, save, and reload", { timeout: 90_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-camera-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "camera-author";
  mkdirSync(project, { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    cpSync(join(source, name), join(project, name), { recursive: true });
  }
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "pocket.demo.lantern", name: "Camera Authoring", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
  writeFileSync(join(project, "images.json"), "{}\n");
  const story = {
    id: projectId,
    version: 1,
    start: "start",
    author: { name: "Retained author metadata", custom: { source: "editor-camera-test" } },
    script: {
      start: [
        {
          type: "scene",
          camera: { x: 20, y: -8, scale: 1.25, authorCameraNote: { keep: true } },
          cameraMotion: {
            durationMs: 800,
            easing: "easeInOut",
            shake: { amplitude: 9, cycles: 2, authorShakeNote: "keep too" },
            authorMotionNote: { source: "hand-authored" },
          },
          authorSceneNote: { keep: ["old", "keys"] },
        },
        { type: "scene", authorLegacySceneNote: "No explicit camera must stay absent." },
        { type: "ending", id: "done", text: "Done." },
      ],
    },
  };
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";
function App() {
  const host = createHostBridge();
  const engine = createNovelEngine(story as StoryDefinition);
  onCleanup(() => { engine.dispose(); host.dispose(); });
  return <NovelView host={host} engine={engine} assets={assets as NovelAssets} title="Camera Authoring" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const readStory = () => JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
  const firstSceneField = (label: string) => page.locator(".nv-instruction").first().getByLabel(label, { exact: true });

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await firstSceneField("镜头平移 X (px)").waitFor();
    assert.equal(await firstSceneField("镜头平移 X (px)").inputValue(), "20");
    assert.equal(await firstSceneField("镜头平移 Y (px)").inputValue(), "-8");
    assert.equal(await firstSceneField("镜头缩放").inputValue(), "1.25");
    assert.equal(await firstSceneField("镜头过渡时长 (ms)").inputValue(), "800");
    assert.equal(await firstSceneField("抖动幅度 (px)").inputValue(), "9");

    const edit = async (label: string, value: string) => {
      const field = firstSceneField(label);
      await field.fill(value);
      await field.press("Tab");
    };
    await edit("镜头平移 X (px)", "77.25");
    await edit("镜头过渡时长 (ms)", "1200");
    await edit("抖动幅度 (px)", "24");

    await clickNovelHistory(page, "undo");
    assert.equal(await firstSceneField("抖动幅度 (px)").inputValue(), "9");
    await clickNovelHistory(page, "undo");
    assert.equal(await firstSceneField("镜头过渡时长 (ms)").inputValue(), "800");
    await clickNovelHistory(page, "undo");
    assert.equal(await firstSceneField("镜头平移 X (px)").inputValue(), "20");

    await clickNovelHistory(page, "redo");
    await clickNovelHistory(page, "redo");
    await clickNovelHistory(page, "redo");
    assert.equal(await firstSceneField("镜头平移 X (px)").inputValue(), "77.25");
    assert.equal(await firstSceneField("镜头过渡时长 (ms)").inputValue(), "1200");
    assert.equal(await firstSceneField("抖动幅度 (px)").inputValue(), "24");

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = readStory();
    const editedScene = saved.script.start[0];
    assert.deepEqual(editedScene.camera, { x: 77.25, y: -8, scale: 1.25, authorCameraNote: { keep: true } });
    assert.deepEqual(editedScene.cameraMotion, {
      durationMs: 1200,
      easing: "easeInOut",
      shake: { amplitude: 24, cycles: 2, authorShakeNote: "keep too" },
      authorMotionNote: { source: "hand-authored" },
    });
    assert.deepEqual(editedScene.authorSceneNote, { keep: ["old", "keys"] });
    assert.deepEqual(saved.author, story.author);
    assert.equal(Object.hasOwn(saved.script.start[1], "camera"), false, "opening and saving a legacy scene must not materialize default camera data");

    await page.reload();
    await firstSceneField("镜头平移 X (px)").waitFor();
    assert.equal(await firstSceneField("镜头平移 X (px)").inputValue(), "77.25");
    assert.equal(await firstSceneField("镜头过渡时长 (ms)").inputValue(), "1200");
    assert.equal(await firstSceneField("镜头缓动").inputValue(), "easeInOut");
    assert.equal(await firstSceneField("抖动幅度 (px)").inputValue(), "24");
    assert.deepEqual(readStory(), saved);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop();
    rmSync(temporary, { recursive: true, force: true });
  }
});
