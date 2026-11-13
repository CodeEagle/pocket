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

test("Editor authors complete scene and dial choice surfaces with shared validation, history and ordinary Guest images", { timeout: 180_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-choice-surfaces-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const output = join(temporary, "build");
  const id = "choice-surface-authoring";
  await mkdir(join(project, "art/fx"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    await cp(join(source, name), join(project, name), { recursive: true });
  }
  await cp(join(source, "art/fx/sea-mist.png"), join(project, "art/fx/sea-mist.png"));
  await writeFile(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.choice-surface-authoring", name: id, version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  await writeFile(join(project, "images.json"), "{}\n");
  const story = {
    id,
    version: 1,
    start: "start",
    script: {
      start: [{
        type: "choice",
        id: "relay_pick",
        prompt: "Choose a line.",
        options: [
          { id: "route_7", text: "Seven", target: "seven" },
          { id: "route_1", text: "One", target: "one", when: { op: "truthy", value: { type: "literal", value: true } } },
          { id: "route_4", text: "Four", target: "four" },
        ],
      }],
      seven: [{ type: "ending", id: "seven_end" }],
      one: [{ type: "ending", id: "one_end" }],
      four: [{ type: "ending", id: "four_end" }],
    },
  };
  await writeFile(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  const initialAssets = {
    backgrounds: { harbor: "art/fx/sea-mist.png" },
    characters: {}, cgs: {}, audio: {},
    atmospheres: { harbor: { mist: "art/fx/sea-mist.png", authorWeatherNote: { source: "keep", nested: [1, 2] } } },
  };
  await writeFile(join(project, "novel.assets.json"), `${JSON.stringify(initialAssets, null, 2)}\n`);
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
  const readAssets = async () => JSON.parse(await readFile(join(project, "novel.assets.json"), "utf8"));
  const field = (label: string) => page.getByLabel(label, { exact: true });
  try {
    await page.goto(`${origin}/novel?project=${id}`);
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    await field("选择要配置的剧情 choice ID").waitFor();
    assert.deepEqual(await readAssets(), initialAssets, "opening the asset panel must not rewrite atmosphere or other registry data");
    assert.equal(await field("选择要配置的剧情 choice ID").inputValue(), "relay_pick");

    await page.getByRole("button", { name: "添加点击区域", exact: true }).click();
    await field("Choice relay_pick 全部选项 targets JSON").waitFor();
    const targetsField = field("Choice relay_pick 全部选项 targets JSON");
    const defaultTargets = JSON.parse(await targetsField.inputValue());
    assert.deepEqual(Object.keys(defaultTargets).sort(), ["route_1", "route_4", "route_7"], "targets include the full authored options, including conditional options");
    await clickNovelHistory(page, "undo");
    assert.equal(await field("选择要配置的剧情 choice ID").count(), 1, "undo removes the asset entry without changing story options");
    await clickNovelHistory(page, "redo");
    await field("Choice relay_pick 全部选项 targets JSON").waitFor();

    await field("Choice relay_pick 表现形式").selectOption("dial");
    assert.equal(await field("Choice relay_pick 表现形式").inputValue(), "dial", `kind selection must persist before rendering its image field; page errors: ${pageErrors.join(" | ")}`);
    assert.equal(await field("剧情选择 relay_pick 轮盘图片路径").count(), 1);
    await field("剧情选择 relay_pick 轮盘图片路径").fill("art/fx/sea-mist.png");
    await field("剧情选择 relay_pick 轮盘图片路径").press("Tab");
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="剧情选择 relay_pick 轮盘图片预览"]') as HTMLImageElement | null;
      return image?.naturalWidth === 512 && image.naturalHeight === 512;
    });
    const editedTargets = structuredClone(defaultTargets);
    editedTargets.route_7 = { x: 0.3, y: 0.1, w: 0.4, h: 0.3 };
    await targetsField.fill(JSON.stringify(editedTargets, null, 2));
    await targetsField.press("Tab");
    await clickNovelHistory(page, "undo");
    assert.deepEqual(JSON.parse(await field("Choice relay_pick 全部选项 targets JSON").inputValue()), defaultTargets);
    await clickNovelHistory(page, "redo");
    assert.deepEqual(JSON.parse(await field("Choice relay_pick 全部选项 targets JSON").inputValue()), editedTargets);

    const traversalPreview = await fetch(`${origin}/novel/resource?${new URLSearchParams({ project: id, kind: "choice-surface", path: "../package.json" })}`);
    assert.equal(traversalPreview.status, 404, "dial image previews use the registered image project boundary");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = await readAssets();
    assert.deepEqual(saved.choiceSurfaces.relay_pick, {
      kind: "dial",
      targets: editedTargets,
      image: "art/fx/sea-mist.png",
      frame: { x: 0, y: 0, w: 1, h: 1 },
    });
    assert.deepEqual(saved.atmospheres.harbor.authorWeatherNote, initialAssets.atmospheres.harbor.authorWeatherNote, "editing choice surfaces preserves unknown sibling metadata");

    await page.reload();
    await page.getByRole("button", { name: "视觉与音频资源", exact: true }).click();
    await field("剧情选择 relay_pick 轮盘图片路径").waitFor();
    assert.equal(await field("Choice relay_pick 表现形式").inputValue(), "dial");
    assert.deepEqual(JSON.parse(await field("Choice relay_pick 全部选项 targets JSON").inputValue()), editedTargets);
    assert.deepEqual(await readAssets(), saved, "reopening the Editor must retain the saved surface and atmosphere metadata");

    const reject = async (candidate: unknown) => page.evaluate(async ({ base, candidate }) => {
      const health = await fetch("/health").then(response => response.json());
      const response = await fetch(base + "/assets", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-pocket-editor": "1", "x-pocket-csrf": health.csrfToken },
        body: JSON.stringify(candidate),
      });
      return { status: response.status, body: await response.json() };
    }, { base, candidate });
    const missingAndUnknown = structuredClone(saved);
    missingAndUnknown.choiceSurfaces.relay_pick.targets.unlisted = { x: 0.01, y: 0.01, w: 0.1, h: 0.1 };
    delete missingAndUnknown.choiceSurfaces.relay_pick.targets.route_4;
    const badCoverage = await reject(missingAndUnknown);
    assert.equal(badCoverage.status, 422);
    assert.ok(badCoverage.body.diagnostics.some((item: any) => item.code === "assets.choiceSurface.options" && /route_4/.test(item.message) && /unlisted/.test(item.message)));
    const missingChoice = structuredClone(saved);
    missingChoice.choiceSurfaces.unknown_choice = structuredClone(missingChoice.choiceSurfaces.relay_pick);
    delete missingChoice.choiceSurfaces.relay_pick;
    const badChoice = await reject(missingChoice);
    assert.equal(badChoice.status, 422);
    assert.ok(badChoice.body.diagnostics.some((item: any) => item.code === "assets.choiceSurface.choice"));
    const badImage = structuredClone(saved);
    badImage.choiceSurfaces.relay_pick.image = "../outside.png";
    const badPath = await reject(badImage);
    assert.equal(badPath.status, 422);
    assert.ok(badPath.body.diagnostics.some((item: any) => item.code === "assets.choiceSurfaces.schema"));
    assert.deepEqual(await readAssets(), saved, "invalid target references and image traversal must not alter the canonical asset file");

    const built = await buildGuest({ projectRoot: project, outDir: output, tickHz: 60 });
    assert.ok(built.bytecode && built.pak, "authored dial image builds through the pinned Guest pipeline");
    const pakKeys = parsePakLayout(await readFile(built.pak)).flatMap(part => part.kind === "blob" && part.key ? [part.key] : []);
    assert.ok(pakKeys.includes("ui:img.art/fx/sea-mist.png"), `dial bitmap uses the ordinary Guest image collector; keys=${pakKeys.join(",")}`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
