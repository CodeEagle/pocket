import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";

test("Chromium authors video cues, keeps the shared image skin, saves/reopens, rejects invalid values, and builds the same cue", { timeout: 180_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const sourceVideo = join(repository, "demo/js/assets/videos/clip-a.mp4");
  const temporary = await mkdtemp(join(tmpdir(), "pocket-video-editor-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const output = join(temporary, "build");
  const runtimeAssets = join(temporary, "runtime-assets");
  const id = "video-authoring";
  await mkdir(project, { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    await cp(join(source, name), join(project, name), { recursive: true });
  }
  await mkdir(join(project, "art/ui"), { recursive: true });
  await mkdir(join(project, "assets/video"), { recursive: true });
  await cp(join(source, "art/ui/harbor-frame.png"), join(project, "art/ui/harbor-frame.png"));
  await cp(sourceVideo, join(project, "assets/video/loop.mp4"));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.video-authoring", name: id, version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  await writeFile(join(project, "story.json"), JSON.stringify({
    id, version: 1, start: "start", author: { note: "Keep author metadata" }, script: {
      start: [
        { type: "video", action: "play", cue: "atmosphere", loop: true, authorData: { retained: true } },
        { type: "ending", id: "end", text: "Done." },
      ],
    },
  }, null, 2));
  const skin = { frame: { image: "art/ui/harbor-frame.png", width: 512, height: 512, inset: 122 } };
  const initialAssets = { backgrounds: {}, characters: {}, cgs: {}, audio: {}, videos: { atmosphere: "video/loop.mp4" }, skin };
  await writeFile(join(project, "novel.assets.json"), JSON.stringify(initialAssets, null, 2));
  await writeFile(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import story from "./story.json";
function App() {
  const engine = createNovelEngine(story as StoryDefinition);
  engine.start();
  return <View><Text>{String(engine.getSnapshot().stage.video?.cue ?? "")}</Text></View>;
}
mount(App);
`);

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  const pageErrors: string[] = [];
  page.setDefaultTimeout(15_000);
  page.on("pageerror", error => pageErrors.push(error.message));
  const origin = `http://127.0.0.1:${server.port}`;
  const base = `/api/projects/${id}/novel`;
  const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(join(project, path), "utf8"));
  try {
    await page.goto(`${origin}/novel?project=${id}`);
    await page.locator(".nv-instruction").first().waitFor();

    for (const action of ["pause", "close", "seek", "play"] as const) {
      await page.getByLabel("视频动作", { exact: true }).selectOption(action);
      if (action === "seek") {
        const position = page.getByLabel("定位毫秒", { exact: true });
        await position.fill("1250");
        await position.press("Tab");
        assert.equal(await page.getByLabel("稳定视频 cue", { exact: true }).count(), 0);
      }
      if (action === "pause" || action === "close") {
        assert.equal(await page.getByLabel("定位毫秒", { exact: true }).count(), 0);
        assert.equal(await page.getByLabel("稳定视频 cue", { exact: true }).count(), 0);
      }
    }
    assert.equal(await page.getByLabel("稳定视频 cue", { exact: true }).inputValue(), "atmosphere");
    assert.equal(await page.getByLabel("循环播放", { exact: true }).isChecked(), false);
    await page.getByLabel("循环播放", { exact: true }).check();
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("循环播放", { exact: true }).isChecked(), false);
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("循环播放", { exact: true }).isChecked(), true);

    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    page.once("dialog", dialog => dialog.accept("archive_clip"));
    await page.getByRole("button", { name: "＋ 添加视频 cue", exact: true }).click();
    const paths = page.getByLabel("assets/ 下相对视频路径", { exact: true });
    await paths.last().fill("video/loop.mp4");
    await paths.last().press("Tab");
    await clickNovelHistory(page, "undo");
    assert.equal(await paths.last().inputValue(), "");
    await clickNovelHistory(page, "redo");
    assert.equal(await paths.last().inputValue(), "video/loop.mp4");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const firstSavedAssets = await readJson("novel.assets.json");
    assert.deepEqual(firstSavedAssets.videos, { atmosphere: "video/loop.mp4", archive_clip: "video/loop.mp4" });
    assert.deepEqual(firstSavedAssets.skin, skin, "editing video cues must preserve the shared image skin");

    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    assert.deepEqual(await readJson("novel.assets.json").then((value: any) => value.skin), skin);
    assert.equal(await page.getByLabel("assets/ 下相对视频路径", { exact: true }).count(), 2);
    await page.locator(".nv-asset-group").filter({ has: page.getByRole("heading", { name: "视频 cue", exact: true }) }).locator(".nv-asset-row").last().getByRole("button", { name: "移除", exact: true }).click();
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const savedAssets = await readJson("novel.assets.json");
    assert.deepEqual(savedAssets.videos, { atmosphere: "video/loop.mp4" });
    assert.deepEqual(savedAssets.skin, skin);
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    assert.equal(await page.getByLabel("稳定视频 cue", { exact: true }).inputValue(), "atmosphere");

    const savedStory = await readJson("story.json");
    assert.deepEqual(savedStory.author, { note: "Keep author metadata" });
    assert.deepEqual(savedStory.script.start[0], { type: "video", action: "play", cue: "atmosphere", loop: true, authorData: { retained: true } });
    for (const invalid of [
      { ...savedStory, script: { start: [{ type: "video", action: "seek", positionMs: 1.5 }, savedStory.script.start[1]] } },
    ]) {
      const response = await fetch(`${origin}${base}/story`, { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(invalid) });
      assert.equal(response.status, 422);
      assert.deepEqual(await readJson("story.json"), savedStory);
    }
    const danglingCueStory = structuredClone(savedStory);
    danglingCueStory.script.start[0].cue = "unregistered_cue";
    const danglingCueResponse = await fetch(`${origin}${base}/story`, { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(danglingCueStory) });
    assert.equal(danglingCueResponse.status, 200);
    const danglingCueResult = await danglingCueResponse.json();
    assert.ok(danglingCueResult.validation.diagnostics.some((item: any) => item.code === "assets.reference" && item.location?.field === "video cue"));
    assert.equal((await fetch(`${origin}${base}/story`, { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(savedStory) })).status, 200);
    assert.deepEqual(await readJson("story.json"), savedStory);
    for (const invalid of [
      { ...savedAssets, skin: { frame: { ...skin.frame, inset: 627 } } },
      { ...savedAssets, skin: { ...skin, button: { image: "art/ui/harbor-frame.png" } } },
      { ...savedAssets, videos: { atmosphere: "video/loop.webm", archive_clip: "video/loop.mp4" } },
    ]) {
      const response = await fetch(`${origin}${base}/assets`, { method: "PUT", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify(invalid) });
      assert.equal(response.status, 422);
      assert.deepEqual(await readJson("novel.assets.json"), savedAssets);
    }

    const runtimeFile = join(temporary, "runtime.mjs");
    const runtimeResponse = await fetch(`${origin}${base}/runtime.js`);
    assert.equal(runtimeResponse.status, 200);
    await writeFile(runtimeFile, await runtimeResponse.text());
    const runtime = await import(pathToFileURL(runtimeFile).href);
    const engine = runtime.createNovelEngine(savedStory);
    try {
      engine.start();
      assert.deepEqual(engine.getSnapshot().stage.video, {
        cue: "atmosphere", loop: true, positionMs: 0, durationMs: null, status: "playing",
      });
      assert.equal(engine.getSnapshot().active.kind, "ending");
    } finally { engine.dispose(); }

    const built = await buildGuest({ projectRoot: project, outDir: output, copyAssetsTo: runtimeAssets, tickHz: 60 });
    assert.ok(existsSync(built.bytecode), "the saved story compiled through the pinned Guest QJBC pipeline");
    assert.deepEqual(await readFile(join(runtimeAssets, "video/loop.mp4")), await readFile(sourceVideo), "buildGuest must copy the exact project-relative video under its assets/ key");
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
