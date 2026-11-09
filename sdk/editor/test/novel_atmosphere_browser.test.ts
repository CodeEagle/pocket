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

test("Editor authors per-background atmosphere layers with shared validation, history and Guest images", async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-atmosphere-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const output = join(temporary, "build");
  const id = "atmosphere-authoring";
  await mkdir(join(project, "art/fx"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "fonts.json", "fonts", "novel.locales.json"]) {
    await cp(join(source, name), join(project, name), { recursive: true });
  }
  await cp(join(source, "art/fx/sea-mist.png"), join(project, "art/fx/sea-mist.png"));
  await cp(join(source, "art/fx/rain-streak.svg"), join(project, "art/fx/rain-streak.svg"));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.atmosphere-authoring", name: id, version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  await writeFile(join(project, "images.json"), JSON.stringify({ "art/fx/sea-mist.png": { linear: true } }));
  await writeFile(join(project, "story.json"), JSON.stringify({ id, version: 1, start: "start", script: { start: [{ type: "ending", id: "end", text: "Done." }] } }, null, 2));
  const initialAssets = {
    backgrounds: { harbor: "art/fx/sea-mist.png" },
    characters: {}, cgs: {}, audio: {},
    atmospheres: {
      harbor: {
        mist: "art/fx/sea-mist.png",
        rain: "art/fx/rain-streak.svg",
        intensity: 0.4,
        lightning: false,
        authorWeatherNote: { source: "hand-authored", preserve: true },
      },
    },
  };
  await writeFile(join(project, "novel.assets.json"), JSON.stringify(initialAssets, null, 2));
  await writeFile(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
function App() { return <View class="w-full h-full" />; }
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
  const readAssets = async (): Promise<any> => JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8"));
  const field = (label: string) => page.getByLabel(label, { exact: true });
  try {
    await page.goto(`${origin}/novel?project=${id}`);
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    await field("背景 harbor 雾图项目相对路径").waitFor();
    const traversalPreview = await fetch(`${origin}/novel/resource?${new URLSearchParams({ project: id, kind: "atmosphere", path: "../package.json" })}`);
    assert.equal(traversalPreview.status, 404, "atmosphere previews use the same project-local file boundary as skin previews");
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="背景 harbor 雾图预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 512 && image.naturalHeight === 512;
    });
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="背景 harbor 雨图预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 32 && image.naturalHeight === 32;
    });
    assert.deepEqual(await readAssets(), initialAssets, "opening an existing atmosphere must not rewrite its registry");

    const intensity = field("背景 harbor 氛围强度 (0–1)");
    assert.equal(await intensity.inputValue(), "0.4");
    await intensity.fill("0.65");
    await intensity.press("Tab");
    await clickNovelHistory(page, "undo");
    assert.equal(await field("背景 harbor 氛围强度 (0–1)").inputValue(), "0.4");
    await clickNovelHistory(page, "redo");
    assert.equal(await field("背景 harbor 氛围强度 (0–1)").inputValue(), "0.65");
    await field("背景 harbor 闪电").check();
    await clickNovelHistory(page, "undo");
    assert.equal(await field("背景 harbor 闪电").isChecked(), false);
    await clickNovelHistory(page, "redo");
    assert.equal(await field("背景 harbor 闪电").isChecked(), true);

    page.once("dialog", dialog => dialog.accept("archive"));
    await page.getByRole("button", { name: "＋ 添加背景", exact: true }).click();
    const archiveKey = field("键").last();
    await archiveKey.fill("archive");
    await archiveKey.press("Tab");
    const backgroundPaths = field("项目相对图片路径");
    await backgroundPaths.last().fill("art/fx/sea-mist.png");
    await backgroundPaths.last().press("Tab");
    await page.getByRole("button", { name: "＋ 添加天气氛围", exact: true }).click();
    const archiveRainPath = field("背景 archive 雨图项目相对路径");
    await archiveRainPath.fill("art/fx/rain-streak.svg");
    await archiveRainPath.press("Tab");
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="背景 archive 雨图预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 32 && image.naturalHeight === 32;
    });
    await field("背景 archive 闪电").check();

    const backgroundGroup = page.locator(".nv-assets-panel > .nv-asset-group").filter({ has: page.getByRole("heading", { name: "背景", exact: true }) });
    const harborId = backgroundGroup.getByLabel("键", { exact: true }).first();
    await harborId.fill("harbor-renamed");
    await harborId.press("Tab");
    await field("背景 harbor-renamed 氛围强度 (0–1)").waitFor();
    await clickNovelHistory(page, "undo");
    await field("背景 harbor 氛围强度 (0–1)").waitFor();
    await clickNovelHistory(page, "redo");
    await field("背景 harbor-renamed 氛围强度 (0–1)").waitFor();

    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = await readAssets();
    assert.deepEqual(saved.atmospheres["harbor-renamed"], {
      mist: "art/fx/sea-mist.png",
      rain: "art/fx/rain-streak.svg",
      intensity: 0.65,
      lightning: true,
      authorWeatherNote: { source: "hand-authored", preserve: true },
    }, "editing known atmosphere fields must preserve author metadata");
    assert.deepEqual(saved.atmospheres.archive, { rain: "art/fx/rain-streak.svg", lightning: true });

    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    assert.equal(await field("背景 harbor-renamed 氛围强度 (0–1)").inputValue(), "0.65");
    assert.equal(await field("背景 harbor-renamed 闪电").isChecked(), true);
    assert.equal(await field("背景 archive 雨图项目相对路径").inputValue(), "art/fx/rain-streak.svg");
    assert.deepEqual(await readAssets(), saved);

    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    assert.ok(built.bytecode && built.pak, "saved atmosphere images must build through the pinned Guest pipeline");
    const pakKeys = parsePakLayout(await readFile(built.pak)).flatMap(part => part.kind === "blob" && part.key ? [part.key] : []);
    assert.ok(pakKeys.includes("ui:img.art/fx/sea-mist.png"), `mist image must be present in Guest PAK; keys=${pakKeys.join(",")}`);
    assert.ok(pakKeys.includes("ui:img.art/fx/rain-streak.svg"), `rain image must be present in Guest PAK; keys=${pakKeys.join(",")}`);

    const reject = async (candidate: unknown) => page.evaluate(async ({ base, candidate }) => {
      const health = await fetch("/health").then(response => response.json());
      const response = await fetch(base + "/assets", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-pocket-editor": "1", "x-pocket-csrf": health.csrfToken },
        body: JSON.stringify(candidate),
      });
      return { status: response.status, body: await response.json() };
    }, { base, candidate });
    const beforeRejectedWrite = await readAssets();
    const missingBackground = await reject({ ...saved, atmospheres: { ...saved.atmospheres, missing: {} } });
    assert.equal(missingBackground.status, 422);
    assert.ok(missingBackground.body.diagnostics.some((item: any) => item.code === "assets.atmosphere.background"));
    const invalidIntensity = await reject({ ...saved, atmospheres: { ...saved.atmospheres, "harbor-renamed": { ...saved.atmospheres["harbor-renamed"], intensity: 1.1 } } });
    assert.equal(invalidIntensity.status, 422);
    assert.ok(invalidIntensity.body.diagnostics.some((item: any) => item.code === "assets.atmosphere.schema"));
    const invalidImagePath = await reject({ ...saved, atmospheres: { ...saved.atmospheres, "harbor-renamed": { ...saved.atmospheres["harbor-renamed"], mist: "../escape.png" } } });
    assert.equal(invalidImagePath.status, 422);
    assert.deepEqual(await readAssets(), beforeRejectedWrite, "invalid atmosphere writes must leave the canonical registry unchanged");

    await page.getByLabel("背景 harbor-renamed 氛围强度 (0–1)").waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
