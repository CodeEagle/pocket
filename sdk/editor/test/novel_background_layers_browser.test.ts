import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { NativeSession, type DrawOp } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";
import { parsePakLayout } from "../../scripts/package_update.ts";

const repository = resolve(import.meta.dir, "../../..");
const lantern = join(repository, "demo/js/apps/lantern");

type Rect = { x: number; y: number; w: number; h: number };

function assetOps(frame: { ops?: DrawOp[] }, asset: string): DrawOp[] {
  return (frame.ops ?? []).filter(op =>
    (op.type === "image" || op.type === "textureTriangle") && (op as DrawOp & { asset?: string }).asset === asset,
  );
}

function assetBounds(ops: readonly DrawOp[], asset: string): Rect {
  const points = ops.flatMap(op => {
    if (Array.isArray(op.points)) return op.points;
    if ([op.x, op.y, op.w, op.h].every(Number.isFinite)) {
      return [{ x: op.x!, y: op.y! }, { x: op.x! + op.w!, y: op.y! + op.h! }];
    }
    return [];
  });
  assert.ok(points.length, `native frame must expose image geometry for ${asset}; ops=${JSON.stringify(ops)}`);
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function assetUvSpan(ops: readonly DrawOp[], asset: string): { x: number; y: number } {
  const values = ops.flatMap(op => {
    const candidate = op as DrawOp & { uv?: number[] };
    if (Array.isArray(candidate.uv) && candidate.uv.length === 4) return [candidate.uv];
    if (Array.isArray(op.uvs) && op.uvs.length >= 8) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (let index = 0; index + 1 < op.uvs.length; index += 2) {
        xs.push(op.uvs[index]!);
        ys.push(op.uvs[index + 1]!);
      }
      return [[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]];
    }
    return [];
  });
  assert.ok(values.length, `native frame must expose source UVs for ${asset}; ops=${JSON.stringify(ops)}`);
  return {
    x: Math.max(...values.map(value => value[2]! - value[0]!)),
    y: Math.max(...values.map(value => value[3]! - value[1]!)),
  };
}

