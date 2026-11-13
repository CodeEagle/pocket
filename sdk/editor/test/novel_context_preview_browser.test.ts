import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { test } from "bun:test";
import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { startEditor } from "../server.ts";
import { NativeSession, textOf, textOp, type Frame } from "../../../demo/js/tests/native_session.ts";

const repository = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repository, "sdk");
const lantern = join(repository, "demo/js/apps/lantern");
const frozenProbeSha256 = "a7bad801fc1b1f7e68a4ff453138699b5632e80ba2b568b95ac6c6980682aa47";
const frozenProbePath = join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe");
const explicitProbePath = process.env.POCKET_NATIVE_PROBE?.trim();
const explicitProbeSha256 = process.env.POCKET_NATIVE_PROBE_SHA256?.trim();
const probePath = explicitProbePath ? resolve(explicitProbePath) : frozenProbePath;
const expectedProbeSha256 = explicitProbeSha256 ?? frozenProbeSha256;
const expectedBunPath = join(sdkRoot, ".pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun");
const target = { label: "chapter_two", index: 2 };
const continueLabel = "继续重建上下文";

const story = {
  id: "context-preview-acceptance",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "set", variable: "score", value: 7 },
      {
        type: "scene",
        background: "station",
        characters: [{ id: "mira", expression: "neutral", position: { x: 68, y: 164 }, visible: true }],
        camera: { x: 8, y: 12, scale: 1.1 },
        transition: { kind: "cut", durationMs: 0 },
      },
      { type: "audio", cue: "opening", action: "play", channel: "music", group: "music", loop: true },
      { type: "call", target: "chapter_two_gate" },
      { type: "say", id: "after-return", speaker: "旁白", text: "本章返回后才会出现这条对白。" },
      { type: "ending", id: "story-end", text: "结束" },
    ],
    chapter_two_gate: [
      { type: "wait", durationMs: 24 },
      {
        type: "choice",
        id: "chapter-route",
        prompt: "选择本章路线",
        options: [
          { id: "current", text: "进入本章", target: "chapter_two" },
          { id: "alternate", text: "走未执行路线", target: "alternate_route" },
        ],
      },
    ],
    chapter_two: [
      { type: "input", id: "chapter-code", variable: "code", inputType: "text", prompt: "请填写本章验证码", placeholder: "输入线路代号", minLength: 1, maxLength: 8 },
      {
        type: "scene",
        characters: [{ id: "mira", expression: "hopeful", position: { x: 212, y: 168 }, visible: true }],
        camera: { x: 21, y: -9, scale: 1.4 },
        transition: { kind: "cut", durationMs: 0 },
      },
      { type: "say", id: "current-line", speaker: "Mira", text: "线路 {{code}} 已确认；分数 {{score}}。" },
      { type: "return" },
    ],
    alternate_route: [
      {
        type: "scene",
        background: "archive",
        characters: [{ id: "ren", expression: "neutral", position: { x: 210, y: 164 }, visible: true }],
        camera: { x: -30, y: 16, scale: 0.9 },
        transition: { kind: "cut", durationMs: 0 },
      },
      { type: "say", id: "alternate-line", text: "未执行的另一条路线。" },
      { type: "return" },
    ],
  },
};

