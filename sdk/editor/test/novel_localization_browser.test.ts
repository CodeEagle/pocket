import { strict as assert } from "node:assert";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGuest } from "../../scripts/build_guest.ts";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";
import { chromium } from "playwright";
import { test } from "bun:test";
import { startEditor } from "../server.ts";

const projectId = "novel-locale-browser";
const story = {
  id: "browser-locale-story",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "greeting", speaker: "Mira", text: "Hello, {{name}}!" },
      { type: "choice", id: "route", prompt: "Where will you go, {{name}}?", options: [{ id: "harbor", text: "To the harbor", target: "end" }] },
    ],
    end: [{ type: "ending", id: "arrival", text: "Welcome to the harbor, {{name}}." }],
  },
};
const assets = {
  backgrounds: { station: "art/station.png", station_en: "art/station-en.png" },
  characters: { mira: { neutral: "art/mira.png", neutral_en: "art/mira-en.png" } },
  cgs: { memory: { image: "art/memory.png", title: "A memory" }, memory_en: { image: "art/memory-en.png", title: "A memory in English" } },
  audio: { theme: "audio/theme.wav", theme_en: "audio/theme-en.wav" },
};

test("browser edits, saves, exports, imports and locates missing translation keys without changing story.json", { timeout: 45000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-localization-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  await mkdir(join(project, "assets", "audio"), { recursive: true });
  await writeFile(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "dev.test.novel", name: projectId, version: "0.1.0" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.novel", name: projectId, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  await writeFile(join(project, "novel.locales.json"), `${JSON.stringify({ format: "pocket-vn-locales", formatVersion: 1, catalogs: {} }, null, 2)}\n`);
  const originalStory = await readFile(join(project, "story.json"), "utf8");
  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await page.goto(`${origin}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "文本本地化", exact: true }).click();
    await page.locator("#novel-localization-panel .nv-locale-workspace").waitFor();
    await page.getByLabel("新语言标签", { exact: true }).fill("en");
    await page.getByRole("button", { name: "添加语言", exact: true }).click();
    await page.getByLabel("对白 greeting", { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-locale-diagnostic code")].some(node => node.textContent === "lines.greeting"));

    const revisionBefore = (await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as any).revision;
    await page.locator(".nv-locale-diagnostic").filter({ hasText: "lines.greeting" }).click();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.localePath), "lines.greeting", "missing diagnostic should focus the corresponding field");
    await page.getByLabel("对白 greeting", { exact: true }).fill("Welcome, {{name}}!");
    await page.getByLabel("角色名 Mira", { exact: true }).fill("Mira");
    await page.getByLabel("选择问题 route", { exact: true }).fill("Where to, {{name}}?");
    await page.getByLabel("选项 route / harbor", { exact: true }).fill("To the harbor");
    await page.getByLabel("结局 arrival", { exact: true }).fill("Welcome, {{name}}.");
    await page.getByLabel("界面 player.menu", { exact: true }).fill("Journal");
    await page.getByLabel("背景替换 station", { exact: true }).selectOption("station_en");
    await page.waitForFunction(() => ![...document.querySelectorAll(".nv-locale-diagnostic code")].some(node => node.textContent === "lines.greeting"));
    const revisionAfterDiagnostics = (await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as any).revision;
    assert.equal(revisionAfterDiagnostics, revisionBefore, "draft diagnostics are read-only and do not bump the project revision");

    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "已保存");
    const saved = JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8"));
    assert.equal(saved.catalogs.en.lines.greeting, "Welcome, {{name}}!");
    assert.equal(saved.catalogs.en.choices.route.prompt, "Where to, {{name}}?");
    assert.equal(saved.catalogs.en.assets.backgrounds.station, "station_en");
    const revisionAfterSave = (await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as any).revision;
    assert.equal(revisionAfterSave, revisionBefore + 1, "canonical locale save must mark the project revision dirty");
    assert.equal(await readFile(join(project, "story.json"), "utf8"), originalStory, "translation editing must keep story.json unchanged");

    const [localeDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出当前语言", exact: true }).click(),
    ]);
    assert.equal(localeDownload.suggestedFilename(), "locale-en.json");
    const [collectionDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "导出全部语言", exact: true }).click(),
    ]);
    assert.equal(collectionDownload.suggestedFilename(), "novel.locales.json");

    const imported = JSON.parse(JSON.stringify(saved.catalogs.en));
    imported.lines.greeting = "Imported line, {{name}}!";
    await page.getByLabel("导入翻译 JSON", { exact: true }).setInputFiles({
      name: "locale-en.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported)),
    });
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "翻译已导入并保存");
    assert.equal(JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8")).catalogs.en.lines.greeting, "Imported line, {{name}}!");
    const revisionAfterImport = (await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as any).revision;
    assert.equal(revisionAfterImport, revisionAfterSave + 1);

    const savedBeforeRejectedImport = await readFile(join(project, "novel.locales.json"), "utf8");
    await page.getByLabel("导入翻译 JSON", { exact: true }).setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ format: "wrong-format", locale: "en" })),
    });
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent?.includes("导入文件必须"));
    assert.equal(await readFile(join(project, "novel.locales.json"), "utf8"), savedBeforeRejectedImport, "invalid import must leave the previous canonical file intact");
    assert.equal((await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as any).revision, revisionAfterImport);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
    server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("localized rich annotations survive repairs and selection editing into a real native Guest", { timeout: 180000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-localized-rich-browser-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const id = "novel-locale-rich-browser";
  const richStory = {
    id: "browser-locale-rich-story",
    version: 1,
    start: "start",
    script: { start: [
      { type: "say", id: "letter", speaker: "Mira", text: "The lantern returns.", rich: { spans: [{ id: "source-mark", start: 4, end: 11, style: { color: "accent" } }], pauses: [] } },
      { type: "ending", id: "arrival", text: "Welcome home." },
    ] },
  };
  const localeRich = { spans: [{ id: "translated-mark", start: 4, end: 10, style: { emphasis: "strong" } }], pauses: [] };
  const localeDocument = {
    format: "pocket-vn-locales",
    formatVersion: 1,
    catalogs: {
      en: {
        format: "pocket-vn-locale",
        formatVersion: 1,
        locale: "en",
        lines: { letter: "The Harbor Remembers." },
        sayRich: { letter: localeRich },
      },
    },
  };
  await mkdir(join(project, "assets", "audio"), { recursive: true });
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "dev.test.novel.locale.rich", name: id, version: "0.1.0" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.test.novel.locale.rich", name: id, app: { entry: "app.tsx", framework: "solid" } }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  const sdkRoot = resolve(import.meta.dir, "../..");
  await writeFile(join(project, "package.json"), JSON.stringify({
    type: "module",
    dependencies: { "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}` },
  }));
  await writeFile(join(project, "app.tsx"), 'import { render } from "solid-js/web";\nrender(() => null, document.body);\n');
  await writeFile(join(project, "story.json"), `${JSON.stringify(richStory, null, 2)}\n`);
  const gameAssets = { backgrounds: {}, characters: {}, cgs: {}, audio: {} };
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(gameAssets, null, 2)}\n`);
  await writeFile(join(project, "novel.locales.json"), `${JSON.stringify(localeDocument, null, 2)}\n`);
  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const openLocalization = async () => {
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "文本本地化", exact: true }).click();
    await page.locator("#novel-localization-panel .nv-locale-workspace").waitFor();
    await page.getByLabel("对白 letter", { exact: true }).waitFor();
  };
  try {
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${id}`);
    await openLocalization();
    assert.equal(await page.locator("[data-locale-rich-line='letter']").count(), 1, "the persisted translated annotation should be visible when reopened");
    await page.getByLabel("对白 letter", { exact: true }).fill("The Harbor Stays.");
    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "已保存");
    let saved = JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8"));
    assert.deepEqual(saved.catalogs.en.sayRich.letter, localeRich, "editing a translated line must keep its independent range annotation");
    assert.equal(saved.catalogs.en.lines.letter, "The Harbor Stays.");

    await page.reload();
    await openLocalization();
    assert.equal(await page.getByLabel("对白 letter", { exact: true }).inputValue(), "The Harbor Stays.");
    assert.deepEqual(JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8")).catalogs.en.sayRich.letter, localeRich, "save and reopen must preserve the catalog annotation");

    await page.getByLabel("对白 letter", { exact: true }).fill("Home");
    const richDiagnostic = page.locator(".nv-locale-diagnostic.error").filter({ hasText: "sayRich.letter" });
    await richDiagnostic.waitFor();
    assert.equal(await page.getByLabel("对白 letter", { exact: true }).inputValue(), "Home", "invalid offsets must not truncate or replace the user's translated text");
    await richDiagnostic.click();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.localePath), "lines.letter", "rich validation should focus the paired translated line");
    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent?.includes("catalog.sayRich.letter is invalid"));
    saved = JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8"));
    assert.equal(saved.catalogs.en.lines.letter, "The Harbor Stays.", "rejected invalid offsets must not partially save or discard the previous canonical document");
    assert.deepEqual(saved.catalogs.en.sayRich.letter, localeRich);

    await page.getByRole("button", { name: "清除此行译文注记，按纯文字翻译", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-locale-diagnostic code")].some(node => node.textContent === "sayRich.letter") && document.querySelector(".nv-locale-diagnostic.warning"));
    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "已保存");
    saved = JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8"));
    assert.equal(saved.catalogs.en.lines.letter, "Home");
    assert.equal(saved.catalogs.en.sayRich, undefined, "the explicit plain-text escape hatch should remove only the localized annotation");

    // Select translated Unicode scalars, independently of the source ranges.
    const translated = page.getByLabel("对白 letter", { exact: true });
    await translated.fill("海🌊 RETURN waits.");
    await translated.evaluate(element => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(4, 10); // RETURN after a supplementary-plane character.
      input.dispatchEvent(new Event("select", { bubbles: true }));
    });
    const translatedEditor = page.locator(".nv-locale-rich-editor").first();
    await translatedEditor.locator("[data-add-say-rich-span]").click();
    const span = translatedEditor.locator("[data-rich-span-id]");
    assert.equal(await span.getByLabel("开始字符（含）").inputValue(), "3");
    assert.equal(await span.getByLabel("结束字符（不含）").inputValue(), "9");
    await span.getByLabel("字重", { exact: true }).selectOption("strong");
    await span.getByLabel("文本颜色", { exact: true }).selectOption("accent");
    await span.getByLabel("注音（Ruby）", { exact: true }).fill("return");
    await span.getByRole("button", { name: "添加内部注释", exact: true }).click();
    await span.getByLabel("内部注释标题", { exact: true }).fill("Translator note");
    await span.getByLabel("内部注释正文", { exact: true }).fill("The translated signal asks for a reply.");
    await translated.evaluate(element => {
      const input = element as HTMLTextAreaElement;
      input.setSelectionRange(10, 10);
    });
    await translatedEditor.locator("[data-add-say-rich-pause]").click();
    const pause = translatedEditor.locator("[data-rich-pause-id]");
    assert.equal(await pause.getByLabel("停顿位置（Unicode 字符）").inputValue(), "9");
    await page.locator("#novel-localization-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-localization-save-state")?.textContent === "已保存");
    saved = JSON.parse(await readFile(join(project, "novel.locales.json"), "utf8"));
    const authored = saved.catalogs.en.sayRich.letter;
    assert.deepEqual(authored.spans[0], {
      id: authored.spans[0].id, start: 3, end: 9,
      style: { emphasis: "strong", color: "accent" }, ruby: "return",
      link: { title: "Translator note", text: "The translated signal asks for a reply." },
    });
    assert.deepEqual(authored.pauses, [{ id: authored.pauses[0].id, at: 9, durationMs: null }]);
    assert.deepEqual(JSON.parse(await readFile(join(project, "story.json"), "utf8")), richStory, "translated annotation editing never changes the source story");
    await page.reload();
    await openLocalization();
    assert.equal(await page.locator(".nv-locale-rich-editor").getByLabel("注音（Ruby）").inputValue(), "return");
    assert.equal(await page.locator(".nv-locale-rich-editor").getByLabel("内部注释正文").inputValue(), "The translated signal asks for a reply.");

    // Compile that exact saved catalog, rather than a separately authored approximation.
    await writeFile(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createNovelEngine, localizeStory } from "@pocket/vn";
