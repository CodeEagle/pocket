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

test("timeline gain editor saves an envelope and applies input-driven native channel volume without restarting audio", { timeout: 240_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const lantern = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-timeline-gain-editor-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "timeline-gain-editor";
  const artifactRoot = resolve(process.env.POCKET_TIMELINE_GAIN_ARTIFACT_DIR?.trim() || join(repository, "sdk/.pocket-build/timeline-gain/editor"));
  const sourceHash = process.env.POCKET_SOURCE_HASH?.trim();
  assert.ok(sourceHash, "set POCKET_SOURCE_HASH to the frozen runtime source hash before this test");
  const toolsPackage = process.env.POCKET_TOOLS_PACKAGE?.trim();
  assert.ok(toolsPackage, "set POCKET_TOOLS_PACKAGE to the accepted pinned native tools package before this test");
  const nativeProbe = resolve(process.env.POCKET_NATIVE_PROBE?.trim() || join(toolsPackage, "bin/pocket_probe"));
  assert.ok(existsSync(nativeProbe), `the matching pinned pocket_probe must exist: ${nativeProbe}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  rmSync(join(artifactRoot, "build-failure.json"), { force: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "fonts.json", "fonts", "novel.locales.json"]) {
    cpSync(join(lantern, name), join(project, name), { recursive: true });
  }
  mkdirSync(join(project, "art"), { recursive: true });
  copyFileSync(join(lantern, "art/station.png"), join(project, "art/station.png"));
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  writeFileSync(join(project, "assets/audio/table-tone.wav"), minimalPcmWav());
  writeFileSync(join(project, "editor.json"), JSON.stringify({
    id: projectId,
    appId: projectId,
    name: "Timeline Gain Editor Acceptance",
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
        { type: "scene", background: "station", transition: { kind: "cut", durationMs: 0 } },
        { type: "say", id: "wind-line", text: "A steady wind rises over the harbor." },
        { type: "ending", id: "wind-end", text: "The harbor falls quiet." },
      ],
    },
  };
  const assets = { backgrounds: { station: "art/station.png" }, characters: {}, cgs: {}, audio: { "table-tone": "audio/table-tone.wav" } };
  writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  writeFileSync(join(project, "images.json"), "{}\n");
  writeFileSync(join(project, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";
import { onCleanup } from "solid-js";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { createNovelAudioAdapter } from "@pocket/vn/audio";
import { attachNovelClock } from "@pocket/vn/clock";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";

const engine = createNovelEngine(story as StoryDefinition, { preferences: { textSpeedCharsPerSecond: 0 } });
function App() {
  const host = createHostBridge();
  const audio = createNovelAudioAdapter(host, assets.audio);
  const removeAudio = engine.subscribe(update => audio.apply(update), { emitCurrent: true });
  const removeClock = attachNovelClock(engine);
  onCleanup(() => { removeAudio(); removeClock(); audio.dispose(); engine.dispose(); host.dispose(); });
  return <NovelView engine={engine} host={host} assets={assets as NovelAssets} title="Timeline gain editor" onNewGame={() => engine.start()} />;
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

    phase = "gain track and keyframe authoring";
    await page.getByRole("button", { name: "＋ 添加音量包络轨", exact: true }).click();
    await page.getByLabel("音量 1 gain 1", { exact: true }).fill("0");
    await page.getByRole("button", { name: "＋ 添加音量包络轨", exact: true }).click();
    assert.equal(await page.getByLabel("音量轨道 2 声道", { exact: true }).inputValue(), "sfx-2");
    await page.locator(".nv-timeline-gain-track").nth(1).getByRole("button", { name: "删除音量轨", exact: true }).click();
    assert.equal(await page.locator(".nv-timeline-gain-track").count(), 1, "a gain track can be deleted from the same story draft");
    await page.getByRole("button", { name: "＋ 添加音频 cue", exact: true }).click();
    await page.getByLabel("音频 Cue 1", { exact: true }).selectOption("table-tone");
    await page.getByLabel("音频声道 1", { exact: true }).fill("harbor-wind");
    await page.getByLabel("音频循环 1", { exact: true }).check();
    await page.getByLabel("音量轨道 1 声道", { exact: true }).fill("harbor-wind");
    await page.getByLabel("音量轨道 1 声道", { exact: true }).press("Tab");

    await page.getByRole("button", { name: "＋ 添加音量关键帧", exact: true }).click();
    await page.getByLabel("音量 1 atMs 2", { exact: true }).fill("600");
    await page.getByLabel("音量 1 easing 2", { exact: true }).selectOption("easeInOut");
    await page.getByLabel("音量 1 gain 2", { exact: true }).fill("1");
    await page.getByRole("button", { name: "＋ 添加音量关键帧", exact: true }).click();
    await page.getByLabel("音量 1 atMs 3", { exact: true }).fill("900");
    await page.getByRole("button", { name: "＋ 添加音量关键帧", exact: true }).click();
    await page.locator(".nv-timeline-gain-track").first().getByRole("button", { name: "移除音量关键帧", exact: true }).last().click();
    assert.equal(await page.getByLabel("音量 1 atMs 4", { exact: true }).count(), 0, "a gain keyframe can be removed from its track");
    await page.getByLabel("音量 1 atMs 3", { exact: true }).fill("1200");
    await page.getByLabel("音量 1 gain 3", { exact: true }).fill("0");
    const gainLane = page.locator('.nv-timeline-chart-row[data-timeline-track-key="audioGain:0"]');
    assert.equal(await gainLane.locator('.nv-timeline-chart-marker[data-at-ms="600"]').count(), 1);
    assert.equal(await gainLane.locator('.nv-timeline-chart-marker[data-at-ms="1200"]').count(), 1);
    assert.equal(await gainLane.locator(".nv-timeline-chart-marker").count(), 3);

    phase = "marker updates and shared undo redo";
    await page.getByLabel("音量 1 atMs 2", { exact: true }).fill("700");
    assert.equal(await gainLane.locator('.nv-timeline-chart-marker[data-at-ms="700"]').count(), 1, "editing a gain time moves its chart marker");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("音量 1 atMs 2", { exact: true }).inputValue(), "600");
    assert.equal(await page.locator('.nv-timeline-chart-row[data-timeline-track-key="audioGain:0"] .nv-timeline-chart-marker[data-at-ms="600"]').count(), 1);
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("音量 1 atMs 2", { exact: true }).inputValue(), "700");
    assert.equal(await page.locator('.nv-timeline-chart-row[data-timeline-track-key="audioGain:0"] .nv-timeline-chart-marker[data-at-ms="700"]').count(), 1);
    await page.getByLabel("音量 1 atMs 2", { exact: true }).fill("600");

    phase = "scene assignment, preset rename and save";
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.locator(".nv-instruction").first().getByLabel("场景时间轴", { exact: true }).selectOption("timeline_1");
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByLabel("预设 ID", { exact: true }).fill("wind_curve");
    await page.getByLabel("预设 ID", { exact: true }).press("Tab");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    assert.equal(await page.locator(".nv-instruction").first().getByLabel("场景时间轴", { exact: true }).inputValue(), "wind_curve", "renaming the preset keeps its scene association");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = readStory();
    assert.equal(saved.script.start[0].timeline, "wind_curve");
    assert.deepEqual(saved.timelines.wind_curve, {
      durationMs: 1200,
      audio: [{ atMs: 0, cue: "table-tone", action: "play", channel: "harbor-wind", loop: true }],
      audioGains: [{ channel: "harbor-wind", keyframes: [
        { atMs: 0, value: 0 },
        { atMs: 600, value: 1, easing: "easeInOut" },
        { atMs: 1200, value: 0 },
      ] }],
    });

    phase = "save and reopen";
    await page.reload();
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    assert.equal(await page.getByLabel("预设 ID", { exact: true }).inputValue(), "wind_curve");
    assert.equal(await page.getByLabel("音量轨道 1 声道", { exact: true }).inputValue(), "harbor-wind");
    assert.equal(await page.getByLabel("音量 1 atMs 2", { exact: true }).inputValue(), "600");
    assert.equal(await page.getByLabel("音量 1 gain 3", { exact: true }).inputValue(), "0");
    assert.equal(await page.getByLabel("音量 1 easing 2", { exact: true }).inputValue(), "easeInOut");
    assert.deepEqual(readStory(), saved);
    await page.screenshot({ path: join(artifactRoot, "timeline-gain-editor.png"), fullPage: true });

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
    writeFileSync(join(artifactRoot, "acceptance.json"), `${JSON.stringify({ projectId, builtRevision: status.builtRevision, runtimeAbi: metadata.runtimeAbi, sourceHash, toolsPackage, nativeProbe, timeline: saved.timelines.wind_curve, errors: pageErrors }, null, 2)}\n`);

    phase = "NativeSession input-driven audio envelope";
    native = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 45_000 });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    frame = await native.settle(frame, 10);
    const audioRequests = () => native!.requests.filter(request => request.params.channel === "harbor-wind");
    const playsAfterStart = audioRequests().filter(request => request.capability === "media.audio.play");
    assert.equal(playsAfterStart.length, 1, `starting the assigned scene must issue one play request on the gain-controlled channel; observed=${JSON.stringify(native.requests)}`);
    frame = await native.settle(frame, 18);
    let channelRequests = audioRequests();
    let volumeRequests = channelRequests.filter(request => request.capability === "media.audio.volume");
    assert.ok(volumeRequests.some(request => typeof request.params.volume === "number" && request.params.volume > 0.05 && request.params.volume < 0.7), "the middle of the gain envelope must produce a real native volume request");
    frame = await native.settle(frame, 58);
    channelRequests = audioRequests();
    volumeRequests = channelRequests.filter(request => request.capability === "media.audio.volume");
    assert.equal(volumeRequests.at(-1)?.params.volume, 0, "after the timeline ends, its final gain keyframe must be the last native volume request");
    assert.equal(channelRequests.filter(request => request.capability === "media.audio.play").length, 1, "gain changes must keep the active native player and never restart its cue");
    writeFileSync(join(artifactRoot, "native-audio-requests.json"), `${JSON.stringify({ plays: channelRequests.filter(request => request.capability === "media.audio.play"), volumes: volumeRequests }, null, 2)}\n`);
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
