import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

const projectId = "novel-history-test";
const story = {
  id: "test.history",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "scene", background: "room", characters: [{ id: "mira", expression: "neutral", position: "center" }], transition: { kind: "fade", durationMs: 120 } },
      { type: "say", id: "line", speaker: "Mira", text: "Original dialogue" },
      { type: "ending", id: "end", text: "The end", cg: "memory" },
    ],
  },
};
const assets = {
  backgrounds: { room: "art/room.png" },
  characters: { mira: { neutral: "art/mira.png" } },
  cgs: { memory: { image: "art/memory.png", title: "Memory" } },
  audio: {},
};
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("novel editor groups field typing, undoes/redoes canonical story and assets, then previews real images and timed core", { timeout: 45_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-browser-history-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  await mkdir(join(project, "art"), { recursive: true });
  await mkdir(join(project, "assets", "audio"), { recursive: true });
  await writeFile(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "dev.test.novel", name: projectId, title: "Editor History", version: "0.1.0" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.novel", name: projectId, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  for (const name of ["room.png", "mira.png", "memory.png", "room-updated.png"]) await writeFile(join(project, "art", name), tinyPng);

  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();
    assert.equal(await page.locator(".nv-instruction").count(), 3, "the first render must show every instruction in its detached label list");

    const dialogue = page.locator("label.nv-field").filter({ hasText: "对白文本" }).locator("textarea");
    assert.equal(await dialogue.inputValue(), "Original dialogue");
    await dialogue.fill("E");
    await dialogue.press("End");
    await dialogue.type("dited dialogue");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.locator("label.nv-field").filter({ hasText: "对白文本" }).locator("textarea").inputValue(), "Original dialogue");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.locator("label.nv-field").filter({ hasText: "对白文本" }).locator("textarea").inputValue(), "Edited dialogue");
    await page.locator("#novel-save").click();
    await page.getByText("已保存至项目 story.json 与 novel.assets.json。", { exact: true }).waitFor();
    assert.equal(JSON.parse(await readFile(join(project, "story.json"), "utf8")).script.start[1].text, "Edited dialogue");

    await page.getByRole("button", { name: "视觉与音频资源" }).click();
    const imagePath = page.locator("label.nv-field").filter({ hasText: "项目相对图片路径" }).first().locator("input");
    assert.equal(await imagePath.inputValue(), "art/room.png");
    await imagePath.fill("art/room-updated.png");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.locator("label.nv-field").filter({ hasText: "项目相对图片路径" }).first().locator("input").inputValue(), "art/room.png");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.locator("label.nv-field").filter({ hasText: "项目相对图片路径" }).first().locator("input").inputValue(), "art/room-updated.png");
    await page.locator("#novel-save").click();
    await page.getByText("已保存至项目 story.json 与 novel.assets.json。", { exact: true }).waitFor();
    assert.equal(JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8")).backgrounds.room, "art/room-updated.png");

    await page.getByRole("button", { name: "试玩与调试" }).click();
    await page.getByRole("button", { name: "运行 / 重新开始" }).click();
    await page.waitForFunction(() => {
      const background = document.querySelector(".nv-stage-background");
      const character = document.querySelector(".nv-stage-character-image");
      return background instanceof HTMLImageElement && background.naturalWidth > 0 && character instanceof HTMLImageElement && character.naturalWidth > 0;
    });
    assert.equal(await page.locator("#novel-preview-location").textContent(), "start:1");
    await page.locator("#novel-preview-pause").click();
    await page.getByText("单步继续", { exact: true }).waitFor();
    await page.locator("#novel-preview-pause").click();
    await page.getByRole("button", { name: "单步到下一阻塞点" }).click();
    await page.locator(".nv-preview-ending").waitFor();
    await page.waitForFunction(() => {
      const image = document.querySelector(".nv-preview-cg");
      return image instanceof HTMLImageElement && image.naturalWidth > 0;
    });
    assert.deepEqual(pageErrors, []);
  } finally {
    await page.close();
    await browser.close();
    server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
