import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { startEditor } from "../server.ts";
import { cubismWebCorePath } from "../live2d.ts";

const repository = resolve(import.meta.dir, "../../..");
const source = join(repository, "demo/js/apps/lantern");
const cubismRoot = join(repository, "sdk/packages/pocket_live2d/.cache/cubism-sdk-native-5-r5/CubismSdkForNative-5-r.5");
const hiyoriSource = join(cubismRoot, "Samples/Resources/Hiyori");

function missingLocalFixtureFiles(): string[] {
  const missing: string[] = [];
  const core = cubismWebCorePath();
  if (!existsSync(core)) missing.push(`official Cubism Web Core: ${core}`);
  const modelPath = join(hiyoriSource, "Hiyori.model3.json");
  if (!existsSync(modelPath)) {
    missing.push(`official Hiyori sample cache: ${modelPath}`);
    return missing;
  }
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as any;
  const references = model.FileReferences ?? {};
  const files = [
    references.Moc,
    references.Physics,
    references.Pose,
    references.UserData,
    references.DisplayInfo,
    ...(references.Textures ?? []),
    ...Object.values(references.Motions ?? {}).flatMap((motions: any) => Array.isArray(motions) ? motions.map(motion => motion?.File) : []),
    ...(Array.isArray(references.Expressions) ? references.Expressions.map((expression: any) => expression?.File) : []),
  ].filter((path): path is string => typeof path === "string");
  for (const file of files) {
    const path = join(hiyoriSource, file);
    if (!existsSync(path)) missing.push(`official Hiyori sample file: ${path}`);
  }
  return missing;
}

const missingLocalFixtures = missingLocalFixtureFiles();

function stageHiyori(project: string): void {
  const scripts = join(project, "scripts");
  mkdirSync(scripts, { recursive: true });
  const script = join(scripts, "prepare_live2d.ts");
  cpSync(join(source, "scripts/prepare_live2d.ts"), script);
  execFileSync(process.execPath, [script], {
    cwd: project,
    env: { ...process.env, CUBISM_SDK_ROOT: cubismRoot },
    stdio: "pipe",
  });
}

// Official Cubism and Hiyori are licensed local caches. Skip this browser
// integration when either cache is absent; never download or bootstrap them.
test.skipIf(missingLocalFixtures.length > 0)(`Novel stage previews registered Hiyori through the Web Core provider and shared mesh compositor${missingLocalFixtures.length ? ` (missing ${missingLocalFixtures.join("; ")})` : ""}`, { timeout: 60_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-live2d-stage-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  mkdirSync(project, { recursive: true });
  for (const name of ["app.tsx", "story.ts", "story.json", "revision-map.json", "revision-map-v2.json", "revision-map-v3.json", "revision-map-v4.json", "revision-map-v5.json", "pocket.json", "manifest.json", "package.json", "novel.assets.json", "novel.locales.json", "fonts.json", "images.json", "fonts", "assets", "models"]) {
    cpSync(join(source, name), join(project, name), { recursive: true });
  }
  cpSync(join(source, "art"), join(project, "art"), { recursive: true });
  stageHiyori(project);
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "novel-live2d-stage", appId: "pocket.demo.lantern", name: "Novel Live2D Stage", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const errors: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=novel-live2d-stage`);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "舞台编辑", exact: true }).click();
    await page.getByLabel("舞台标签", { exact: true }).selectOption("model_showcase_hiyori");
    await page.getByLabel("舞台场景", { exact: true }).selectOption("0");

    const canvas = page.locator('canvas[data-model-preview-character="sample_hiyori"]');
    await canvas.waitFor();
    await page.waitForFunction(() => {
      const target = document.querySelector<HTMLCanvasElement>('canvas[data-model-preview-character="sample_hiyori"]');
      return Number(target?.dataset.frameCount) > 0 && Number(target?.dataset.meshCount) > 10 && target?.nextElementSibling?.textContent === "Live2D 动画预览中";
    }, undefined, { timeout: 30000 }).catch(async error => {
      const status = await page.locator(".nv-authoring-model-status").allInnerTexts();
      throw new Error(`${error.message}; stage status=${JSON.stringify(status)}; browser errors=${JSON.stringify(errors)}`);
    });

    const firstFrame = await canvas.evaluate(element => {
      const context = (element as HTMLCanvasElement).getContext("2d", { willReadFrequently: true })!;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let covered = 0;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] !== 0) covered++;
        hash = Math.imul(hash ^ pixels[index]!, 16777619);
        hash = Math.imul(hash ^ pixels[index + 1]!, 16777619);
        hash = Math.imul(hash ^ pixels[index + 2]!, 16777619);
      }
      return { covered, hash: hash >>> 0, frameCount: Number(element.dataset.frameCount), meshCount: Number(element.dataset.meshCount) };
    });
    expect(firstFrame.covered).toBeGreaterThan(1000);
    expect(firstFrame.meshCount).toBeGreaterThan(10);
    await page.waitForTimeout(500);
    const nextFrame = await canvas.evaluate(element => {
      const context = (element as HTMLCanvasElement).getContext("2d", { willReadFrequently: true })!;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 4) {
        hash = Math.imul(hash ^ pixels[index]!, 16777619);
        hash = Math.imul(hash ^ pixels[index + 1]!, 16777619);
        hash = Math.imul(hash ^ pixels[index + 2]!, 16777619);
      }
      return { hash: hash >>> 0, frameCount: Number(element.dataset.frameCount) };
    });
    expect(nextFrame.frameCount).toBeGreaterThan(firstFrame.frameCount);
    expect(nextFrame.hash).not.toBe(firstFrame.hash);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
