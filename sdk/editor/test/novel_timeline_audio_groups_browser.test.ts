import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { test } from "bun:test";
import { NativeSession, textOf } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";

function minimalPcmWav(): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(2, 40);
  bytes.writeInt16LE(0, 44);
  return bytes;
}

test("audio group authoring builds the saved crossfade and sends native channel volumes from real Chromium", { timeout: 240_000 }, async () => {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-timeline-audio-groups-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "timeline-audio-groups";
  const artifactRoot = join(repository, "sdk/.pocket-build/crossfade-20261109/editor");
  const toolsPackage = process.env.POCKET_TOOLS_PACKAGE?.trim();
  assert.ok(toolsPackage, "set POCKET_TOOLS_PACKAGE to the pinned native tools package before this test");
  const nativeProbe = resolve(process.env.POCKET_NATIVE_PROBE?.trim() || join(toolsPackage, "bin/pocket_probe"));
  assert.ok(existsSync(nativeProbe), `the matching pinned pocket_probe must exist: ${nativeProbe}`);
  const sourceFiles = [
    "sdk/packages/pocket_vn/src/audio.ts",
    "sdk/packages/pocket_vn/src/engine.ts",
    "sdk/packages/pocket_vn/src/timeline.ts",
    "sdk/packages/pocket_vn/src/types.ts",
    "sdk/packages/pocket_vn/src/editor-runtime.ts",
    "sdk/editor/novel.ts",
    "sdk/editor/client/novel.js",
  ];
  const sourceHashes = Object.fromEntries(sourceFiles.map(path => [
    path,
    createHash("sha256").update(readFileSync(join(repository, path))).digest("hex"),
  ]));
  const sourceHash = sourceHashes["sdk/packages/pocket_vn/src/audio.ts"]!.slice(0, 8);
  mkdirSync(artifactRoot, { recursive: true });
  for (const filename of [
    "acceptance.json", "acceptance-failure.json", "build-failure.json", "editor-build-logs.json",
    "native-audio-requests.json", "native-audio-summary.json", "crossfade-editor.png",
    "app.qjbc", "app.pak", "app.bytecode.json", "story.json",
  ]) rmSync(join(artifactRoot, filename), { force: true });
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    cpSync(join(source, name), join(project, name), { recursive: true });
  }
  writeFileSync(join(project, "assets/audio/theme-a.wav"), minimalPcmWav());
  writeFileSync(join(project, "assets/audio/theme-b.wav"), minimalPcmWav());
  writeFileSync(join(project, "assets/audio/click.wav"), minimalPcmWav());
  writeFileSync(join(project, "editor.json"), JSON.stringify({
    id: projectId,
    appId: projectId,
    name: "Timeline Audio Groups",
    version: "0.1.0",
    entry: "app.tsx",
    framework: "solid",
    build: 1,
    tickHz: 60,
  }));
  const story = {
    id: projectId,
    version: 1,
    start: "start",
    script: {
      start: [
        { type: "scene", background: null, timeline: "crossfade" },
        { type: "say", id: "mix-line", text: "The music crossfades without another authoring system." },
        { type: "ending", id: "mix-end", text: "Done." },
      ],
      audio_examples: [
        { type: "audio", cue: "theme-a", action: "play", channel: "music-example", loop: true },
        { type: "audio", cue: "click", action: "play", loop: false },
      ],
    },
    timelines: {
      crossfade: {
        durationMs: 1200,
        audio: [
          { atMs: 0, cue: "theme-a", action: "play", channel: "music-a", loop: true },
          { atMs: 0, cue: "theme-b", action: "play", channel: "music-b", loop: true },
          { atMs: 0, cue: "click", action: "play", channel: "ui-click", loop: false, group: "effects" },
        ],
        audioGains: [
          { channel: "music-a", keyframes: [{ atMs: 0, value: 1 }, { atMs: 1200, value: 0 }] },
          { channel: "music-b", keyframes: [{ atMs: 0, value: 0 }, { atMs: 1200, value: 1 }] },
        ],
      },
    },
  };
  const assets = { backgrounds: {}, characters: {}, cgs: {}, audio: {
    "theme-a": "audio/theme-a.wav",
    "theme-b": "audio/theme-b.wav",
    click: "audio/click.wav",
  } };
  const storyPath = join(project, "story.json");
  writeFileSync(storyPath, `${JSON.stringify(story, null, 2)}\n`);
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
  const audio = createNovelAudioAdapter(host, assets.audio, { initialMix: { master: 0.8, music: 0.25, effects: 0.75, voice: 1 } });
  const removeAudio = engine.subscribe(update => audio.apply(update), { emitCurrent: true });
  const removeClock = attachNovelClock(engine);
  onCleanup(() => { removeAudio(); removeClock(); audio.dispose(); engine.dispose(); host.dispose(); });
  return <NovelView engine={engine} host={host} assets={assets as NovelAssets} title="Audio group test" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = nativeProbe;
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "Editor authoring";
  const pageErrors: string[] = [];
  const readStory = () => JSON.parse(readFileSync(storyPath, "utf8"));
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.locator(".nv-label").filter({ hasText: "audio_examples" }).click();
    const audioInstructions = page.locator(".nv-instruction").filter({ has: page.getByLabel("音频 cue", { exact: true }) });
    await audioInstructions.first().getByLabel("混音分组", { exact: true }).selectOption("music");
    const secondAudio = audioInstructions.nth(1);
    assert.equal(await secondAudio.getByLabel("声道", { exact: true }).inputValue(), "", "an omitted channel remains visibly empty instead of suggesting a non-persisted default");
    await secondAudio.getByLabel("混音分组", { exact: true }).selectOption("effects");
    await page.locator("#novel-diagnostics").getByText(/group requires a non-empty channel/).waitFor();
    const secondChannel = secondAudio.getByLabel("声道", { exact: true });
    await secondChannel.fill("effects-example");
    await page.waitForFunction(() => !document.querySelector("#novel-diagnostics")?.textContent?.includes("group requires a non-empty channel"));
    assert.equal(await secondChannel.evaluate(element => document.activeElement === element), true, "editing the channel clears its diagnostic on input without waiting for blur or save");
    await secondAudio.getByLabel("混音分组", { exact: true }).selectOption("");
    await secondChannel.fill("__pocket_vn_voice");
    await page.locator("#novel-diagnostics").getByText("Dialogue voice channel is reserved.", { exact: true }).waitFor();
    await secondChannel.fill("effects-example");
    await page.waitForFunction(() => !document.querySelector("#novel-diagnostics")?.textContent?.includes("Dialogue voice channel is reserved."));
    await secondAudio.getByLabel("混音分组", { exact: true }).selectOption("effects");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    assert.equal(readStory().script.audio_examples[1].channel, "effects-example", "naming the channel repairs the explicit group and allows it to save");
    assert.equal(readStory().script.audio_examples[1].group, "effects");
    await secondAudio.getByLabel("动作", { exact: true }).selectOption("stop");
    assert.equal(await secondAudio.getByLabel("混音分组", { exact: true }).inputValue(), "", "changing an audio instruction to stop removes its explicit group");
    await clickNovelHistory(page, "undo");
    assert.equal(await secondAudio.getByLabel("动作", { exact: true }).inputValue(), "play");
    assert.equal(await secondAudio.getByLabel("混音分组", { exact: true }).inputValue(), "effects", "undo restores the group with the play instruction");
    await clickNovelHistory(page, "redo");
    assert.equal(await secondAudio.getByLabel("混音分组", { exact: true }).inputValue(), "");
    await secondAudio.getByLabel("动作", { exact: true }).selectOption("play");
    await secondAudio.getByLabel("混音分组", { exact: true }).selectOption("effects");
    await secondAudio.getByLabel("声道", { exact: true }).fill("");
    assert.equal(await secondAudio.getByLabel("混音分组", { exact: true }).inputValue(), "", "clearing a channel removes its explicit group");
    await secondAudio.getByLabel("声道", { exact: true }).fill("effects-example");
    await secondAudio.getByLabel("混音分组", { exact: true }).selectOption("effects");

    await page.getByRole("button", { name: "对白表格", exact: true }).click();
    await page.getByLabel("指令范围", { exact: true }).selectOption("all");
    const tableGroup = page.getByLabel("混音分组 audio_examples:1", { exact: true });
    await page.getByLabel("动作 audio_examples:1", { exact: true }).selectOption("stop");
    assert.equal(await tableGroup.inputValue(), "", "the all-instruction table also removes a group when changing to stop");
    await page.getByLabel("动作 audio_examples:1", { exact: true }).selectOption("play");
    await tableGroup.selectOption("music");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("混音分组 audio_examples:1", { exact: true }).inputValue(), "");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("混音分组 audio_examples:1", { exact: true }).inputValue(), "music");
    await page.getByLabel("混音分组 audio_examples:1", { exact: true }).selectOption("effects");
    await page.getByLabel("声道 audio_examples:1", { exact: true }).fill("");
    assert.equal(await page.getByLabel("混音分组 audio_examples:1", { exact: true }).inputValue(), "", "the all-instruction table removes a group when clearing its channel");
    await page.getByLabel("声道 audio_examples:1", { exact: true }).fill("effects-example");
    await page.getByLabel("混音分组 audio_examples:1", { exact: true }).selectOption("effects");

    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByLabel("混音分组 1", { exact: true }).selectOption("music");
    await page.getByLabel("混音分组 2", { exact: true }).selectOption("music");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("混音分组 2", { exact: true }).inputValue(), "", "timeline cue group changes participate in shared history");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("混音分组 2", { exact: true }).inputValue(), "music");
    await page.getByLabel("音频动作 2", { exact: true }).selectOption("stop");
    assert.equal(await page.getByLabel("混音分组 2", { exact: true }).inputValue(), "", "a timeline stop cue removes its explicit group");
    await page.getByLabel("音频动作 2", { exact: true }).selectOption("play");
    await page.getByLabel("混音分组 2", { exact: true }).selectOption("music");
    await page.getByLabel("音频声道 1", { exact: true }).fill("");
    assert.equal(await page.getByLabel("混音分组 1", { exact: true }).inputValue(), "", "clearing a timeline cue channel removes its explicit group");
    await page.getByLabel("音频声道 1", { exact: true }).fill("music-a");
    await page.getByLabel("混音分组 1", { exact: true }).selectOption("music");
    await page.getByLabel("音量 1 gain 2", { exact: true }).fill("0.2");
    await page.getByLabel("音量 2 gain 2", { exact: true }).fill("0.8");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("音量 2 gain 2", { exact: true }).inputValue(), "1");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("音量 2 gain 2", { exact: true }).inputValue(), "0.8");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = readStory();
    assert.equal(saved.script.audio_examples[0].group, "music");
    assert.equal(saved.script.audio_examples[1].group, "effects");
    assert.deepEqual(saved.timelines.crossfade.audio.map((cue: any) => cue.group), ["music", "music", "effects"]);
    assert.deepEqual(saved.timelines.crossfade.audioGains.map((track: any) => track.keyframes.map((frame: any) => frame.value)), [[1, 0.2], [0, 0.8]]);

    await page.reload();
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    assert.equal(await page.getByLabel("混音分组 1", { exact: true }).inputValue(), "music");
    assert.equal(await page.getByLabel("混音分组 2", { exact: true }).inputValue(), "music");
    assert.equal(await page.getByLabel("音量 1 gain 2", { exact: true }).inputValue(), "0.2");
    assert.equal(await page.getByLabel("音量 2 gain 2", { exact: true }).inputValue(), "0.8");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.locator(".nv-label").filter({ hasText: "audio_examples" }).click();
    const reopenedAudio = page.locator(".nv-instruction").filter({ has: page.getByLabel("音频 cue", { exact: true }) });
    assert.equal(await reopenedAudio.first().getByLabel("混音分组", { exact: true }).inputValue(), "music");
    assert.equal(await reopenedAudio.nth(1).getByLabel("混音分组", { exact: true }).inputValue(), "effects");

    phase = "pinned Editor buildGuest";
    const buildButton = page.locator("#novel-build");
    assert.equal(await buildButton.isDisabled(), false, "a saved valid story can be built by the Editor");
    await buildButton.click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    assert.match(await page.locator("#novel-notice").innerText(), /Guest 已构建完成/);
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as {
      builtRevision: number;
      revision: number;
      logs?: string[];
    };
    assert.equal(status.builtRevision, status.revision, "the built bytecode must match the saved story revision");
    const buildDirectory = join(workspace, "builds", projectId, String(status.builtRevision));
    const bytecodePath = join(buildDirectory, "app.qjbc");
    const pakPath = join(buildDirectory, "app.pak");
    const metadataPath = join(buildDirectory, "app.bytecode.json");
    assert.ok(existsSync(bytecodePath) && existsSync(pakPath) && existsSync(metadataPath), "the Editor must produce pinned Guest artifacts");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    for (const [sourceFile, artifactFile] of [
      [bytecodePath, "app.qjbc"], [pakPath, "app.pak"], [metadataPath, "app.bytecode.json"], [storyPath, "story.json"],
    ]) copyFileSync(sourceFile, join(artifactRoot, artifactFile));
    writeFileSync(join(artifactRoot, "editor-build-logs.json"), `${JSON.stringify(status.logs ?? [], null, 2)}\n`);
    const accepted = {
      projectId,
      builtRevision: status.builtRevision,
      runtimeAbi: metadata.runtimeAbi,
      sourceHash,
      sourceHashes,
      toolsPackage,
      nativeProbe,
      initialMix: { master: 0.8, music: 0.25, effects: 0.75, voice: 1 },
      savedTimeline: saved.timelines.crossfade,
      artifacts: {
        bytecodeBytes: readFileSync(bytecodePath).byteLength,
        pakBytes: readFileSync(pakPath).byteLength,
      },
      pageErrors,
    };
    writeFileSync(join(artifactRoot, "acceptance.json"), `${JSON.stringify(accepted, null, 2)}\n`);
    await page.screenshot({ path: join(artifactRoot, "crossfade-editor.png"), fullPage: true });

    phase = "NativeSession timeline and effects volumes";
    native = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 45_000 });
    let frame = await native.boot();
    assert.ok(textOf(frame).includes("启程 · 开始新的故事"), `Guest title page did not expose the start action: ${textOf(frame)}`);
    frame = await native.tap("启程 · 开始新的故事", frame);
    frame = await native.settle(frame, 12);
    const channelRequests = (channel: string) => native!.requests.filter(request => request.params.channel === channel);
    const playRequest = (channel: string) => {
      const matches = channelRequests(channel).filter(request => request.capability === "media.audio.play");
      assert.equal(matches.length, 1, `${channel} must play once; observed=${JSON.stringify(channelRequests(channel))}`);
      return matches[0]!;
    };
    assert.ok(Math.abs(Number(playRequest("music-a").params.volume) - 0.2) < 1e-6, "music-a starts at master × music × gain = 0.2");
    assert.ok(Math.abs(Number(playRequest("music-b").params.volume)) < 1e-6, "music-b starts at zero gain");
    assert.ok(Math.abs(Number(playRequest("ui-click").params.volume) - 0.6) < 1e-6, "the effects cue starts at master × effects = 0.6");
    frame = await native.settle(frame, 90);
    const latestVolume = (channel: string): number => {
      const volumes = channelRequests(channel).filter(request => request.capability === "media.audio.volume");
      assert.ok(volumes.length > 0, `${channel} must issue a real media.audio.volume request; observed=${JSON.stringify(native!.requests)}`);
      return Number(volumes.at(-1)!.params.volume);
    };
    const musicAFinal = latestVolume("music-a");
    const musicBFinal = latestVolume("music-b");
    assert.ok(Math.abs(musicAFinal - 0.04) < 1e-5, `music-a final volume must be 0.8 × 0.25 × 0.2; got ${musicAFinal}`);
    assert.ok(Math.abs(musicBFinal - 0.16) < 1e-5, `music-b final volume must be 0.8 × 0.25 × 0.8; got ${musicBFinal}`);
    const nativeAudioRequests = native.requests.filter(request => request.capability === "media.audio.play" || request.capability === "media.audio.volume");
    writeFileSync(join(artifactRoot, "native-audio-requests.json"), `${JSON.stringify(nativeAudioRequests, null, 2)}\n`);
    writeFileSync(join(artifactRoot, "native-audio-summary.json"), `${JSON.stringify({
      musicAInitial: playRequest("music-a").params.volume,
      musicAFinal,
      musicBInitial: playRequest("music-b").params.volume,
      musicBFinal,
      effectsInitial: playRequest("ui-click").params.volume,
      volumes: {
        musicA: channelRequests("music-a").filter(request => request.capability === "media.audio.volume"),
        musicB: channelRequests("music-b").filter(request => request.capability === "media.audio.volume"),
      },
      errors: pageErrors,
    }, null, 2)}\n`);
    assert.deepEqual(pageErrors, []);

    const beforeInvalidSave = readStory();
    await reopenedAudio.nth(1).getByLabel("动作", { exact: true }).selectOption("stop");
    await reopenedAudio.nth(1).getByLabel("混音分组", { exact: true }).selectOption("effects");
    await page.locator("#novel-diagnostics").getByText(/group is only valid when action is 'play'/).waitFor();
    await page.locator("#novel-save").click();
    await page.getByText(/保存失败/).waitFor();
    assert.deepEqual(readStory(), beforeInvalidSave, "the Editor route must reject and preserve a story with group on a stop instruction");

    await reopenedAudio.nth(1).getByLabel("混音分组", { exact: true }).selectOption("");
    await reopenedAudio.nth(1).getByLabel("动作", { exact: true }).selectOption("play");
    await reopenedAudio.nth(1).getByLabel("混音分组", { exact: true }).selectOption("effects");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    assert.deepEqual(readStory(), beforeInvalidSave, "repairing the draft restores the accepted authored group");

    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByLabel("音频声道 1", { exact: true }).fill("music");
    await page.getByLabel("混音分组 1", { exact: true }).selectOption("effects");
    await page.locator("#novel-save").click();
    await page.getByText(/保存失败/).waitFor();
    await page.locator(".nv-timeline-schema-error").getByText(/group must be 'music'/).waitFor();
    assert.deepEqual(readStory(), beforeInvalidSave, "the shared timeline schema must reject effects routing on the music channel");
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    const status = await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)
      .then(response => response.json())
      .catch(value => ({ diagnostic: String(value) }));
    const statePath = join(workspace, "states", `${projectId}.json`);
    writeFileSync(join(artifactRoot, "acceptance-failure.json"), `${JSON.stringify({
      phase,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      status,
      state: existsSync(statePath) ? readFileSync(statePath, "utf8") : null,
      story: existsSync(storyPath) ? readStory() : null,
      nativeRequests: native?.requests ?? [],
      pageErrors,
    }, null, 2)}\n`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; browserErrors=${JSON.stringify(pageErrors)}`);
  } finally {
    await native?.quit();
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    await browser?.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
