import { strict as assert } from "node:assert";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { NativeSession } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";

function minimalPcmWav(): Buffer {
  const sampleRate = 8_000;
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(2, 40);
  bytes.writeInt16LE(0, 44);
  return bytes;
}

function characterGeometry(frame: { ops?: Array<Record<string, any>> }, asset: string): number[] {
  return (frame.ops ?? [])
    .filter(op => op.asset === asset && (op.type === "image" || op.type === "textureTriangle"))
    .flatMap(op => [
      ...(typeof op.x === "number" ? [op.x] : []),
      ...(typeof op.y === "number" ? [op.y] : []),
      ...(typeof op.w === "number" ? [op.w] : []),
      ...(typeof op.h === "number" ? [op.h] : []),
      ...(Array.isArray(op.points) ? op.points.flatMap((point: { x?: number; y?: number }) => [point.x, point.y]) : []),
    ]);
}

test("timeline editor authors shared tracks, saves history and builds input-driven native motion", { timeout: 240_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const lantern = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-timeline-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "timeline-editor";
  const artifactRoot = resolve(process.env.POCKET_TIMELINE_ARTIFACT_DIR?.trim() || join(repository, "sdk/.pocket-build/timeline"));
  const toolsPackage = process.env.POCKET_TOOLS_PACKAGE?.trim();
  assert.ok(toolsPackage, "set POCKET_TOOLS_PACKAGE to the accepted pinned native tools package before this test");
  const nativeProbe = resolve(process.env.POCKET_NATIVE_PROBE?.trim() || join(toolsPackage, "bin/pocket_probe"));
  assert.ok(existsSync(nativeProbe), `the matching pinned pocket_probe must exist: ${nativeProbe}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  rmSync(join(artifactRoot, "build-failure.json"), { force: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    cpSync(join(lantern, name), join(project, name), { recursive: true });
  }
  mkdirSync(join(project, "art"), { recursive: true });
  copyFileSync(join(lantern, "art/station.png"), join(project, "art/station.png"));
  copyFileSync(join(lantern, "art/mira-neutral.png"), join(project, "art/mira-neutral.png"));
  copyFileSync(join(lantern, "art/ren-neutral.png"), join(project, "art/ren-neutral.png"));
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  writeFileSync(join(project, "assets/audio/table-tone.wav"), minimalPcmWav());
  writeFileSync(join(project, "editor.json"), JSON.stringify({
    id: projectId,
    appId: projectId,
    name: "Timeline Editor Acceptance",
    version: "0.1.0",
    entry: "app.tsx",
    framework: "solid",
    build: 1,
    tickHz: 60,
  }, null, 2));
  const story = {
    id: projectId,
    version: 1,
    start: "start",
    script: {
      start: [
        {
          type: "scene",
          background: "station",
          characters: [
            { id: "mira", expression: "neutral", position: { x: 0, y: 230 }, visible: true },
            { id: "ren", expression: "neutral", position: { x: 220, y: 230 }, visible: true },
          ],
          transition: { kind: "cut", durationMs: 0 },
        },
        { type: "say", id: "timeline-line", text: "The tide carries both travelers forward." },
        { type: "ending", id: "timeline-end", text: "The scene settles." },
      ],
    },
  };
  const assets = {
    backgrounds: { station: "art/station.png" },
    characters: { mira: { neutral: "art/mira-neutral.png" }, ren: { neutral: "art/ren-neutral.png" } },
    cgs: {},
    audio: { "table-tone": "audio/table-tone.wav" },
  };
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  writeFileSync(join(project, "images.json"), "{}\n");
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";

const engine = createNovelEngine(story as StoryDefinition, { preferences: { textSpeedCharsPerSecond: 0 } });
function App() {
  const removeClock = attachNovelClock(engine);
  onCleanup(() => { removeClock(); engine.dispose(); });
  return <NovelView engine={engine} assets={assets as NovelAssets} title="Timeline editor" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = nativeProbe;
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "launch";
  const pageErrors: string[] = [];
  const readStory = () => JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByRole("button", { name: "＋ 新建预设", exact: true }).click();
    assert.equal(await page.getByLabel("预设 ID", { exact: true }).inputValue(), "timeline_1");
    assert.equal(await page.getByLabel("时长 (ms)", { exact: true }).inputValue(), "1200");

    phase = "camera and actor keyframes";
    await page.getByRole("button", { name: "＋ 添加相机关键帧", exact: true }).click();
    await page.getByRole("button", { name: "＋ 添加相机关键帧", exact: true }).click();
    await page.getByLabel("相机 atMs 2", { exact: true }).fill("300");
    await page.getByLabel("相机 x 2", { exact: true }).fill("90");
    await page.getByLabel("相机 scale 2", { exact: true }).fill("1.2");

    await page.getByRole("button", { name: "＋ 添加角色轨", exact: true }).click();
    await page.getByLabel("角色轨道 1 ID", { exact: true }).waitFor();
    await page.getByRole("button", { name: "＋ 添加角色关键帧", exact: true }).first().click();
    await page.getByLabel("角色 1 atMs 2", { exact: true }).fill("300");
    await page.getByLabel("角色 1 位置 x 2", { exact: true }).fill("120");
    await page.getByRole("button", { name: "＋ 添加角色轨", exact: true }).click();
    await page.getByRole("button", { name: "＋ 添加角色关键帧", exact: true }).nth(1).click();
    await page.getByLabel("角色 2 atMs 2", { exact: true }).fill("300");
    await page.getByLabel("角色 2 位置 x 2", { exact: true }).fill("180");

    await page.getByRole("button", { name: "＋ 添加音频 cue", exact: true }).click();
    await page.getByLabel("音频 atMs 1", { exact: true }).fill("300");
    assert.equal(await page.getByLabel("音频 Cue 1", { exact: true }).inputValue(), "table-tone");
    assert.equal(await page.locator("#novel-timeline-chart .nv-timeline-chart-row").count(), 4, "the chart synchronizes camera, both actor tracks and audio on one ruler");

    phase = "shared edit history";
    await page.getByLabel("角色 1 atMs 2", { exact: true }).fill("900");
    assert.equal(await page.locator('.nv-timeline-chart-row[data-timeline-track-key="actor:0"] .nv-timeline-chart-marker[data-at-ms="900"]').count(), 1);
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("角色 1 atMs 2", { exact: true }).inputValue(), "300");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("角色 1 atMs 2", { exact: true }).inputValue(), "900");

    phase = "scene preset assignment and save";
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.locator(".nv-instruction").first().getByLabel("场景时间轴", { exact: true }).selectOption("timeline_1");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = readStory();
    assert.equal(saved.script.start[0].timeline, "timeline_1");
    assert.deepEqual(saved.timelines.timeline_1, {
      durationMs: 1200,
      camera: [
        { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
        { atMs: 300, value: { x: 90, y: 0, scale: 1.2 } },
      ],
      actors: [
        { id: "mira", keyframes: [
          { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
          { atMs: 900, value: { position: { x: 120, y: 0 }, scale: 1, rotation: 0 } },
        ] },
        { id: "ren", keyframes: [
          { atMs: 0, value: { position: { x: 0, y: 0 }, scale: 1, rotation: 0 } },
          { atMs: 300, value: { position: { x: 180, y: 0 }, scale: 1, rotation: 0 } },
        ] },
      ],
      audio: [{ atMs: 300, cue: "table-tone", action: "play", channel: "sfx", loop: false }],
    });

    phase = "save and reopen";
    await page.reload();
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    assert.equal(await page.getByLabel("角色 1 atMs 2", { exact: true }).inputValue(), "900");
    assert.equal(await page.getByLabel("相机 x 2", { exact: true }).inputValue(), "90");
    assert.equal(await page.getByLabel("角色 2 位置 x 2", { exact: true }).inputValue(), "180");
    assert.equal(await page.getByLabel("音频 atMs 1", { exact: true }).inputValue(), "300");
    assert.deepEqual(readStory(), saved);
    await page.screenshot({ path: join(artifactRoot, "timeline-editor.png"), fullPage: true });

    phase = "pinned Guest build";
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 45_000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as { builtRevision: number; revision: number };
    assert.equal(status.builtRevision, status.revision);
    const artifact = join(workspace, "builds", projectId, String(status.builtRevision));
    const bytecodePath = join(artifact, "app.qjbc");
    const pakPath = join(artifact, "app.pak");
    const metadataPath = join(artifact, "app.bytecode.json");
    assert.ok(existsSync(bytecodePath) && existsSync(pakPath) && existsSync(metadataPath));
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    for (const file of ["app.qjbc", "app.pak", "app.bytecode.json", "story.json"]) {
      copyFileSync(file === "story.json" ? join(project, file) : join(artifact, file), join(artifactRoot, file));
    }
    writeFileSync(join(artifactRoot, "acceptance.json"), `${JSON.stringify({ projectId, builtRevision: status.builtRevision, runtimeAbi: metadata.runtimeAbi, toolsPackage, nativeProbe, timeline: saved.timelines.timeline_1, errors: pageErrors }, null, 2)}\n`);

    phase = "NativeSession start input and moving frames";
    native = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 45_000 });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    const initialMira = characterGeometry(frame, "art/mira-neutral.png");
    const initialRen = characterGeometry(frame, "art/ren-neutral.png");
    assert.ok(initialMira.length, `Mira must draw from the saved Guest after native start input: ${(frame.ops ?? []).filter(op => op.type === "text").map(op => op.text).join(" | ")}`);
    assert.ok(initialRen.length, "Ren must draw from the saved Guest after native start input");
    frame = await native.settle(frame, 24);
    const movedMira = characterGeometry(frame, "art/mira-neutral.png");
    const movedRen = characterGeometry(frame, "art/ren-neutral.png");
    assert.ok(movedMira.length && movedMira.some((value, index) => Math.abs(value - (initialMira[index] ?? value)) > 1), "the saved actor keyframes must change real native draw geometry while the timeline clock advances");
    assert.ok(movedRen.length && movedRen.some((value, index) => Math.abs(value - (initialRen[index] ?? value)) > 1), "the second actor track must also affect native draw geometry");
    writeFileSync(join(artifactRoot, "native-frames.json"), `${JSON.stringify({ initialMira, movedMira, initialRen, movedRen, text: (frame.ops ?? []).filter(op => op.type === "text").map(op => op.text) }, null, 2)}\n`);
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    if (phase === "pinned Guest build") {
      const status = await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`).then(response => response.json()).catch(value => ({ diagnostic: String(value) }));
      const statePath = join(workspace, "states", `${projectId}.json`);
      const state = existsSync(statePath) ? readFileSync(statePath, "utf8") : "state file unavailable";
      writeFileSync(join(artifactRoot, "build-failure.json"), `${JSON.stringify({ status, state, project: readStory() }, null, 2)}\n`);
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; browserErrors=${JSON.stringify(pageErrors)}`);
  } finally {
    await native?.quit();
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    await browser?.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
