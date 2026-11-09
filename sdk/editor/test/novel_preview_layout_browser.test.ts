import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

test("preview link opens an independent, responsive page and preserves story input", { timeout: 60000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-preview-layout-"));
  const project = join(temporary, "project");
  const id = "preview-layout";
  await mkdir(join(project, "art"), { recursive: true });
  const assetsRoot = resolve(import.meta.dir, "../../../demo/js/apps/lantern/art");
  for (const name of ["station.png", "mira-neutral.png", "ren-neutral.png"]) await copyFile(join(assetsRoot, name), join(project, "art", name));
  const story = { id, version: 1, start: "start", script: { start: [
    { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", position: "left", visible: true }, { id: "ren", expression: "neutral", position: "right", visible: true }] },
    { type: "say", id: "first", text: "完整画面里的第一封信。" },
    { type: "choice", id: "route", prompt: "回应来信", options: [{ id: "reply", text: "把信送回海港", target: "end" }] },
  ], end: [{ type: "ending", id: "arrival", text: "独立试玩抵达结局。" }] } };
  for (const [name, value] of Object.entries({
    "editor.json": { id, appId: "test.preview.layout", name: id, version: "0.1.0" },
    "pocket.json": { pocket: 2, id: "test.preview.layout", app: { entry: "app.tsx", framework: "solid" } },
    "manifest.json": { capabilities: { requires: [] } },
    "package.json": { type: "module" },
    "story.json": story,
    "novel.assets.json": { backgrounds: { station: "art/station.png" }, characters: { mira: { neutral: "art/mira-neutral.png" }, ren: { neutral: "art/ren-neutral.png" } }, cgs: {}, audio: {} },
  })) await writeFile(join(project, name), JSON.stringify(value));
  await writeFile(join(project, "app.tsx"), 'import { render } from "solid-js/web"; render(() => null, document.body);');
  const before = await readFile(join(project, "story.json"), "utf8");
  const server = await startEditor({ projectRoot: project, workspace: join(temporary, "workspace"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${id}`);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    const link = page.getByRole("link", { name: "在新页面打开试玩 ↗" });
    assert.equal(await link.getAttribute("target"), "_blank");
    const [play] = await Promise.all([context.waitForEvent("page"), link.click()]);
    await play.waitForLoadState();
    assert.equal(new URL(play.url()).searchParams.get("view"), "preview");
    await play.locator(".nv-preview-dialogue p").filter({ hasText: "完整画面里的第一封信。" }).waitFor();
    assert.equal(await play.locator(".nv-tabs").count(), 0);
    const screenshots = resolve(import.meta.dir, "../../.pocket-build/preview-layout-20261109");
    await mkdir(screenshots, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 800, height: 900 }, { width: 390, height: 844 }]) {
      await play.setViewportSize(viewport);
      await play.waitForTimeout(100);
      const facts = await play.evaluate(() => {
        const box = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        return { stage: box(".nv-stage-preview"), dialogue: box(".nv-preview-dialogue"), next: box("#novel-preview-advance"), pageWidth: document.documentElement.scrollWidth, viewport: innerWidth, characters: [...document.querySelectorAll(".nv-stage-character")].map(element => { const r = element.getBoundingClientRect(); return { width: r.width, height: r.height }; }) };
      });
      assert.ok(facts.stage.x >= 0 && facts.stage.right <= viewport.width + 1, JSON.stringify(facts));
      assert.ok(facts.stage.bottom <= viewport.height + 1, JSON.stringify(facts));
      assert.ok(facts.dialogue.x >= facts.stage.x && facts.dialogue.right <= facts.stage.right + 1);
      assert.ok(facts.dialogue.bottom <= facts.stage.bottom + 1);
      assert.ok(facts.next.y >= 0 && facts.next.bottom <= viewport.height);
      assert.ok(facts.pageWidth <= viewport.width + 1, "no horizontal document crop");
      assert.equal(facts.characters.length, 2);
      assert.ok(facts.characters.every(r => Math.abs(r.width / r.height - 240 / 350) < .01), "character aspect ratio survives landscape and portrait windows");
      await play.screenshot({ path: join(screenshots, `${viewport.width}x${viewport.height}.png`) });
      await writeFile(join(screenshots, `${viewport.width}x${viewport.height}.json`), JSON.stringify(facts, null, 2));
    }
    await play.getByRole("button", { name: "下一句", exact: true }).click();
    await play.getByRole("button", { name: "把信送回海港", exact: true }).click();
    await play.getByText("独立试玩抵达结局。", { exact: true }).waitFor();
    assert.equal(await readFile(join(project, "story.json"), "utf8"), before);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.stop(true); await rm(temporary, { recursive: true, force: true }); }
});
