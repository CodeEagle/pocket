import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { buildGuest } from "../../scripts/build_guest.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";

// Author-facing regression: diagnostics must describe the current unsaved
// document, including two different bad asset fields in the same instruction.
test("registry diagnostics track unsaved repairs, survive undo, and compile the repaired saved story", { timeout: 120_000 }, async () => {
  const root = resolve(import.meta.dir, "../../..");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-registry-diagnostics-browser-"));
  const project = join(temporary, "project");
  const projectId = "registry-draft-browser";
  mkdirSync(join(project, "art"), { recursive: true });
  copyFileSync(join(root, "demo/js/apps/lantern/art/station.png"), join(project, "art/station.png"));
  const story = { id: projectId, version: 1, start: "start", script: { start: [
    { type: "scene", background: "bad_background", objects: [{ id: "lamp", image: "bad_object", frame: { x: .1, y: .1, w: .2, h: .2 } }] },
    { type: "say", id: "line", voice: "bad_voice", text: "Registry repaired." },
    { type: "ending", id: "end", cg: "bad_cg", text: "Registry journey complete." },
  ] } };
  const assets = { backgrounds: { station: "art/station.png" }, characters: {}, audio: {}, cgs: { memory: { image: "art/station.png", title: "Memory" } } };
  for (const [file, value] of Object.entries({
    "editor.json": { id: projectId, appId: "dev.test.registry.draft", name: "Registry draft", version: "0.1.0", entry: "app.tsx" },
    "pocket.json": { pocket: 2, id: "dev.test.registry.draft", app: { entry: "app.tsx", framework: "solid" } },
    "manifest.json": { capabilities: { requires: [] } },
    "package.json": { type: "module", dependencies: { "@pocket/vn": `file:${join(root, "sdk/packages/pocket_vn")}` } },
    "story.json": story,
    "novel.assets.json": assets,
  })) writeFileSync(join(project, file), JSON.stringify(value, null, 2));
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { createNovelEngine } from "@pocket/vn";
import { NovelView } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";
const engine = createNovelEngine(story, { preferences: { textSpeedCharsPerSecond: 0 } });
mount(() => <NovelView engine={engine} assets={assets} title="Registry" onNewGame={() => engine.start()} ui={{"title.start":"Start registry", "player.reveal":"Reveal registry", "player.continue":"Continue registry"}} />);`);
  const server = await startEditor({ projectRoot: project, workspace: join(temporary, "workspace"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const url = `http://127.0.0.1:${server.port}/novel?project=${projectId}`;
    await page.goto(url);
    await page.locator(".nv-instruction").first().waitFor();
    for (const key of ["bad_background", "bad_object", "bad_voice", "bad_cg"]) {
      await page.waitForFunction(key => document.querySelector("#novel-diagnostics")?.textContent?.includes(key), key, { timeout: 5_000 });
    }
    expect(await page.locator("#novel-diagnostics .nv-diagnostic.error").count()).toBe(4);
    expect(await page.locator("#novel-diagnostics").innerText()).toContain("objects[0].image");
    await expect(buildGuest({ projectRoot: project, outDir: join(temporary, "bad") })).rejects.toThrow(/Unknown/);
    const initial = readFileSync(join(project, "story.json"), "utf8");
    const scene = page.locator(".nv-instruction").nth(0);
    await scene.locator("label.nv-field").filter({ hasText: "背景键" }).first().locator("input").fill("station");
    await scene.locator("[data-scene-objects-json]").fill("[]");
    await page.locator(".nv-instruction").nth(1).locator("label.nv-field").filter({ hasText: "语音 Cue" }).locator("select").selectOption("");
    await page.locator(".nv-instruction").nth(2).locator("label.nv-field").filter({ hasText: "CG 键" }).locator("input").fill("memory");
    await page.waitForFunction(() => !document.querySelector("#novel-diagnostics .nv-diagnostic.error"));
    expect(readFileSync(join(project, "story.json"), "utf8")).toBe(initial);
    await clickNovelHistory(page, "undo");
    await page.waitForFunction(() => document.querySelector("#novel-diagnostics")?.textContent?.includes("bad_cg"));
    await clickNovelHistory(page, "redo");
    await page.waitForFunction(() => !document.querySelector("#novel-diagnostics .nv-diagnostic.error"));
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    expect(await page.locator("#novel-diagnostics .nv-diagnostic.error").count()).toBe(0);
    const built = await buildGuest({ projectRoot: project, outDir: join(temporary, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8"));
    const native = new NativeSession({ bytecodePath: built.bytecode, pakPath: built.pak, metadataPath: built.metadata, runtimeAbi: metadata.runtimeAbi }, { width: 390, height: 844 });
    try {
      let frame = await native.settle(await native.boot(), 8);
      frame = await native.tap("Start registry", frame);
      frame = await native.settle(frame, 90);
      expect(textOf(frame)).toContain("Registry repaired.");
      frame = await native.tap("Continue registry", frame);
      expect(textOf(frame)).toContain("Registry journey complete.");
    } finally { await native.quit(); }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