const assets = {
  backgrounds: { station: "art/station.png", archive: "art/archive.png" },
  characters: {
    mira: { neutral: "art/mira-neutral.png", hopeful: "art/mira-hopeful.png" },
    ren: { neutral: "art/ren-neutral.png" },
  },
  cgs: {},
  audio: { opening: "audio/opening.wav" },
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function contextStatus(page: import("playwright").Page): import("playwright").Locator {
  return page.locator("#novel-context-preview-status");
}

async function chooseTarget(page: import("playwright").Page, address: { label: string; index: number }): Promise<void> {
  await page.locator(".nv-jump-control select").selectOption(address.label);
  await page.locator(".nv-jump-control input").fill(String(address.index));
}

function guestSource(): string {
  return `
import { createSignal, onCleanup, Show } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelContextPreview, continueNovelContextPreview, type StoryDefinition } from "@pocket/vn";
import { createNovelAudioAdapter } from "@pocket/vn/audio";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import storyDocument from "./story.json";
import assetsDocument from "./novel.assets.json";

const target = ${JSON.stringify(target)};
function statusOf(result: any): string {
  return result.status === "blocked" ? (result.blocker?.kind ?? result.snapshot.phase) : result.status;
}

function App() {
  const host = createHostBridge();
  const result = createNovelContextPreview(storyDocument as StoryDefinition, target, { maxTransitions: 512 });
  const engine = result.engine;
  const [status, setStatus] = createSignal(statusOf(result));
  const [snapshot, setSnapshot] = createSignal(result.snapshot);
  const audio = createNovelAudioAdapter(host, (assetsDocument as NovelAssets).audio);
  const removeAudio = engine.subscribe(update => { setSnapshot(update.snapshot); audio.apply(update); }, { emitCurrent: true });
  onCleanup(() => { removeAudio(); audio.dispose(); engine.dispose(); host.dispose(); });

  const resumeContext = () => {
    try {
      const next = continueNovelContextPreview(engine, target, { maxTransitions: 512 });
      setStatus(statusOf(next));
      setSnapshot(next.snapshot);
    } catch (error) {
      setStatus("error");
      console.error(error);
    }
  };

  const valueLine = () => {
    const value = snapshot();
    const mira = value.stage.characters.mira as any;
    const position = mira?.position && typeof mira.position === "object"
      ? String(mira.position.x) + "," + String(mira.position.y)
      : String(mira?.position ?? "-");
    const audioIntents = Object.entries(value.audioIntents).map(([channel, intent]) => channel + ":" + intent.action + ":" + intent.cue).join(",") || "none";
    const returns = value.callStack.map(frame => frame.returnTo.label + ":" + frame.returnTo.index).join(",") || "none";
    return {
      phase: value.phase,
      code: String(value.variables.code ?? "-"),
      score: String(value.variables.score ?? "-"),
      background: String(value.stage.background ?? "-"),
      actor: mira ? String(mira.expression) + "@" + position : "-",
      camera: [value.stage.camera.x, value.stage.camera.y, value.stage.camera.scale].join(","),
      callStack: String(value.callStack.length) + ":" + returns,
      audio: audioIntents,
      active: value.active ? value.active.kind + ":" + ((value.active as any).id ?? "") : "none",
      location: value.active ? value.active.location.label + ":" + value.active.location.index : value.location.label + ":" + value.location.index,
    };
  };

  return <Screen class="relative w-full h-full">
    <NovelView engine={engine} host={host} assets={assetsDocument as NovelAssets} title="Context Preview Acceptance" onNewGame={() => {}} />
    <Text class="absolute left-[4] top-[220] text-xs">CTX_STATUS={status()}</Text>
    <Text class="absolute left-[4] top-[236] text-xs">CTX_PHASE={valueLine().phase}</Text>
    <Text class="absolute left-[4] top-[252] text-xs">CTX_VARIABLES=score:{valueLine().score};code:{valueLine().code}</Text>
    <Text class="absolute left-[4] top-[268] text-xs">CTX_BACKGROUND={valueLine().background}</Text>
    <Text class="absolute left-[4] top-[284] text-xs">CTX_ACTOR={valueLine().actor}</Text>
    <Text class="absolute left-[4] top-[300] text-xs">CTX_CAMERA={valueLine().camera}</Text>
    <Text class="absolute left-[4] top-[316] text-xs">CTX_CALLSTACK={valueLine().callStack}</Text>
    <Text class="absolute left-[4] top-[332] text-xs">CTX_AUDIO={valueLine().audio}</Text>
    <Text class="absolute left-[4] top-[348] text-xs">CTX_ACTIVE={valueLine().active}</Text>
    <Text class="absolute left-[4] top-[364] text-xs">CTX_LOCATION={valueLine().location}</Text>
    <Show when={status() === "choice" || status() === "input"}>
      <Focusable class="absolute left-[8] top-[580] w-[220] h-[44] bg-[#18321f]" onPress={resumeContext}>
        <Text class="text-xs">继续重建上下文</Text>
      </Focusable>
    </Show>
  </Screen>;
}
mount(() => <App />);
`;
}

test("Editor reconstructs real chapter context through author choices/input, locates executed sources, and runs the same helper in the pinned Guest", { timeout: 240_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-context-preview-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "context-preview-acceptance";
  const qaRoot = join(sdkRoot, ".pocket-build/context-preview-20261109");
  const qaRun = join(qaRoot, `run-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, "art"), { recursive: true });
  mkdirSync(join(project, "assets/audio"), { recursive: true });
  mkdirSync(qaRun, { recursive: true });

  const copiedMetadata = ["pocket.json", "manifest.json"];
  for (const name of copiedMetadata) cpSync(join(lantern, name), join(project, name), { recursive: true });
  const dependencies = {
    "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
    "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
    "@pocket/spine": `file:${join(sdkRoot, "packages/pocket_spine")}`,
    "@pocket/live2d": `file:${join(sdkRoot, "packages/pocket_live2d")}`,
  };
  writeJson(join(project, "package.json"), { name: projectId, version: "0.1.0", private: true, type: "module", dependencies });
  writeJson(join(project, "editor.json"), { id: projectId, appId: "pocket.demo.lantern", name: "Context Preview Acceptance", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 });
  writeJson(join(project, "story.json"), story);
  writeJson(join(project, "novel.assets.json"), assets);
  writeJson(join(project, "images.json"), {
    "art/station.png": { linear: true },
    "art/archive.png": { linear: true },
    "art/mira-neutral.png": { linear: true },
    "art/mira-hopeful.png": { linear: true },
    "art/ren-neutral.png": { linear: true },
  });
  writeJson(join(project, "novel.locales.json"), { format: "pocket-vn-locales", formatVersion: 1, catalogs: {} });
  writeFileSync(join(project, "app.tsx"), guestSource());

  for (const [source, output] of [
    ["art/station.png", "art/station.png"],
    ["art/archive.png", "art/archive.png"],
    ["art/mira-neutral.png", "art/mira-neutral.png"],
    ["art/mira-hopeful.png", "art/mira-hopeful.png"],
    ["art/ren-neutral.png", "art/ren-neutral.png"],
    ["assets/audio/music_letter.wav", "assets/audio/opening.wav"],
  ]) cpSync(join(lantern, source), join(project, output));

  const expectedStory = structuredClone(story);
  const originalDiskStory = JSON.parse(readFileSync(join(project, "story.json"), "utf8"));
  const expectedAssets = structuredClone(assets);
  const appSourceHash = sha256File(join(project, "app.tsx"));
  const artifactEvents: Array<Record<string, unknown>> = [];
  const screenshotRecords: Array<Record<string, unknown>> = [];
  const nativeFrames: Array<Record<string, unknown>> = [];
  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browserErrors: string[] = [];
  let nativeFinalText = "";
  let buildArtifacts: Record<string, unknown> | undefined;
  let browserFinalFacts: Record<string, any> | undefined;
  let resultState: "passed" | "failed" = "failed";
  let failure: string | undefined;
  let phase = "prepare";

  const recordFrame = (name: string, frame: Frame): void => {
    nativeFrames.push({ name, frame, text: textOf(frame) });
  };
  const capture = async (page: import("playwright").Page, name: string): Promise<void> => {
    const path = join(qaRun, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshotRecords.push({ path: relative(qaRoot, path), sha256: sha256File(path) });
  };

  try {
    phase = "verify official native probe";
    assert.equal(
      Boolean(explicitProbePath),
      Boolean(explicitProbeSha256),
      "set POCKET_NATIVE_PROBE and POCKET_NATIVE_PROBE_SHA256 together; otherwise the frozen release Probe is used",
    );
    assert.match(expectedProbeSha256, /^[a-f0-9]{64}$/, "the expected Probe identity must be an explicit SHA-256 value");
    assert.equal(resolve(process.execPath), resolve(expectedBunPath), "the acceptance must run under the pinned Bun 1.4.4 executable");
    assert.equal(execFileSync(expectedBunPath, ["--version"], { encoding: "utf8" }).trim(), "1.4.4");
    assert.ok(existsSync(probePath), `the specified release pocket_probe is missing: ${probePath}`);
    const actualProbeHash = sha256File(probePath);
    assert.equal(actualProbeHash, expectedProbeSha256, "the selected pocket_probe matches its frozen or explicitly supplied immutable identity");
    process.env.POCKET_NATIVE_PROBE = probePath;

    phase = "launch Editor Chromium";
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on("pageerror", error => browserErrors.push(error.message));
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await page.goto(`${origin}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();

    phase = "pinned Guest build";
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    const buildStatus = await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as Record<string, any>;
    const buildNotice = await page.locator("#novel-notice").innerText();
    assert.match(buildNotice, /Guest 已构建完成/, `pinned buildGuest failed: ${buildNotice}; build logs=${JSON.stringify(buildStatus.logs ?? [])}; diagnostics=${await page.locator("#novel-diagnostics").innerText().catch(() => "unavailable")}`);
    assert.equal(buildStatus.builtRevision, buildStatus.revision);
    const artifact = join(workspace, "builds", projectId, String(buildStatus.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    buildArtifacts = Object.fromEntries(["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"].filter(name => existsSync(join(artifact, name))).map(name => {
      const path = join(artifact, name);
      return [name, { sha256: sha256File(path), bytes: readFileSync(path).byteLength }];
    }));

    phase = "raw jump is not contextual reconstruction";
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "chapter_two_gate:0" || document.querySelector("#novel-preview-location")?.textContent === "chapter_two_gate:1");
    await chooseTarget(page, { label: "alternate_route", index: 1 });
    await page.locator("#novel-preview-jump button").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "alternate_route:1");
    assert.equal(await contextStatus(page).getAttribute("data-status"), "idle", "raw debugger jump must clear contextual provenance");
    const rawJumpFacts = page.locator("#novel-context-preview-facts");
    assert.equal(await rawJumpFacts.isHidden(), true, "raw jump cannot retain a previous reconstructed snapshot");
    const unknownStageSources = page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"], #novel-live-view .nv-preview-source[data-source-kind="character"]');
    assert.ok(await unknownStageSources.count() >= 2, "the live stage keeps its source controls visible");
    for (const source of await unknownStageSources.all()) {
      assert.equal(await source.isDisabled(), true, "raw-jumped stage has no verified execution source");
      assert.equal(await source.getAttribute("data-source-location"), "");
    }
    await capture(page, "raw-jump-without-reconstruction");

    phase = "reject an invalid context target honestly";
    await chooseTarget(page, { label: "chapter_two", index: 999 });
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-notice")?.textContent?.includes("上下文目标超出标签指令范围"));
    assert.equal(await contextStatus(page).getAttribute("data-status"), "idle", "an invalid target cannot report the prior raw jump as a reached context");
    assert.equal(await page.locator("#novel-context-preview-facts").isHidden(), true);
    assert.match(await page.locator("#novel-notice").innerText(), /上下文目标超出标签指令范围/);
    await capture(page, "invalid-context-target");

    phase = "reconstruct to the unresolved choice";
    await chooseTarget(page, target);
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "choice");
    let facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "choice");
    assert.equal(facts.active?.id, "chapter-route");
    assert.equal(facts.variables?.score, 7, "reconstruction executes the story's authored set instruction");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "code"), false, "an unresolved input must not be guessed");
    assert.equal(facts.stage?.background, "station");
    assert.equal(facts.callStack?.length, 1, "the prior call frame survives reconstruction");
    assert.equal(facts.callStack?.[0]?.returnTo?.label, "start");
    assert.equal(facts.callStack?.[0]?.returnTo?.index, 4);
    assert.equal(facts.audioIntents?.music?.cue, "opening");
    assert.equal(facts.location?.label, "chapter_two_gate");
    await capture(page, "context-stopped-at-choice");

    phase = "resolve the actual choice and input";
    await page.locator('#novel-live-view .nv-button.choice-button').filter({ hasText: "进入本章" }).click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "input");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "input");
    assert.equal(facts.active?.id, "chapter-code");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "code"), false, "an unsubmitted input draft is not a story variable");
    await capture(page, "context-stopped-at-input");

    const inputDraft = page.getByLabel("玩家输入草稿", { exact: true });
    await inputDraft.fill("NORTH");
    assert.equal(JSON.parse(await page.locator("#novel-context-preview-facts").innerText()).variables?.code, undefined, "typing alone does not commit player input");
    await page.locator("#novel-live-view .nv-preview-input-submit").click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal((await page.locator("#novel-notice").innerText()).includes("上下文目标超出标签指令范围"), false, "successful reconstruction clears a stale invalid-target notice");
    browserFinalFacts = facts;
    assert.equal(facts.phase, "say");
    assert.equal(facts.active?.kind, "say");
    assert.equal(facts.active?.id, "current-line");
    assert.equal(facts.active?.complete, true, "the target dialogue is rendered as a complete active line");
    assert.equal(facts.variables?.score, 7);
    assert.equal(facts.variables?.code, "NORTH");
    assert.equal(facts.stage?.background, "station", "an unexecuted alternate scene cannot overwrite the current background");
    assert.equal(facts.stage?.characters?.mira?.expression, "hopeful");
    assert.deepEqual(facts.stage?.characters?.mira?.position, { x: 212, y: 168 });
    assert.deepEqual({ x: facts.stage?.camera?.x, y: facts.stage?.camera?.y, scale: facts.stage?.camera?.scale }, { x: 21, y: -9, scale: 1.4 });
    assert.equal(facts.callStack?.length, 1);
    assert.deepEqual(facts.callStack?.[0]?.returnTo, { label: "start", index: 4 });
    assert.equal(facts.audioIntents?.music?.cue, "opening");
    assert.equal(facts.audioIntents?.music?.action, "play");
    assert.equal(facts.active?.location?.label, "chapter_two");
    assert.equal(facts.active?.location?.index, 2);
    await capture(page, "context-reached-target");

    phase = "locate the exact executed dialogue, actor, and background sources";
    const checkSourceNavigation = async (kind: string, location: string, label: string, index: number, instructionType: string): Promise<void> => {
      const source = page.locator(`#novel-live-view .nv-preview-source[data-source-kind="${kind}"]`);
      assert.equal(await source.getAttribute("data-source-location"), location, `${kind} source must come from the executed instruction that supplies the visible value`);
      assert.equal(await source.isDisabled(), false, `${kind} source is current and locatable`);
      await source.click();
      assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), label);
      assert.equal(await page.locator(".nv-instruction").nth(index).locator(".nv-type-select").inputValue(), instructionType);
      await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
      await page.locator("#novel-context-preview-facts").waitFor();
    };
    await checkSourceNavigation("dialogue", "chapter_two:2", "chapter_two", 2, "say");
    await checkSourceNavigation("character", "chapter_two:1", "chapter_two", 1, "scene");
    await checkSourceNavigation("background", "start:1", "start", 1, "scene");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "story.json"), "utf8")), originalDiskStory, "source navigation does not persist edits to story.json");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")), expectedAssets);

    phase = "run the same real context helpers in the compiled Guest";
    native = new NativeSession({ bytecodePath: join(artifact, "app.qjbc"), pakPath: join(artifact, "app.pak"), metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 30_000 });
    let nativeFrame = await native.boot();
    nativeFrame = await native.tap("启程 · 开始新的故事", nativeFrame);
    recordFrame("boot-choice", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=choice/);
    assert.match(textOf(nativeFrame), /CTX_VARIABLES=score:7;code:-/);
    assert.match(textOf(nativeFrame), /CTX_BACKGROUND=station/);
    assert.match(textOf(nativeFrame), /CTX_CALLSTACK=1:start:4/);
    assert.match(textOf(nativeFrame), /CTX_AUDIO=music:play:opening/);
    assert.ok(native.requests.some(request => request.capability === "media.audio.play" && request.params.asset === "audio/opening.wav"), "the actual compiled helper route sends its registered audio cue through the native capability boundary");

    nativeFrame = await native.tap("进入本章", nativeFrame);
    recordFrame("choice-selected", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=choice/, "the Guest waits for the author to explicitly continue after the real choice");
    nativeFrame = await native.tap(continueLabel, nativeFrame);
    recordFrame("input-blocker", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=input/);
    assert.match(textOf(nativeFrame), /CTX_VARIABLES=score:7;code:-/);
    assert.ok((nativeFrame.ops ?? []).some(operation => operation.type === "text" && operation.text?.includes("请填写本章验证码")), "the real Guest paints its unresolved input prompt");

    const prompt = textOp(nativeFrame, "输入线路代号");
    native.sendEvent("input.pointer", { phase: "down", id: 0, x: prompt.x! + 8, y: prompt.y! + 8 });
    const inputDown = await native.frame();
    native.sendEvent("input.pointer", { phase: "up", id: 0, x: prompt.x! + 8, y: prompt.y! + 8 });
    nativeFrame = await native.frame();
    const opened = [...(inputDown.events ?? []), ...(nativeFrame.events ?? [])].find(event => event.name === "textInput.open")?.payload;
    assert.ok(opened, "the native Guest opens the official input protocol for the actual unresolved input");
    const editingSession = opened!;
    native.sendEvent("textInput.edit", {
      id: editingSession.id,
      editingSession: editingSession.editingSession,
      revision: 1,
      jsRevision: editingSession.jsRevision,
      text: "NORTH",
      selectionBase: 5,
      selectionExtent: 5,
      composingBase: -1,
      composingExtent: -1,
    });
    nativeFrame = await native.frame();
    recordFrame("native-input-draft", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=input/);
    assert.match(textOf(nativeFrame), /CTX_VARIABLES=score:7;code:-/, "native input composing updates the draft without writing a variable");
    nativeFrame = await native.tap("提交", nativeFrame);
    recordFrame("native-input-submitted", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=input/);
    nativeFrame = await native.tap(continueLabel, nativeFrame);
    nativeFrame = await native.settle(nativeFrame, 2);
    recordFrame("native-reached-target", nativeFrame);
    nativeFinalText = textOf(nativeFrame);
    assert.match(nativeFinalText, /CTX_STATUS=reached/);
    assert.match(nativeFinalText, /CTX_PHASE=say/);
    assert.match(nativeFinalText, /CTX_VARIABLES=score:7;code:NORTH/);
    assert.match(nativeFinalText, /CTX_BACKGROUND=station/);
    assert.match(nativeFinalText, /CTX_ACTOR=hopeful@212,168/);
    assert.match(nativeFinalText, /CTX_CAMERA=21,-9,1\.4/);
    assert.match(nativeFinalText, /CTX_CALLSTACK=1:start:4/);
    assert.match(nativeFinalText, /CTX_AUDIO=music:play:opening/);
    assert.match(nativeFinalText, /CTX_ACTIVE=say:current-line/);
    assert.match(nativeFinalText, /CTX_LOCATION=chapter_two:2/);
    assert.ok((nativeFrame.ops ?? []).some(operation => operation.type === "text" && operation.text?.includes("线路 NORTH 已确认")), "the actual native Guest renders the reconstructed target line");
    const nativeLine = (key: string): string => {
      const line = nativeFinalText.split("\n").find(value => value.startsWith(`${key}=`));
      assert.ok(line, `native helper facts must include ${key}`);
      return line!.slice(key.length + 1);
    };
    const nativeVariables = nativeLine("CTX_VARIABLES").match(/^score:(-?\d+);code:(.+)$/);
    const nativeActor = nativeLine("CTX_ACTOR").match(/^([^@]+)@(\d+),(\d+)$/);
    const nativeCamera = nativeLine("CTX_CAMERA").split(",").map(Number);
    const nativeStack = nativeLine("CTX_CALLSTACK").match(/^(\d+):([^:]+):(\d+)$/);
    const nativeAudio = nativeLine("CTX_AUDIO").match(/^([^:]+):([^:]+):(.+)$/);
    const nativeActive = nativeLine("CTX_ACTIVE").match(/^([^:]+):(.+)$/);
    const nativeLocation = nativeLine("CTX_LOCATION").match(/^([^:]+):(\d+)$/);
    assert.ok(nativeVariables && nativeActor && nativeStack && nativeAudio && nativeActive && nativeLocation);
    assert.deepEqual({
      status: nativeLine("CTX_STATUS"),
      phase: nativeLine("CTX_PHASE"),
      variables: { score: Number(nativeVariables![1]), code: nativeVariables![2] },
      stage: {
        background: nativeLine("CTX_BACKGROUND"),
        actor: { expression: nativeActor![1], position: { x: Number(nativeActor![2]), y: Number(nativeActor![3]) } },
        camera: { x: nativeCamera[0], y: nativeCamera[1], scale: nativeCamera[2] },
      },
      callStack: [{ returnTo: { label: nativeStack![2], index: Number(nativeStack![3]) } }],
      audio: { channel: nativeAudio![1], action: nativeAudio![2], cue: nativeAudio![3] },
      active: { kind: nativeActive![1], id: nativeActive![2], location: { label: nativeLocation![1], index: Number(nativeLocation![2]) } },
    }, {
      status: await contextStatus(page).getAttribute("data-status"),
      phase: browserFinalFacts!.phase,
      variables: { score: browserFinalFacts!.variables.score, code: browserFinalFacts!.variables.code },
      stage: {
        background: browserFinalFacts!.stage.background,
        actor: { expression: browserFinalFacts!.stage.characters.mira.expression, position: browserFinalFacts!.stage.characters.mira.position },
        camera: { x: browserFinalFacts!.stage.camera.x, y: browserFinalFacts!.stage.camera.y, scale: browserFinalFacts!.stage.camera.scale },
      },
      callStack: [{ returnTo: browserFinalFacts!.callStack[0].returnTo }],
      audio: { channel: "music", action: browserFinalFacts!.audioIntents.music.action, cue: browserFinalFacts!.audioIntents.music.cue },
      active: { kind: browserFinalFacts!.active.kind, id: browserFinalFacts!.active.id, location: browserFinalFacts!.active.location },
    }, "the Browser and pinned Guest execute the same real context route to the same canonical state");

    phase = "author-selected alternate branch reaches its real ending without claiming target success";
    await chooseTarget(page, target);
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "choice");
    await page.locator('#novel-live-view .nv-button.choice-button').filter({ hasText: "走未执行路线" }).click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "ended");
    const alternateFacts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(alternateFacts.phase, "ending");
    assert.equal(alternateFacts.active?.kind, "ending");
    assert.equal(alternateFacts.active?.id, "story-end");
    assert.equal(alternateFacts.stage?.background, "archive", "an explicitly selected alternate route owns the visible background");
    assert.equal(alternateFacts.stage?.characters?.ren?.expression, "neutral");
    assert.equal(alternateFacts.callStack?.length, 0, "the alternate branch returned through the real call frame before the story ending");
    assert.equal(Object.hasOwn(alternateFacts.variables ?? {}, "code"), false, "the alternate branch does not invent the current route's unsubmitted input");
    await page.locator('#novel-execution-trace [data-location="alternate_route:0"][data-op="scene"]').waitFor();
    assert.equal(await page.locator('#novel-execution-trace [data-location="alternate_route:0"][data-op="scene"]').count(), 1, "the alternative scene is recorded only after the author explicitly selects it");
    assert.equal(await contextStatus(page).getAttribute("data-status"), "ended", "an unreachable target reports the actual ending rather than a false reached state");
    await capture(page, "context-author-selected-alternate-ending");
    const alternateBackground = page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"]');
    assert.equal(await alternateBackground.getAttribute("data-source-location"), "alternate_route:0");
    await alternateBackground.click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "alternate_route");
    assert.equal(await page.locator(".nv-instruction").first().locator(".nv-type-select").inputValue(), "scene");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "chapter_two_gate:0" || document.querySelector("#novel-preview-location")?.textContent === "chapter_two_gate:1");

    phase = "invalidation on raw jump, restart, and edit";
    await chooseTarget(page, { label: "alternate_route", index: 1 });
    await page.locator("#novel-preview-jump button").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "alternate_route:1");
    assert.equal(await contextStatus(page).getAttribute("data-status"), "idle", "raw jump cancels the old context target");
    assert.equal(await page.locator("#novel-context-preview-facts").isHidden(), true);
    for (const source of await page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"], #novel-live-view .nv-preview-source[data-source-kind="character"]').all()) {
      assert.equal(await source.isDisabled(), true);
      assert.equal(await source.getAttribute("data-source-location"), "", "raw-jumped stage facts cannot reuse contextual source locations");
    }
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "chapter_two_gate:0" || document.querySelector("#novel-preview-location")?.textContent === "chapter_two_gate:1");
    assert.equal(await contextStatus(page).getAttribute("data-status"), "idle", "restart disposes the previous context provenance");

    await chooseTarget(page, target);
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "choice");
    await page.locator('#novel-live-view .nv-button.choice-button').filter({ hasText: "进入本章" }).click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "input");
    await page.getByLabel("玩家输入草稿", { exact: true }).fill("NORTH");
    await page.locator("#novel-live-view .nv-preview-input-submit").click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    await page.locator('#novel-live-view .nv-preview-source[data-source-kind="character"]').click();
    const draftScene = page.locator(".nv-instruction").nth(1);
    const expressionField = draftScene.getByLabel("表情键", { exact: true }).first();
    assert.equal(await expressionField.inputValue(), "hopeful", "the executed actor source opens the authored scene card");
    await expressionField.fill("neutral");
    await expressionField.press("Tab");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.locator('#novel-live-view .nv-preview-source[data-source-kind="character"]').waitFor();
    assert.equal(await contextStatus(page).getAttribute("data-status"), "idle", "editing the draft invalidates the context snapshot");
    assert.equal(await page.locator("#novel-context-preview-facts").isHidden(), true);
    const staleActorSource = page.locator('#novel-live-view .nv-preview-source[data-source-kind="character"]');
    assert.equal(await staleActorSource.isDisabled(), true, "an old actor snapshot cannot link into an edited instruction as if current");
    assert.equal(await staleActorSource.getAttribute("data-source-location"), "");
    await capture(page, "source-invalidated-by-draft-edit");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    assert.equal(await page.locator(".nv-instruction").nth(1).getByLabel("表情键", { exact: true }).first().inputValue(), "neutral", "context preview leaves the existing unsaved draft intact");
    await clickNovelHistory(page, "undo");
    assert.equal(await page.locator(".nv-instruction").nth(1).getByLabel("表情键", { exact: true }).first().inputValue(), "hopeful", "context preview does not consume or replace the author's undo entry");

    assert.deepEqual(JSON.parse(readFileSync(join(project, "story.json"), "utf8")), originalDiskStory, "context actions and draft edits are not saved implicitly");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")), expectedAssets);

    phase = "bounded execution and Editor runtime error honesty";
    const runtimeResponse = await fetch(`${origin}/api/projects/${projectId}/novel/runtime.js`);
    assert.equal(runtimeResponse.status, 200);
    const runtimeSource = await runtimeResponse.text();
    const runtimePath = join(temporary, "editor-novel-runtime.mjs");
    writeFileSync(runtimePath, runtimeSource);
    const runtime = await import(pathToFileURL(runtimePath).href) as Record<string, any>;
    assert.equal(typeof runtime.createNovelContextPreview, "function");
    const loopStory = {
      id: "context-preview-bounded-loop",
      version: 1,
      start: "loop",
      script: {
        loop: [{ type: "say", id: "bounded-repeat", text: "有限步骤中的重复对白。" }, { type: "jump", target: "loop" }],
        target: [{ type: "say", id: "unreachable-target", text: "不可达目标。" }],
      },
    };
    const limited = runtime.createNovelContextPreview(loopStory, { label: "target", index: 0 }, { maxTransitions: 8 });
    assert.equal(limited.status, "limit", "unreachable context returns a finite budget result");
    assert.ok(limited.steps > 0 && limited.steps < 64, `the loop is bounded; committed steps=${limited.steps}`);
    limited.engine.dispose();
    let invalidTargetError: unknown;
    try { runtime.createNovelContextPreview(story, { label: "missing_label", index: 0 }); }
    catch (error) { invalidTargetError = error; }
    assert.ok(invalidTargetError, "invalid target must fail honestly instead of reporting a successful preview");
    assert.match(invalidTargetError instanceof Error ? invalidTargetError.message : String(invalidTargetError), /label|target|位置|标签|breakpoint points outside the story/i);
    writeFileSync(join(qaRun, "bounded-loop-result.json"), `${JSON.stringify({ status: limited.status, steps: limited.steps, error: invalidTargetError instanceof Error ? invalidTargetError.message : String(invalidTargetError) }, null, 2)}\n`);

    assert.deepEqual(browserErrors, [], `browser execution errors: ${JSON.stringify(browserErrors)}`);
    assert.deepEqual(JSON.parse(readFileSync(join(project, "story.json"), "utf8")), originalDiskStory);
    resultState = "passed";
    artifactEvents.push({ phase: "complete", browserFacts: browserFinalFacts, nativeFinalText });
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    artifactEvents.push({ phase, failure });
    throw error;
  } finally {
    if (native) {
      try { await native.quit(); } catch (error) { artifactEvents.push({ phase: "native cleanup", error: String(error) }); }
    }
    if (browser) await browser.close();
    if (server) await server.stop(true);
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    try {
      writeJson(join(qaRun, "native-route-frames.json"), nativeFrames);
      const sourceCandidates = [
        "sdk/editor/test/novel_context_preview_browser.test.ts",
        "sdk/editor/client/novel.js",
        "sdk/editor/client/novel.css",
        "sdk/editor/novel.ts",
        "sdk/packages/pocket_vn/src/index.ts",
        "sdk/packages/pocket_vn/src/engine.ts",
        "sdk/packages/pocket_vn/src/editor-runtime.ts",
        "sdk/packages/pocket_vn/src/types.ts",
        "sdk/packages/pocket_vn/src/preview-context.ts",
      ];
      const sourceHashes = sourceCandidates.filter(path => existsSync(join(repository, path))).map(path => ({ path, sha256: sha256File(join(repository, path)) }));
      const retainedParent = "/Volumes/ORICO/Development/Github/pocketjs_flutter_demo";
      const retainedParentCandidates = ["lib/main.dart", "lib/core/pocketjs_bundle_runner.dart", "lib/core/ffi_bridge.dart", "lib/core/real_hardware_bridge.dart"];
      const retainedParentHashes = retainedParentCandidates.filter(path => existsSync(join(retainedParent, path))).map(path => ({ path: `${relative(retainedParent, join(retainedParent, path))}`, sha256: sha256File(join(retainedParent, path)) }));
      const executablePath = chromium.executablePath();
      const toolsRoot = process.env.POCKET_TOOLS_PACKAGE?.trim();
      const compilerPath = toolsRoot ? join(toolsRoot, "compiler/tools/build.ts") : undefined;
      writeJson(join(qaRun, "context-preview-acceptance.json"), {
        title: "E04 contextual preview + click-source acceptance",
        outcome: resultState,
        phase,
        ...(failure ? { failure } : {}),
        startedAt: qaRun.slice(qaRoot.length + 1),
        probe: {
          path: probePath,
          sha256: existsSync(probePath) ? sha256File(probePath) : null,
          expectedSha256: expectedProbeSha256,
          identitySource: explicitProbePath ? "explicit-environment-pair" : "frozen-default",
        },
        tools: {
          bun: { path: process.execPath, sha256: sha256File(expectedBunPath), version: execFileSync(expectedBunPath, ["--version"], { encoding: "utf8" }).trim() },
          playwrightChromium: { path: executablePath, sha256: existsSync(executablePath) ? sha256File(executablePath) : null, version: browser?.version() ?? null },
          nativeProbe: probePath,
          buildToolsPackage: toolsRoot ?? null,
          compiler: compilerPath && existsSync(compilerPath) ? { path: compilerPath, sha256: sha256File(compilerPath) } : null,
        },
        sources: sourceHashes,
        retainedParentSource: { root: retainedParent, files: retainedParentHashes, hasNovelOrStoryEditorOutsidePocketHost: false },
        fixture: { storySha256: sha256(JSON.stringify(expectedStory)), storyFileSha256: sha256File(join(project, "story.json")), guestAppSha256: appSourceHash },
        guestBuild: buildArtifacts ?? null,
        browserFacts: browserFinalFacts ?? null,
        nativeFinalText: nativeFinalText || null,
        browserErrors,
        captures: screenshotRecords,
        events: artifactEvents,
      });
    } catch (error) {
      artifactEvents.push({ phase: "QA manifest", error: String(error) });
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("regular Editor preview keeps camera motion and timeline clocked after a completed manual say, then stops while paused or settled", { timeout: 90_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-preview-clock-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const projectId = "context-preview-clock";
  const qaRoot = join(sdkRoot, ".pocket-build/context-preview-20261109");
  const qaRun = join(qaRoot, `clock-run-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(qaRun, { recursive: true });

  const clockStory = {
    id: projectId,
    version: 1,
    start: "start",
    timelines: {
      clock_pass: {
        durationMs: 900,
        camera: [
          { atMs: 0, value: { x: 120, y: 0, scale: 1.5 } },
          { atMs: 900, value: { x: 40, y: 20, scale: 0.8 } },
        ],
      },
    },
    script: {
      start: [
        { type: "scene", camera: { x: 120, y: 0, scale: 1.5 }, cameraMotion: { durationMs: 900, easing: "linear" } },
        { type: "say", id: "camera-motion-line", text: "Ready" },
        { type: "scene", timeline: "clock_pass" },
        { type: "say", id: "timeline-line", text: "Clock" },
        { type: "ending", id: "clock-end", text: "Done" },
      ],
    },
  };
  writeJson(join(project, "pocket.json"), { pocket: 2, id: projectId, name: projectId, app: { entry: "app.tsx", framework: "solid" } });
  writeJson(join(project, "manifest.json"), { pocket: 2, id: projectId, capabilities: { requires: [], optional: [] } });
  writeJson(join(project, "editor.json"), { id: projectId, appId: projectId, name: projectId, version: "0.1.0", build: 1 });
  writeJson(join(project, "package.json"), { type: "module", dependencies: {} });
  writeJson(join(project, "story.json"), clockStory);
  writeJson(join(project, "novel.assets.json"), { backgrounds: {}, characters: {}, cgs: {}, audio: {} });

  const screenshots: Array<Record<string, unknown>> = [];
  const observations: Array<Record<string, unknown>> = [];
  const sourceHashes: Array<Record<string, unknown>> = [];
  const bunVersion = execFileSync(expectedBunPath, ["--version"], { encoding: "utf8" }).trim();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  const browserErrors: string[] = [];
  let outcome: "passed" | "failed" = "failed";
  let phase = "prepare";
  let failure: string | undefined;

  try {
    phase = "launch Playwright Chromium";
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(15_000);
    page.on("pageerror", error => browserErrors.push(error.message));
    await page.addInitScript(() => {
      const probe = { armed: false, schedules: 0, callbacks: 0 };
      (window as any).__previewClockProbe = probe;
      const request = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        if (probe.armed) probe.schedules++;
        return request(now => {
          if (probe.armed) probe.callbacks++;
          callback(now);
        });
      };
    });
    const origin = `http://127.0.0.1:${server.port}`;
    await page.goto(`${origin}/novel?project=${projectId}`);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "start:1");
    assert.equal(await page.locator("#novel-context-preview-status").getAttribute("data-status"), "idle", "this route is the ordinary Editor preview, not a context replay");
    await page.evaluate(() => { (window as any).__previewClockProbe.armed = true; });

    phase = "completed say with active camera motion";
    await page.locator("#novel-preview-pause").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await page.waitForFunction(() => document.querySelector("#novel-live-view .nv-preview-dialogue .nv-field-help")?.textContent === "单步继续");
    const cameraPose = async (): Promise<{ x: number; y: number; scale: number }> => page.locator("#novel-live-view .nv-stage-cast").evaluate(element => {
      const value = element as HTMLElement;
      return { x: Number(value.dataset.cameraX), y: Number(value.dataset.cameraY), scale: Number(value.dataset.cameraScale) };
    });
    const cameraBeforePause = await cameraPose();
    assert.ok(cameraBeforePause.x > 0 && cameraBeforePause.x < 120, `completed say must coexist with in-flight camera motion; pose=${JSON.stringify(cameraBeforePause)}`);
    const runningSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    assert.ok(runningSchedules > 4, `the normal preview must schedule repeated clock frames while camera motion is active; count=${runningSchedules}`);
    await capture(page, "regular-preview-complete-say-camera-motion");

    await page.locator("#novel-preview-pause").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "继续");
    const pausedPose = await cameraPose();
    const pausedSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    await page.waitForTimeout(120);
    assert.deepEqual(await cameraPose(), pausedPose, "pause freezes the canonical camera pose");
    assert.equal(await page.evaluate(() => (window as any).__previewClockProbe.schedules as number), pausedSchedules, "pause cancels the frame loop without scheduling repeated idle frames");
    await capture(page, "regular-preview-paused-camera-motion");

    phase = "camera motion settles, then stops scheduling";
    await page.locator("#novel-preview-pause").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await page.waitForFunction(() => {
      const cast = document.querySelector("#novel-live-view .nv-stage-cast") as HTMLElement | null;
      return !!cast && cast.dataset.cameraX === "120" && cast.dataset.cameraY === "0" && cast.dataset.cameraScale === "1.5";
    }, undefined, { timeout: 5_000 });
    const cameraSettled = await cameraPose();
    assert.deepEqual(cameraSettled, { x: 120, y: 0, scale: 1.5 });
    const cameraSettledSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as any).__previewClockProbe.schedules as number), cameraSettledSchedules, "a completed camera motion does not keep the Browser preview clock alive");
    observations.push({ point: "cameraMotionComplete", pose: cameraSettled, scheduledFrames: cameraSettledSchedules });
    await capture(page, "regular-preview-camera-motion-settled");

    phase = "completed say with active timeline";
    await page.getByRole("button", { name: "单步到下一阻塞点", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "start:3");
    await page.waitForFunction(() => (document.querySelector("#novel-live-view .nv-stage-cast") as HTMLElement | null)?.dataset.cameraX === "120");
    const timelineStart = await cameraPose();
    assert.deepEqual(timelineStart, { x: 120, y: 0, scale: 1.5 }, "timeline starts from its authored first frame");
    await page.locator("#novel-preview-pause").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await page.waitForFunction(() => document.querySelector("#novel-live-view .nv-preview-dialogue .nv-field-help")?.textContent === "单步继续");
    const timelineMid = await cameraPose();
    assert.ok(timelineMid.x > 40 && timelineMid.x < 120, `complete manual say keeps the active timeline clocking; pose=${JSON.stringify(timelineMid)}`);
    const timelineRunningSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    assert.ok(timelineRunningSchedules > cameraSettledSchedules + 4, `an active timeline must schedule frames after the prior camera motion settled; count=${timelineRunningSchedules}`);
    await capture(page, "regular-preview-complete-say-timeline-active");

    await page.locator("#novel-preview-pause").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "继续");
    const timelinePausedPose = await cameraPose();
    const timelinePausedSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    await page.waitForTimeout(120);
    assert.deepEqual(await cameraPose(), timelinePausedPose);
    assert.equal(await page.evaluate(() => (window as any).__previewClockProbe.schedules as number), timelinePausedSchedules, "paused timeline preview does not schedule idle frames");
    await page.locator("#novel-preview-pause").click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "暂停");
    await page.waitForFunction(() => {
      const cast = document.querySelector("#novel-live-view .nv-stage-cast") as HTMLElement | null;
      return !!cast && cast.dataset.cameraX === "40" && cast.dataset.cameraY === "20" && cast.dataset.cameraScale === "0.8";
    }, undefined, { timeout: 5_000 });
    const timelineSettled = await cameraPose();
    assert.deepEqual(timelineSettled, { x: 40, y: 20, scale: 0.8 });
    const timelineSettledSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as any).__previewClockProbe.schedules as number), timelineSettledSchedules, "after a timeline is removed from canonical stage state the clock stops scheduling");
    observations.push({ point: "timelineComplete", pose: timelineSettled, scheduledFrames: timelineSettledSchedules });
    await capture(page, "regular-preview-timeline-settled");

    phase = "story ending does not restart the clock";
    await page.getByRole("button", { name: "单步到下一阻塞点", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "start:4");
    await page.waitForFunction(() => document.querySelector("#novel-preview-pause")?.textContent === "继续");
    const endingSchedules = await page.evaluate(() => (window as any).__previewClockProbe.schedules as number);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => (window as any).__previewClockProbe.schedules as number), endingSchedules, "a paused ending has no active preview clock");
    assert.equal(await page.locator("#novel-context-preview-status").getAttribute("data-status"), "idle");
    await capture(page, "regular-preview-ending-paused");

    assert.deepEqual(browserErrors, []);
    outcome = "passed";
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    throw error;
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop(true);
    const sourceCandidates = ["sdk/editor/client/novel.js", "sdk/editor/client/novel.css", "sdk/editor/test/novel_context_preview_browser.test.ts", "sdk/packages/pocket_vn/src/clock.ts", "sdk/packages/pocket_vn/src/engine.ts"];
    for (const path of sourceCandidates.filter(value => existsSync(join(repository, value)))) sourceHashes.push({ path, sha256: sha256File(join(repository, path)) });
    const executablePath = chromium.executablePath();
    writeJson(join(qaRun, "regular-preview-clock-acceptance.json"), {
      title: "Regular Browser preview motion clock acceptance",
      outcome,
      phase,
      ...(failure ? { failure } : {}),
      tools: {
        bun: { path: process.execPath, version: bunVersion, sha256: sha256File(expectedBunPath) },
        playwrightChromium: { path: executablePath, version: browser?.version() ?? null, sha256: existsSync(executablePath) ? sha256File(executablePath) : null },
      },
      fixture: { storySha256: sha256(JSON.stringify(clockStory)), cameraMotionDurationMs: 900, timelineDurationMs: 900 },
      sources: sourceHashes,
      observations,
      browserErrors,
      captures: screenshots,
    });
    rmSync(temporary, { recursive: true, force: true });
  }

  async function capture(page: import("playwright").Page, name: string): Promise<void> {
    const path = join(qaRun, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshots.push({ path: relative(qaRoot, path), sha256: sha256File(path) });
  }
});
