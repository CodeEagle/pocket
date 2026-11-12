import { strict as assert } from "node:assert";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Locator, type Page } from "playwright";
import { test } from "bun:test";
import { NativeSession, type DrawOp, type Frame } from "../../../demo/js/tests/native_session.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";

const repository = resolve(import.meta.dir, "../../..");
const viewport = { width: 360, height: 640 };

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

function marker(page: Page, track: string, index: number): Locator {
  return page.locator(`#novel-timeline-chart .nv-timeline-chart-marker[data-timeline-track-key="${track}"][data-frame-index="${index}"]`);
}

async function dragMarker(page: Page, target: Locator, targetMs: number, durationMs = 1000): Promise<void> {
  const from = await target.boundingBox();
  const lane = await target.locator("..").boundingBox();
  assert.ok(from && lane && lane.width > 0, "timeline marker and lane must be visible");
  const currentMs = Number(await target.getAttribute("data-at-ms"));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  const targetX = from.x + from.width / 2 + (targetMs - currentMs) / durationMs * lane.width;
  await page.mouse.move(targetX, from.y + from.height / 2, { steps: 10 });
  await page.mouse.up();
}

function imageOp(frame: Frame, asset: string): DrawOp {
  const found = (frame.ops ?? []).find(op => op.type === "image" && (op as DrawOp & { asset?: string }).asset === asset);
  assert.ok(found, `NativeSession must draw ${asset}`);
  return found!;
}

function imageRect(frame: Frame, asset: string): number[] {
  const op = imageOp(frame, asset);
  return [op.x, op.y, op.w, op.h].map(value => Number(value));
}

function rectDelta(a: number[], b: number[]): number {
  return a.reduce((total, value, index) => total + Math.abs(value - b[index]!), 0);
}

function imageUv(frame: Frame, asset: string): number[] {
  const op = imageOp(frame, asset) as DrawOp & { uv?: number[] };
  assert.ok(Array.isArray(op.uv) && op.uv.length === 4, "native camera sampling must expose the background UV crop");
  return [...op.uv!];
}

function uvDelta(a: number[], b: number[]): number {
  return a.reduce((total, value, index) => total + Math.abs(value - b[index]!), 0);
}

function timelineAudio(session: NativeSession): string[] {
  return session.requests.filter(request => request.capability === "media.audio.play").map(request => String(request.params.asset));
}

function dialoguePoint(): { x: number; y: number } {
  return { x: 180, y: 565 };
}

async function waitForText(session: NativeSession, initial: Frame, expected: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 50; index++) {
    if ((frame.ops ?? []).some(op => op.type === "text" && op.text === expected)) return frame;
    frame = await session.frame();
  }
  throw new Error(`NativeSession did not paint ${expected}`);
}

