import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { parsePakLayout } from "../../scripts/package_update.ts";
import { startEditor } from "../server.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";

test("Editor authors one shared image skin, previews real pixels, preserves undo/save semantics and bundles the saved frame", async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const frameImage = join(source, "art/ui/harbor-frame.png");
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-skin-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const output = join(temporary, "build");
  const id = "skin-authoring";
  await mkdir(join(project, "art/ui"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    await cp(join(source, name), join(project, name), { recursive: true });
  }
  await cp(frameImage, join(project, "art/ui/harbor-frame.png"));
  await cp(frameImage, join(project, "art/ui/accent-frame.png"));
  await cp(frameImage, join(project, "art/ui/icons.png"));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.skin-authoring", name: id, version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  await writeFile(join(project, "images.json"), JSON.stringify({
    "art/ui/harbor-frame.png": { linear: true },
    "art/ui/accent-frame.png": { linear: true },
    "art/ui/icons.png": { linear: true },
  }));
  await writeFile(join(project, "story.json"), JSON.stringify({ id, version: 1, start: "start", script: { start: [{ type: "ending", id: "end", text: "Done." }] } }, null, 2));
  const legacyAssets = { backgrounds: {}, characters: {}, cgs: {}, audio: {}, models: {} };
  await writeFile(join(project, "novel.assets.json"), JSON.stringify(legacyAssets, null, 2));
  await writeFile(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
import { NovelSkinFrame } from "@pocket/vn/skin-view";
import assetsDocument from "./novel.assets.json";
function App() {
  const frame = assetsDocument.skin.frame;
  return <View class="relative w-full h-full bg-slate-900"><NovelSkinFrame frame={frame} width={360} height={180} border={32} debugName="game-frame" /></View>;
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
  const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(join(project, path), "utf8"));
  try {
    await page.goto(`${origin}/novel?project=${id}`);
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    await page.getByText("不会回退到 App 组件的默认皮肤。未添加时旧项目保持原样。", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("frame 图片项目相对路径", { exact: true }).count(), 0);
    assert.deepEqual(await readJson("novel.assets.json"), legacyAssets, "opening a legacy project must not add an empty skin");
    const traversalPreview = await fetch(`${origin}/novel/resource?${new URLSearchParams({ project: id, kind: "skin", path: "../package.json" })}`);
    assert.equal(traversalPreview.status, 404, "skin previews retain the project-local registered image boundary");

    await page.getByRole("button", { name: "＋ 添加 frame 图片", exact: true }).click();
    const imagePath = page.getByLabel("frame 图片项目相对路径", { exact: true });
    await imagePath.fill("art/ui/missing.png");
    await imagePath.press("Tab");
    await page.getByText("无法预览：请确认路径指向项目内已存在、无符号链接的 PNG/SVG 图片。", { exact: true }).waitFor();
    await imagePath.fill("art/ui/harbor-frame.png");
    await imagePath.press("Tab");
    const preview = page.getByAltText("游戏界面皮肤 frame 图片预览");
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="游戏界面皮肤 frame 图片预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 512 && image.naturalHeight === 512;
    });
    assert.equal(await preview.isVisible(), true);
    assert.match(await page.locator(".nv-model-preview-status").filter({ hasText: "图片实际尺寸" }).textContent() ?? "", /512 × 512/);
    await page.getByRole("button", { name: "使用图片实际尺寸", exact: true }).click();
    const width = page.getByLabel("图片宽度（实际源像素）", { exact: true });
    const height = page.getByLabel("图片高度（实际源像素）", { exact: true });
    const inset = page.getByLabel("四边 inset（源像素）", { exact: true });
    assert.equal(await width.inputValue(), "512");
    assert.equal(await height.inputValue(), "512");
    await width.fill("512.5");
    await width.press("Tab");
    assert.equal(await width.getAttribute("aria-invalid"), "true", "fractional source dimensions are rejected by the numeric field");
    await width.fill("512");
    await width.press("Tab");
    await inset.fill("122");
    await inset.press("Tab");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("四边 inset（源像素）", { exact: true }).inputValue(), "0");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("四边 inset（源像素）", { exact: true }).inputValue(), "122");

    await page.getByRole("button", { name: "＋ 添加 accentFrame", exact: true }).click();
    const accentPath = page.getByLabel("accentFrame 图片项目相对路径", { exact: true });
    await accentPath.fill("art/ui/accent-frame.png");
    await accentPath.press("Tab");
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="游戏界面皮肤 accentFrame 图片预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 512 && image.naturalHeight === 512;
    });
    await page.getByRole("button", { name: "使用 accentFrame 图片实际尺寸", exact: true }).click();
    await page.getByLabel("accentFrame 四边 inset（源像素）", { exact: true }).fill("96");
    await page.getByLabel("accentFrame 四边 inset（源像素）", { exact: true }).press("Tab");

    await page.getByRole("button", { name: "＋ 添加图标图集", exact: true }).click();
    const iconsPath = page.getByLabel("icons 图集图片项目相对路径", { exact: true });
    await iconsPath.fill("art/ui/icons.png");
    await iconsPath.press("Tab");
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="游戏界面皮肤 icons 图集图片预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 512 && image.naturalHeight === 512;
    });
    await page.getByRole("button", { name: "使用图标图集图片实际尺寸", exact: true }).click();
    await page.getByLabel("图标网格列数", { exact: true }).fill("2");
    await page.getByLabel("图标网格列数", { exact: true }).press("Tab");
    await page.getByLabel("图标网格行数", { exact: true }).fill("1");
    await page.getByLabel("图标网格行数", { exact: true }).press("Tab");
    await page.getByLabel("图标 ID 1", { exact: true }).fill("start");
    await page.getByLabel("图标 ID 1", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "＋ 添加图标名", exact: true }).click();
    await page.getByLabel("图标 ID 2", { exact: true }).fill("journal");
    await page.getByLabel("图标 ID 2", { exact: true }).press("Tab");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("图标 ID 2", { exact: true }).inputValue(), "icon_2");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("图标 ID 2", { exact: true }).inputValue(), "journal");

    await page.getByLabel("四边 inset（源像素）", { exact: true }).fill("256");
    await page.getByLabel("四边 inset（源像素）", { exact: true }).press("Tab");
    await page.locator("#novel-save").click();
    await page.getByText(/skin requires frame/).waitFor();
    assert.deepEqual(await readJson("novel.assets.json"), legacyAssets, "the shared skin validator rejects an invalid inset atomically");
    await page.getByLabel("四边 inset（源像素）", { exact: true }).fill("122");
    await page.getByLabel("四边 inset（源像素）", { exact: true }).press("Tab");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const savedAssets = await readJson("novel.assets.json");
    const expectedSkin = {
      frame: { image: "art/ui/harbor-frame.png", width: 512, height: 512, inset: 122 },
      accentFrame: { image: "art/ui/accent-frame.png", width: 512, height: 512, inset: 96 },
      icons: { image: "art/ui/icons.png", width: 512, height: 512, columns: 2, rows: 1, names: ["start", "journal"] },
    };
    assert.deepEqual(savedAssets.skin, expectedSkin);

    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    assert.equal(await page.getByLabel("frame 图片项目相对路径", { exact: true }).inputValue(), "art/ui/harbor-frame.png");
    assert.equal(await page.getByLabel("图片宽度（实际源像素）", { exact: true }).inputValue(), "512");
    assert.equal(await page.getByLabel("图片高度（实际源像素）", { exact: true }).inputValue(), "512");
    assert.equal(await page.getByLabel("四边 inset（源像素）", { exact: true }).inputValue(), "122");
    await page.waitForFunction(() => (document.querySelector('img[alt="游戏界面皮肤 frame 图片预览"]') as HTMLImageElement | null)?.naturalWidth === 512);
    assert.equal(await page.getByLabel("accentFrame 图片项目相对路径", { exact: true }).inputValue(), "art/ui/accent-frame.png");
    assert.equal(await page.getByLabel("accentFrame 图片宽度（实际源像素）", { exact: true }).inputValue(), "512");
    assert.equal(await page.getByLabel("accentFrame 四边 inset（源像素）", { exact: true }).inputValue(), "96");
    assert.equal(await page.getByLabel("icons 图集图片项目相对路径", { exact: true }).inputValue(), "art/ui/icons.png");
    assert.equal(await page.getByLabel("图标网格列数", { exact: true }).inputValue(), "2");
    assert.equal(await page.getByLabel("图标网格行数", { exact: true }).inputValue(), "1");
    assert.equal(await page.getByLabel("图标 ID 1", { exact: true }).inputValue(), "start");
    assert.equal(await page.getByLabel("图标 ID 2", { exact: true }).inputValue(), "journal");

    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    assert.ok(built.bytecode && built.pak, "saved image skin must build through the pinned Guest pipeline");
    const pakKeys = parsePakLayout(await readFile(built.pak)).flatMap(part => part.kind === "blob" && part.key ? [part.key] : []);
    assert.ok(pakKeys.includes("ui:img.art/ui/harbor-frame.png"), `the registered skin frame must be present in the Guest PAK; keys=${pakKeys.join(",")}`);
    assert.ok(pakKeys.includes("ui:img.art/ui/accent-frame.png"), `the registered accent frame must be present in the Guest PAK; keys=${pakKeys.join(",")}`);
    assert.ok(pakKeys.includes("ui:img.art/ui/icons.png"), `the registered icon atlas must be present in the Guest PAK; keys=${pakKeys.join(",")}`);

    await page.getByRole("button", { name: "移除图片皮肤", exact: true }).click();
    await page.getByText("不会回退到 App 组件的默认皮肤。未添加时旧项目保持原样。", { exact: false }).waitFor();
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("frame 图片项目相对路径", { exact: true }).inputValue(), "art/ui/harbor-frame.png");
    assert.equal(await page.getByLabel("accentFrame 图片项目相对路径", { exact: true }).inputValue(), "art/ui/accent-frame.png");
    assert.equal(await page.getByLabel("icons 图集图片项目相对路径", { exact: true }).inputValue(), "art/ui/icons.png");
    assert.equal(await page.getByLabel("图标 ID 2", { exact: true }).inputValue(), "journal");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("frame 图片项目相对路径", { exact: true }).count(), 0);
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const removedAssets = await readJson("novel.assets.json");
    assert.equal(Object.hasOwn(removedAssets, "skin"), false, "removing the skin writes the legacy optional-field shape");
    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    assert.equal(await page.getByLabel("frame 图片项目相对路径", { exact: true }).count(), 0);
    assert.equal(Object.hasOwn(await readJson("novel.assets.json"), "skin"), false);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