test("Chromium edits inherited and explicit background layers, then the pinned Guest paints matching depth geometry", { timeout: 180_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-background-layers-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const id = "background-layers-authoring";
  mkdirSync(join(project, "art"), { recursive: true });
  mkdirSync(join(project, "assets", "audio"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) cpSync(join(lantern, name), join(project, name));
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id, appId: "pocket.demo.background-layers", name: id, version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));

  const imageColors = { base: "#263e50", far: "#405b46", mid: "#855337", near: "#6d3a64" };
  for (const [name, color] of Object.entries(imageColors)) {
    writeFileSync(join(project, `art/${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="320"><rect width="180" height="320" fill="${color}"/><circle cx="${name === "near" ? 140 : 40}" cy="60" r="19" fill="#f5dc8b"/></svg>`);
  }
  writeFileSync(join(project, "art/mira.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="175"><rect width="120" height="175" fill="#b46b5c"/><circle cx="60" cy="36" r="24" fill="#e2b892"/></svg>');
  const backgrounds = { base: "art/base.svg", far: "art/far.svg", mid: "art/mid.svg", near: "art/near.svg" };
  const assets = { backgrounds, characters: { mira: { neutral: "art/mira.svg" } }, cgs: {}, audio: {} };
  const story = {
    id,
    version: 1,
    start: "start",
    author: { note: "Keep story metadata", nested: { source: "background-layer-test" } },
    script: {
      start: [
        {
          type: "scene",
          background: "base",
          camera: { x: 64, y: -32, scale: 1.5 },
          characters: [{ id: "mira", expression: "neutral", position: "left" }],
          backgroundLayers: [
            { background: "far", parallax: 0.25, authorLayerNote: { keep: "far-note" } },
            { background: "mid", parallax: 1, authorLayerNote: "mid-note" },
          ],
          authorSceneNote: { keep: ["metadata", "order"] },
        },
        { type: "say", id: "layer-preview", text: "The same depth planes must reach both Editor previews and the Guest." },
        { type: "ending", id: "end", text: "Done." },
      ],
      legacy: [
        { type: "scene", background: "base", authorLegacyNote: "Omitted means inherit; preserve the omission." },
        { type: "ending", id: "legacy-end", text: "Done." },
      ],
    },
  };
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  writeFileSync(join(project, "images.json"), `${JSON.stringify(Object.fromEntries([...Object.values(backgrounds), "art/mira.svg"].map(path => [path, { linear: true }])), null, 2)}\n`);
  writeFileSync(join(project, "app.tsx"), `import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import storyDocument from "./story.json";
import assetsDocument from "./novel.assets.json";
function App() {
  const host = createHostBridge();
  const engine = createNovelEngine(storyDocument as StoryDefinition);
  onCleanup(() => { engine.dispose(); host.dispose(); });
  return <NovelView host={host} engine={engine} assets={assetsDocument as NovelAssets} title="Background layers" subtitle="Parallax editor acceptance" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  page.setDefaultTimeout(15_000);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const readStory = () => JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
  const firstInstruction = page.locator(".nv-instruction").first();
  const layerRows = () => firstInstruction.locator(".nv-background-layer-row");
  let nativeSession: NativeSession | undefined;
  const previousProbe = process.env.POCKET_NATIVE_PROBE;

  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/novel?project=${id}`);
    assert.equal(response?.status(), 200);
    await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).waitFor();
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "far");
    assert.equal(await firstInstruction.getByLabel("背景层 2 视差 (0–1)", { exact: true }).inputValue(), "1");
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /显式设置 2 层/);

    const parallax = firstInstruction.getByLabel("背景层 1 视差 (0–1)", { exact: true });
    await parallax.fill("0.5");
    await parallax.press("Tab");
    assert.equal(await parallax.inputValue(), "0.5");
    await clickNovelHistory(page, "undo");
    assert.equal(await firstInstruction.getByLabel("背景层 1 视差 (0–1)", { exact: true }).inputValue(), "0.25");
    await clickNovelHistory(page, "redo");
    assert.equal(await firstInstruction.getByLabel("背景层 1 视差 (0–1)", { exact: true }).inputValue(), "0.5");

    const firstCue = firstInstruction.getByLabel("背景层 1 背景键", { exact: true });
    await firstCue.selectOption("near");
    assert.equal(await firstCue.inputValue(), "near");
    await clickNovelHistory(page, "undo");
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "far");
    await clickNovelHistory(page, "redo");
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "near");

    await layerRows().nth(0).getByRole("button", { name: "下移", exact: true }).click();
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "mid");
    await clickNovelHistory(page, "undo");
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "near");
    await clickNovelHistory(page, "redo");
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "mid");

    await firstInstruction.getByRole("button", { name: "＋ 添加背景层", exact: true }).click();
    assert.equal(await layerRows().count(), 3);
    await layerRows().nth(2).getByRole("button", { name: "移除背景层", exact: true }).click();
    assert.equal(await layerRows().count(), 2);
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /显式设置 2 层/);
    await clickNovelHistory(page, "undo");
    assert.equal(await layerRows().count(), 3);
    await clickNovelHistory(page, "redo");
    assert.equal(await layerRows().count(), 2);

    await firstInstruction.getByRole("button", { name: "＋ 添加背景层", exact: true }).click();
    await firstInstruction.getByLabel("背景层 3 背景键", { exact: true }).selectOption("far");
    const fixedParallax = firstInstruction.getByLabel("背景层 3 视差 (0–1)", { exact: true });
    await fixedParallax.fill("0");
    await fixedParallax.press("Tab");

    for (let remaining = 2; remaining >= 0; remaining -= 1) {
      await layerRows().last().getByRole("button", { name: "移除背景层", exact: true }).click();
      assert.equal(await layerRows().count(), remaining);
    }
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /显式清空/);
    for (let index = 0; index < 3; index += 1) await clickNovelHistory(page, "undo");
    assert.equal(await layerRows().count(), 3, "undo restores each removed layer");
    for (let index = 0; index < 3; index += 1) await clickNovelHistory(page, "redo");
    assert.equal(await layerRows().count(), 0, "deleting the final layer leaves an explicit empty array");

    await firstInstruction.getByRole("button", { name: "继承上一场景", exact: true }).click();
    assert.equal(await firstInstruction.locator(".nv-background-layer-row").count(), 0);
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /继承上一场景/);
    await clickNovelHistory(page, "undo");
    assert.equal(await layerRows().count(), 0);
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /显式清空/);
    await clickNovelHistory(page, "redo");
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /继承上一场景/);
    await clickNovelHistory(page, "undo");
    for (let index = 0; index < 3; index += 1) await clickNovelHistory(page, "undo");
    assert.equal(await layerRows().count(), 3, "undo of the removals restores the original layer objects and metadata");

    const savedLayers = [
      { background: "mid", parallax: 1, authorLayerNote: "mid-note" },
      { background: "near", parallax: 0.5, authorLayerNote: { keep: "far-note" } },
      { background: "far", parallax: 0 },
    ];
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const written = readStory();
    assert.deepEqual(written.script.start[0].backgroundLayers, savedLayers);
    assert.equal(Object.hasOwn(written.script.legacy[0], "backgroundLayers"), false, "unrelated legacy scene remains in inherit mode without a materialized empty array");
    assert.deepEqual(written.script.start[0].authorSceneNote, story.script.start[0].authorSceneNote);
    assert.deepEqual(written.author, story.author);

    await page.reload();
    await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).waitFor();
    assert.equal(await firstInstruction.getByLabel("背景层 1 背景键", { exact: true }).inputValue(), "mid");
    assert.equal(await firstInstruction.getByLabel("背景层 2 背景键", { exact: true }).inputValue(), "near");
    assert.equal(await firstInstruction.getByLabel("背景层 2 视差 (0–1)", { exact: true }).inputValue(), "0.5");
    assert.equal(await layerRows().count(), 3);

    await page.locator(".nv-label").filter({ hasText: "legacy" }).click();
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /继承上一场景/);
    await firstInstruction.getByRole("button", { name: "清空并停止继承", exact: true }).click();
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /显式清空/);
    await clickNovelHistory(page, "undo");
    assert.match(await firstInstruction.locator(".nv-background-layer-mode").innerText(), /继承上一场景/);
    assert.equal(Object.hasOwn(readStory().script.legacy[0], "backgroundLayers"), false);
    await page.locator(".nv-label").filter({ hasText: "start" }).click();
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    assert.equal(Object.hasOwn(readStory().script.legacy[0], "backgroundLayers"), false, "restoring inherit must preserve the omitted field on save");

    await page.getByRole("button", { name: "舞台编辑", exact: true }).click();
    await page.locator(".nv-authoring-stage .nv-authoring-background-layer").nth(0).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-authoring-stage img")].every(image => (image as HTMLImageElement).naturalWidth > 0));
    const authoringPose = await page.locator(".nv-authoring-stage .nv-authoring-background-layer").evaluateAll(images => images.map(image => {
      const element = image as HTMLImageElement;
      return { key: element.dataset.background, index: element.dataset.layerIndex, transform: element.style.transform };
    }));
    assert.deepEqual(authoringPose, [
      { key: "mid", index: "0", transform: "translate(64px, -32px) scale(1.5)" },
      { key: "near", index: "1", transform: "translate(32px, -16px) scale(1.25)" },
      { key: "far", index: "2", transform: "translate(0px, 0px) scale(1)" },
    ], "stage authoring preview uses the same resolved camera pose and authored order");

    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.locator(".nv-stage-preview .nv-stage-background-layer").nth(0).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll(".nv-stage-preview img")].every(image => (image as HTMLImageElement).naturalWidth > 0));
    const livePose = await page.locator(".nv-stage-preview .nv-stage-background-layer").evaluateAll(images => images.map(image => {
      const element = image as HTMLImageElement;
      return { key: element.dataset.background, index: element.dataset.layerIndex, transform: element.style.transform };
    }));
    assert.deepEqual(livePose, authoringPose, "the live preview and authoring preview resolve the same layer data");
    const liveBase = await page.locator('.nv-stage-preview [data-background-role="base"]').evaluate(image => (image as HTMLElement).style.transform);
    assert.equal(liveBase, "translate(64px, -32px) scale(1.5)");

    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.locator("#novel-build").click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 45_000 });
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${id}/status`)).json() as { builtRevision: number; revision: number };
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/, JSON.stringify(status, null, 2));
    assert.equal(status.builtRevision, status.revision);
    const artifactDirectory = join(workspace, "builds", id, String(status.builtRevision));
    const bytecodePath = join(artifactDirectory, "app.qjbc");
    const pakPath = join(artifactDirectory, "app.pak");
    const metadataPath = join(artifactDirectory, "app.bytecode.json");
    assert.ok(existsSync(bytecodePath) && existsSync(pakPath) && existsSync(metadataPath));
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    const packedImages = parsePakLayout(readFileSync(pakPath)).flatMap(part => part.kind === "blob" && part.key ? [part.key] : []);
    assert.ok(packedImages.some(key => key.includes("base")), `built PAK must contain the base background resource; keys=${packedImages.join(",")}`);

    const previous = process.env.POCKET_NATIVE_PROBE;
    process.env.POCKET_NATIVE_PROBE = join(repository, "sdk/.pocket-build/current-native-tools/bin/pocket_probe");
    try {
      nativeSession = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: String(metadata.runtimeAbi) }, { width: 360, height: 640, deadlineMs: 30_000 });
      let frame = await nativeSession.boot();
      frame = await nativeSession.tap("启程 · 开始新的故事", frame);
      frame = await nativeSession.settle(frame, 4);
      const baseOps = assetOps(frame, "art/base.svg");
      const farOps = assetOps(frame, "art/far.svg");
      const midOps = assetOps(frame, "art/mid.svg");
      const nearOps = assetOps(frame, "art/near.svg");
      const drawn = (frame.ops ?? []).filter(op => op.type === "image" || op.type === "textureTriangle").map(op => ({ type: op.type, asset: (op as DrawOp & { asset?: string }).asset, x: op.x, y: op.y, w: op.w, h: op.h, points: op.points }));
      for (const [asset, ops] of [["base", baseOps], ["far", farOps], ["mid", midOps], ["near", nearOps]] as const) assert.ok(ops.length, `built native Guest paints ${asset}; texts=${(frame.ops ?? []).filter(op => op.type === "text").map(op => op.text).join(" | ")}; drawn=${JSON.stringify(drawn)}`);
      const opIndex = (asset: string) => (frame.ops ?? []).findIndex(op => (op.type === "image" || op.type === "textureTriangle") && (op as DrawOp & { asset?: string }).asset === asset);
      assert.ok(opIndex("art/base.svg") < opIndex("art/mid.svg") && opIndex("art/mid.svg") < opIndex("art/near.svg") && opIndex("art/near.svg") < opIndex("art/far.svg"), "native draw order follows the saved back-to-front layer list");
      const baseUv = assetUvSpan(baseOps, "art/base.svg");
      const farUv = assetUvSpan(farOps, "art/far.svg");
      const midUv = assetUvSpan(midOps, "art/mid.svg");
      const nearUv = assetUvSpan(nearOps, "art/near.svg");
      assert.ok(Math.abs(midUv.x - baseUv.x) < 0.001 && Math.abs(midUv.y - baseUv.y) < 0.001,
        `parallax 1 must match the base camera crop: mid=${JSON.stringify(midUv)} base=${JSON.stringify(baseUv)}`);
      assert.ok(farUv.x > nearUv.x && nearUv.x > baseUv.x && farUv.y > nearUv.y && nearUv.y > baseUv.y,
        `lower parallax must receive a smaller camera zoom in native UVs: far=${JSON.stringify(farUv)} near=${JSON.stringify(nearUv)} base=${JSON.stringify(baseUv)}`);
      const baseBounds = assetBounds(baseOps, "art/base.svg");
      const midBounds = assetBounds(midOps, "art/mid.svg");
      assert.ok(Math.abs(baseBounds.x - midBounds.x) < 0.1 && Math.abs(baseBounds.y - midBounds.y) < 0.1 && Math.abs(baseBounds.w - midBounds.w) < 0.1 && Math.abs(baseBounds.h - midBounds.h) < 0.1,
        "parallax 1 must receive the same camera geometry as the base layer");
    } finally {
      await nativeSession?.quit();
      nativeSession = undefined;
      if (previous === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previous;
    }
    assert.deepEqual(pageErrors, []);

    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const sourcePath = join(artifactDirectory, "app.js");
    const sourceBytes = readFileSync(sourcePath);
    const qjbcBytes = readFileSync(bytecodePath);
    const payloadBytes = qjbcBytes.subarray(Number(metadata.headerBytes));
    const pakBytes = readFileSync(pakPath);
    const savedStoryBytes = readFileSync(join(project, "story.json"));
    assert.equal(metadata.sourceSha256, sha256(sourceBytes), "metadata source hash matches the generated Guest input");
    assert.equal(metadata.payloadSha256, sha256(payloadBytes), "metadata payload hash matches the serialized QJBC payload");
    assert.equal(metadata.bytecodeBytes, qjbcBytes.byteLength, "metadata bytecode size matches the QJBC artifact");
    console.log("BACKGROUND_LAYERS_EDITOR_ARTIFACTS", JSON.stringify({
      projectRevision: status.builtRevision,
      story: { bytes: savedStoryBytes.byteLength, sha256: sha256(savedStoryBytes) },
      source: { bytes: sourceBytes.byteLength, sha256: metadata.sourceSha256 },
      payload: { bytes: payloadBytes.byteLength, sha256: metadata.payloadSha256 },
      qjbc: { bytes: qjbcBytes.byteLength, sha256: sha256(qjbcBytes) },
      pak: { bytes: pakBytes.byteLength, sha256: sha256(pakBytes) },
      runtimeAbi: metadata.runtimeAbi,
    }));
  } finally {
    await nativeSession?.quit();
    await browser.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
  }
}, 180_000);