import { NovelView } from "@pocket/vn/view";
import source from "./story.json";
import collection from "./novel.locales.json";
const localized = localizeStory(source, collection.catalogs, "en").story;
const engine = createNovelEngine(localized, { preferences: { mode: "manual", textSpeedCharsPerSecond: 0, autoDelayMs: 0, skipSeenOnly: false } });
function App() {
  return <NovelView engine={engine} assets={${JSON.stringify(gameAssets)}} title="Harbor letter" locale="en"
    ui={{ "title.start": "Start story", "panel.back": "Back", "player.resumeText": "Tap to continue reading", "player.reveal": "Reveal rest", "player.continue": "Continue line", "player.endingTitle": "Ending" }}
    onNewGame={() => engine.start()} />;
}
mount(() => <App />);
`);
    const built = await buildGuest({ projectRoot: project, outDir: join(temporary, "guest"), tickHz: 60, rasterDensity: 1 });
    const evidence = resolve(import.meta.dir, "../../.pocket-build/localized-rich-editor-20261109");
    const preservedGuest = join(evidence, "guest");
    await mkdir(preservedGuest, { recursive: true });
    await Promise.all([
      copyFile(built.bytecode, join(preservedGuest, "app.qjbc")),
      copyFile(built.pak, join(preservedGuest, "app.pak")),
      copyFile(built.metadata, join(preservedGuest, "app.bytecode.json")),
      copyFile(join(project, "story.json"), join(evidence, "story.json")),
      copyFile(join(project, "novel.locales.json"), join(evidence, "novel.locales.json")),
      copyFile(join(project, "novel.assets.json"), join(evidence, "novel.assets.json")),
      copyFile(join(project, "app.tsx"), join(evidence, "app.tsx")),
      copyFile(join(project, "package.json"), join(evidence, "package.json")),
    ]);
    const metadata = JSON.parse(await readFile(built.metadata, "utf8"));
    const native = new NativeSession({ bytecodePath: built.bytecode, pakPath: built.pak, metadataPath: built.metadata, runtimeAbi: metadata.runtimeAbi }, { width: 390, height: 600 });
    try {
      let frame = await native.settle(await native.boot(), 6);
      frame = await native.tap("Start story", frame);
      assert.ok(textOf(frame).includes("Tap to continue reading"), "the saved translation reaches its manual marker on the real NovelView");
      assert.ok(frame.ops?.some(op => op.text === "return"), "the saved translated ruby is drawn by Core");
      frame = await native.tap("RETURN", frame);
      assert.ok(textOf(frame).replace(/\s+/g, " ").includes("The translated signal asks for a reply."), "Core link geometry opens the translated note through real pointer input");
      frame = await native.tap("Back", frame);
      assert.ok(textOf(frame).includes("Tap to continue reading"), "closing the note preserves the local manual marker");
      frame = await native.tap("Tap to continue reading", frame);
      assert.ok(textOf(frame).includes("Reveal rest"), "releasing the local marker remains on the same translated line");
      frame = await native.tap("Reveal rest", frame);
      assert.ok(textOf(frame).includes("Continue line"), "revealing the remaining translated text does not advance the line");
      frame = await native.tap("Continue line", frame);
      assert.ok(textOf(frame).replace(/\s+/g, " ").includes("Welcome home."), "the next advance reaches the ending after the translated line");
    } finally { await native.quit(); }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
    server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
});