test("timeline markers drag transactionally and saved times drive the pinned native Guest", { timeout: 360_000 }, async () => {
  const lantern = join(repository, "demo/js/apps/lantern");
  const temporary = mkdtempSync(join(tmpdir(), "pocket-timeline-drag-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "timeline-drag";
  const artifactRoot = resolve(process.env.POCKET_TIMELINE_ARTIFACT_DIR?.trim() || join(repository, "sdk/.pocket-build/timeline-accessibility/editor-drag"));
  const toolsPackage = resolve(process.env.POCKET_TOOLS_PACKAGE?.trim() || "");
  assert.ok(process.env.POCKET_TOOLS_PACKAGE?.trim(), "POCKET_TOOLS_PACKAGE must name the accepted pinned native-tools package");
  const nativeProbe = resolve(toolsPackage, "bin/pocket_probe");
  assert.ok(existsSync(nativeProbe), `pinned pocket_probe must exist: ${nativeProbe}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  for (const name of ["pocket.json", "manifest.json", "package.json", "novel.locales.json"]) {
    cpSync(join(lantern, name), join(project, name), { recursive: true });
  }
  mkdirSync(join(project, "art"), { recursive: true });
  for (const name of ["station.png", "mira-neutral.png"]) copyFileSync(join(lantern, `art/${name}`), join(project, `art/${name}`));
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  for (const name of ["opening", "arrival", "ambient"]) writeFileSync(join(project, `assets/audio/${name}.wav`), minimalPcmWav());
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: projectId, name: "Timeline Drag Acceptance", version: "0.1.0", entry: "app.tsx", framework: "solid", build: 1, tickHz: 60 }, null, 2));

  const story = {
    id: projectId,
    version: 1,
    start: "start",
    timelines: {
      choreography: {
        durationMs: 1000,
        camera: [
          { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
          { atMs: 400, value: { x: 120, y: -20, scale: 1.2 } },
          { atMs: 900, value: { x: 200, y: -35, scale: 1.4 } },
        ],
        actors: [{ id: "mira", keyframes: [
          { atMs: 0, value: { position: { x: 0, y: 230 }, scale: 1, rotation: 0 } },
          { atMs: 400, value: { position: { x: 120, y: 190 }, scale: 1.1, rotation: 0 } },
          { atMs: 900, value: { position: { x: 220, y: 150 }, scale: 1.2, rotation: 0 } },
        ] }],
        audio: [
          { atMs: 0, cue: "opening", action: "play", channel: "music", loop: true },
          { atMs: 400, cue: "arrival", action: "play", channel: "sfx", loop: false },
          { atMs: 700, cue: "ambient", action: "play", channel: "ambience", loop: false },
        ],
        audioGains: [{ channel: "music", keyframes: [
          { atMs: 0, value: 1 }, { atMs: 400, value: 0.4 }, { atMs: 900, value: 0.1 },
        ] }],
      },
      backup: { durationMs: 1000, camera: [
        { atMs: 0, value: { x: 0, y: 0, scale: 1 } },
        { atMs: 300, value: { x: 10, y: 0, scale: 1 } },
      ] },
    },
    script: { start: [
      { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", position: { x: 0, y: 230 }, visible: true }], transition: { kind: "cut", durationMs: 0 } },
      { type: "say", id: "before-timeline", text: "Before the edited timeline." },
      { type: "scene", timeline: "choreography" },
      { type: "say", id: "after-timeline", text: "The saved timeline is running." },
      { type: "ending", id: "timeline-end", text: "The timeline settles." },
    ] },
  };
  const assets = {
    backgrounds: { station: "art/station.png" },
    characters: { mira: { neutral: "art/mira-neutral.png" } },
    cgs: {},
    audio: { opening: "audio/opening.wav", arrival: "audio/arrival.wav", ambient: "audio/ambient.wav" },
  };
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
  const audio = createNovelAudioAdapter(host, (assets as NovelAssets).audio ?? {});
  const removeAudio = engine.subscribe(update => audio.apply(update), { emitCurrent: true });
  const removeClock = attachNovelClock(engine);
  onCleanup(() => { removeClock(); removeAudio(); audio.dispose(); engine.dispose(); host.dispose(); });
  return <NovelView engine={engine} host={host} assets={assets as NovelAssets} title="Timeline drag" onNewGame={() => engine.start()} />;
}
mount(App);
`);

  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = nativeProbe;
  const server = await startEditor({ port: 0, updatePort: 0, workspace, projectRoot: project });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "browser";
  const pageErrors: string[] = [];
  const readStory = () => JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.addEventListener("pointerdown", event => { (window as any).__timelinePointerId = event.pointerId; }, true);
    });
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByLabel("当前时间轴预设", { exact: true }).selectOption("choreography");
    const camera = marker(page, "camera", 1);
    const actor = marker(page, "actor:0", 1);
    const cue = marker(page, "audio", 1);
    const gain = marker(page, "audioGain:0", 1);
    assert.equal(await marker(page, "camera", 0).isDisabled(), true, "camera first frame cannot move");
    assert.equal(await marker(page, "actor:0", 0).isDisabled(), true, "actor first frame cannot move");
    assert.equal(await marker(page, "audioGain:0", 0).isDisabled(), true, "gain first frame cannot move");
    assert.equal(await marker(page, "audio", 0).isDisabled(), false, "cue events do not use motion ordering constraints");
    assert.match(await page.locator(".nv-timeline-chart-help").innerText(), /Shift.*1 ms/);

    phase = "cancel paths and preset isolation";
    for (const cancel of ["escape", "pointercancel", "undo"] as const) {
      const target = cancel === "escape" ? camera : cancel === "pointercancel" ? actor : gain;
      const from = await target.boundingBox();
      const lane = await target.locator("..").boundingBox();
      assert.ok(from && lane);
      await target.evaluate(element => {
        (window as any).__capturedTimelineMarker = element;
      });
      const currentMs = Number(await target.getAttribute("data-at-ms"));
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
      await page.mouse.down();
      await page.mouse.move(from!.x + from!.width / 2 + 100 / 1000 * lane!.width, from!.y + from!.height / 2, { steps: 4 });
      assert.equal(await target.evaluate(element => element.hasPointerCapture((window as any).__timelinePointerId)), true, `${cancel} drag must own pointer capture`);
      if (cancel === "escape") {
        await page.keyboard.press("Escape");
      } else if (cancel === "pointercancel") {
        await target.evaluate(element => element.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: (window as any).__timelinePointerId })));
      } else {
        await page.keyboard.press("Control+z");
        await page.locator("#novel-undo[aria-busy='false']").waitFor();
      }
      await page.mouse.up();
      assert.equal(Number(await target.getAttribute("data-at-ms")), currentMs, `${cancel} restores the original frame value`);
      assert.equal(await page.locator("#novel-save-state").getAttribute("data-dirty"), "false", `${cancel} leaves draft dirty state unchanged`);
      assert.equal(await page.locator("#novel-undo").isDisabled(), true, `${cancel} creates no undo step`);
    }

    const mainAtMs = await page.getByLabel("相机 atMs 2", { exact: true }).inputValue();
    const from = await camera.boundingBox();
    const lane = await camera.locator("..").boundingBox();
    assert.ok(from && lane);
    await camera.evaluate(element => { (window as any).__capturedTimelineMarker = element; });
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(from!.x + from!.width / 2 + 200 / 1000 * lane!.width, from!.y + from!.height / 2, { steps: 12 });
    assert.equal(await camera.evaluate(element => element.hasPointerCapture((window as any).__timelinePointerId)), true);
    assert.equal(await camera.evaluate(element => element === (window as any).__capturedTimelineMarker), true, "refreshing live positions must keep the captured marker node");
    assert.equal(await camera.getAttribute("aria-valuenow"), "600", "pointer moves snap to 10 ms while held");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "600", "the numeric field follows the uncommitted pointer value");
    await page.waitForTimeout(350);
    assert.equal(await page.locator("#novel-save-state").getAttribute("data-dirty"), "false", "an active drag is not marked dirty");
    assert.equal(readStory().timelines.choreography.camera[1].atMs, Number(mainAtMs), "an active drag is not written to story.json");
    await page.mouse.up();
    assert.equal(await camera.getAttribute("data-at-ms"), "600");
    assert.equal(await page.locator("#novel-save-state").getAttribute("data-dirty"), "true", "release commits the story draft");
    assert.equal(await page.locator("#novel-undo").isDisabled(), false, "release records one undo entry");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "400", "one undo restores all pointer moves from the drag");
    assert.equal(await page.locator("#novel-undo").isDisabled(), true, "a whole drag consumes exactly one history entry");
    await clickNovelHistory(page, "redo");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "600");

    phase = "preset change cancellation";
    const cameraBox = await camera.boundingBox();
    const cameraLane = await camera.locator("..").boundingBox();
    assert.ok(cameraBox && cameraLane);
    await page.mouse.move(cameraBox!.x + cameraBox!.width / 2, cameraBox!.y + cameraBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(cameraBox!.x + cameraBox!.width / 2 + 100 / 1000 * cameraLane!.width, cameraBox!.y + cameraBox!.height / 2, { steps: 4 });
    await page.getByLabel("当前时间轴预设", { exact: true }).selectOption("backup");
    await page.mouse.up();
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "300", "the newly selected preset remains untouched");
    await page.getByLabel("当前时间轴预设", { exact: true }).selectOption("choreography");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "600", "the prior preset's temporary value is rolled back before rerender");

    phase = "clamps, keyboard edits, and track synchronization";
    await dragMarker(page, camera, 1020);
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "899", "motion frames clamp to one millisecond before the next frame");
    await dragMarker(page, camera, 600);
    assert.equal(await camera.getAttribute("data-at-ms"), "600", "a clamped marker can move back within its legal interval");
    await dragMarker(page, actor, 1020);
    assert.equal(await page.getByLabel("角色 1 atMs 2", { exact: true }).inputValue(), "899");
    await dragMarker(page, actor, 600);
    assert.equal(await actor.getAttribute("data-at-ms"), "600");
    await dragMarker(page, cue, 1020);
    assert.equal(await page.getByLabel("音频 atMs 2", { exact: true }).inputValue(), "1000", "cue events clamp to duration and allow the same time as another cue");
    await dragMarker(page, cue, 700);
    assert.equal(await cue.getAttribute("data-at-ms"), "700");
    await dragMarker(page, gain, 1020);
    assert.equal(await page.getByLabel("音量 1 atMs 2", { exact: true }).inputValue(), "899");
    await dragMarker(page, gain, 700);
    assert.equal(await gain.getAttribute("data-at-ms"), "700");
    await camera.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "610", "ArrowRight adjusts by 10 ms");
    await page.keyboard.press("Shift+ArrowLeft");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "609", "Shift+ArrowLeft adjusts by 1 ms");
    assert.equal(await camera.getAttribute("aria-valuenow"), "609");

    phase = "save and reload";
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = readStory();
    assert.equal(saved.timelines.choreography.camera[1].atMs, 609);
    assert.equal(saved.timelines.choreography.actors[0].keyframes[1].atMs, 600);
    assert.equal(saved.timelines.choreography.audio[1].atMs, 700);
    assert.equal(saved.timelines.choreography.audio[2].atMs, 700, "same-time audio cue ordering remains legal and unchanged");
    assert.equal(saved.timelines.choreography.audioGains[0].keyframes[1].atMs, 700);
    await page.reload();
    await page.getByRole("button", { name: "时间轴", exact: true }).click();
    await page.getByLabel("当前时间轴预设", { exact: true }).selectOption("choreography");
    assert.equal(await page.getByLabel("相机 atMs 2", { exact: true }).inputValue(), "609");
    assert.equal(await page.getByLabel("角色 1 atMs 2", { exact: true }).inputValue(), "600");
    assert.equal(await page.getByLabel("音频 atMs 2", { exact: true }).inputValue(), "700");
    assert.equal(await page.getByLabel("音量 1 atMs 2", { exact: true }).inputValue(), "700");

    phase = "pinned Guest build";
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 60_000 });
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
      copyFileSync(file === "story.json" ? join(project, file) : join(artifact, file), join(artifactRoot, `drag-${file}`));
    }

    phase = "NativeSession exercises camera, actor, cue, and gain tracks";
    native = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: String(metadata.runtimeAbi) }, { width: viewport.width, height: viewport.height, deadlineMs: 90_000 });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    frame = await waitForText(native, frame, "Before the edited timeline.");
    const initialBackground = imageUv(frame, "art/station.png");
    const initialActor = imageRect(frame, "art/mira-neutral.png");
    frame = await native.tapPoint(dialoguePoint());
    frame = await waitForText(native, frame, "The saved timeline is running.");
    const timelineStartBackground = imageUv(frame, "art/station.png");
    const timelineStartActor = imageRect(frame, "art/mira-neutral.png");
    assert.ok(uvDelta(timelineStartBackground, initialBackground) < 0.01, "timeline begins at its first camera frame");
    assert.ok(rectDelta(timelineStartActor, initialActor) < 2, "timeline begins at its first actor frame");
    assert.ok(timelineAudio(native).includes("audio/opening.wav"), "the actual guest sends the opening cue request");

    frame = await native.settle(frame, 24);
    assert.ok(uvDelta(imageUv(frame, "art/station.png"), timelineStartBackground) > 0.01, "saved camera keyframe time changes the real native background sample");
    assert.ok(rectDelta(imageRect(frame, "art/mira-neutral.png"), timelineStartActor) > 8, "saved actor keyframe time changes real native draw geometry");
    assert.ok(!timelineAudio(native).includes("audio/arrival.wav"), "arrival must still be pending before its dragged 700 ms time");
    assert.ok(!timelineAudio(native).includes("audio/ambient.wav"), "same-time ambient cue must still be pending before 700 ms");
    for (let index = 0; index < 55 && !timelineAudio(native).includes("audio/arrival.wav"); index++) frame = await native.frame();
    assert.ok(timelineAudio(native).includes("audio/arrival.wav"), "the dragged cue reaches the host only after its saved 700 ms time");
    assert.ok(timelineAudio(native).includes("audio/ambient.wav"), "a same-time cue is also dispatched by the real guest");
    frame = await native.settle(frame, 1);
    const musicVolumes = native.requests.filter(request => request.capability === "media.audio.volume" && request.params.channel === "music").map(request => Number(request.params.volume));
    assert.ok(musicVolumes.some(volume => volume > 0.22 && volume < 0.32), `the saved gain frame must reach the native audio volume near 700 ms: ${JSON.stringify(musicVolumes.slice(-8))}`);
    writeFileSync(join(artifactRoot, "drag-native-observations.json"), `${JSON.stringify({ cameraStart: timelineStartBackground, cameraLater: imageUv(frame, "art/station.png"), actorStart: timelineStartActor, actorLater: imageRect(frame, "art/mira-neutral.png"), audio: timelineAudio(native), musicVolumes: musicVolumes.slice(-8), savedTimes: { camera: saved.timelines.choreography.camera[1].atMs, actor: saved.timelines.choreography.actors[0].keyframes[1].atMs, cue: saved.timelines.choreography.audio[1].atMs, gain: saved.timelines.choreography.audioGains[0].keyframes[1].atMs } }, null, 2)}\n`);
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; browserErrors=${JSON.stringify(pageErrors)}`);
  } finally {
    await native?.quit();
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    await browser?.close();
    await server.stop(true);
    rmSync(temporary, { recursive: true, force: true });
  }
});
