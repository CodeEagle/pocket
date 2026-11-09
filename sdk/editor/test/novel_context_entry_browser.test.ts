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
import { NativeSession, center, textOf, textOp, type Frame } from "../../../demo/js/tests/native_session.ts";

const repository = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repository, "sdk");
const frozenProbeSha256 = "a7bad801fc1b1f7e68a4ff453138699b5632e80ba2b568b95ac6c6980682aa47";
const frozenProbePath = join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe");
const explicitProbePath = process.env.POCKET_NATIVE_PROBE?.trim();
const explicitProbeSha256 = process.env.POCKET_NATIVE_PROBE_SHA256?.trim();
const probePath = explicitProbePath ? resolve(explicitProbePath) : frozenProbePath;
const expectedProbeSha256 = explicitProbeSha256 ?? frozenProbeSha256;
const lanternAssetPath = join(repository, "demo/js/apps/lantern/art/station.png");
const expectedBunPath = join(sdkRoot, ".pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun");
const qaRoot = join(sdkRoot, ".pocket-build/context-entry-20261109");
const projectId = "novel-context-entry-acceptance";
const target = { label: "chapter_body", index: 2 };
const continueLabel = "继续重建上下文";
const timeoutMs = 180;

const story = {
  id: projectId,
  version: 1,
  start: "start",
  replayEntries: [
    { id: "chapter-preview", title: "Chapter preview", location: { label: "safe_route", index: 1 } },
    { id: "locked-chapter", title: "Locked chapter preview", location: { label: "safe_route", index: 1 }, unlockEndingId: "locked-proof" },
  ],
  editor: { blueprint: { version: 1, nodes: {
    blueprint_entry: { kind: "entry", title: "Blueprint entry" },
    chapter_root: { kind: "chapter", title: "Chapter root" },
    wrong_root: { kind: "chapter", title: "Wrong chapter root" },
    blueprint_initialize: { kind: "assignment", title: "Initialization is not a safe root" },
    stale_root: { kind: "chapter", title: "Stale chapter metadata" },
    wrong_shape: { kind: "entry", title: "Not an entry instruction" },
  } } },
  script: {
    start: [
      { type: "set", variable: "mainOnly", value: 123 },
      { type: "scene", background: "station", characters: [{ id: "mira", expression: "neutral", visible: true }] },
      { type: "call", target: "main_gate" },
      { type: "say", id: "main-return", text: "Main route returned." },
      { type: "ending", id: "main-ending", text: "Main route ended." },
    ],
    main_gate: [{ type: "choice", id: "main-choice", prompt: "Main route", options: [
      { id: "continue", text: "继续主线", target: "main_body" },
      { id: "finish", text: "结束主线", target: "main_end" },
    ] }],
    main_body: [{ type: "say", id: "main-line", text: "Main line." }, { type: "return" }],
    main_end: [{ type: "ending", id: "main-early-ending", text: "Main ended." }],
    safe_route: [
      { type: "set", variable: "beforeReplayEntry", value: true },
      { type: "set", variable: "routeNo", value: 59 },
      { type: "scene", background: "roof", characters: [{ id: "mira", expression: "neutral", visible: true }] },
      { type: "choice", id: "chapter-route", prompt: "选择章节路线", timeLimitMs: timeoutMs, timeoutTarget: "alternate_route", options: [
        { id: "current", text: "进入章节", target: "chapter_entry" },
        { id: "alternate", text: "走备用路线", target: "alternate_route" },
      ] },
    ],
    blueprint_entry: [{ type: "jump", target: "safe_route" }],
    chapter_entry: [{ type: "call", target: "chapter_body" }, { type: "jump", target: "chapter_after" }],
    chapter_root: [{ type: "call", target: "chapter_body" }, { type: "jump", target: "chapter_after" }],
    chapter_body: [
      { type: "scene", background: "dawn", characters: [{ id: "mira", expression: "hopeful", visible: true }] },
      { type: "input", id: "chapter-code", variable: "routeCode", inputType: "text", prompt: "输入线路代号", placeholder: "输入代码", minLength: 1, maxLength: 12 },
      { type: "say", id: "chapter-target", speaker: "Mira", text: "Chapter {{routeCode}} / {{routeNo}}." },
      { type: "return" },
    ],
    chapter_after: [{ type: "ending", id: "chapter-ending", text: "Chapter ended." }],
    alternate_route: [
      { type: "scene", background: "archive", characters: [{ id: "ren", expression: "neutral", visible: true }] },
      { type: "say", id: "alternate-line", text: "Alternate route." },
      { type: "ending", id: "alternate-ending", text: "Alternate ended." },
    ],
    wrong_root: [{ type: "call", target: "wrong_body" }, { type: "jump", target: "wrong_end" }],
    wrong_body: [{ type: "scene", background: "archive" }, { type: "return" }],
    wrong_end: [{ type: "ending", id: "wrong-ending", text: "Wrong route ended before the target." }],
    blueprint_initialize: [{ type: "set", variable: "blueprintInit", value: true }, { type: "jump", target: "safe_route" }],
    stale_root: [{ type: "call", target: "chapter_body" }],
    wrong_shape: [{ type: "say", id: "not-a-root", text: "Not a safe root." }],
    unmarked_chapter: [{ type: "call", target: "chapter_body" }, { type: "jump", target: "chapter_after" }],
    locked_end: [{ type: "ending", id: "locked-proof", text: "Unlock proof." }],
  },
};

const assets = {
  backgrounds: { station: "art/station.png", roof: "art/station.png", dawn: "art/station.png", archive: "art/station.png" },
  characters: { mira: { neutral: "art/station.png", hopeful: "art/station.png" }, ren: { neutral: "art/station.png" } },
  cgs: {},
  audio: {},
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

function guestSource(): string {
  return [
    'import { createSignal, onCleanup, Show } from "solid-js";',
    'import { mount } from "@pocketjs/framework/solid";',
    'import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";',
    'import { createHostBridge } from "@pocket/ui/host";',
    'import { createNovelContextPreview, continueNovelContextPreview, type StoryDefinition } from "@pocket/vn";',
    'import { NovelView, type NovelAssets } from "@pocket/vn/view";',
    'import storyDocument from "./story.json";',
    'import assetsDocument from "./novel.assets.json";',
    'const target = { label: "chapter_body", index: 2 };',
    'function statusOf(result: any): string { return result.status === "blocked" ? String(result.blocker) : result.status; }',
    'function App() {',
    '  const host = createHostBridge();',
    '  const [engine, setEngine] = createSignal<any>(null);',
    '  const [status, setStatus] = createSignal("starting");',
    '  const [rootIdentity, setRootIdentity] = createSignal("replay:locked-chapter");',
    '  const [snapshot, setSnapshot] = createSignal<any>(null);',
    '  let removeUpdates: (() => void) | undefined;',
    '  const install = (root: any) => {',
    '    removeUpdates?.();',
    '    engine()?.dispose();',
    '    const result = createNovelContextPreview(storyDocument as StoryDefinition, target, { root, maxTransitions: 512 });',
    '    setEngine(result.engine);',
    '    setStatus(statusOf(result));',
    '    setRootIdentity(result.root.kind === "replay" ? "replay:" + result.root.entryId : result.root.kind === "blueprint" ? "blueprint:" + result.root.label : "main");',
    '    setSnapshot(result.snapshot);',
    '    removeUpdates = result.engine.subscribe((update: any) => setSnapshot(update.snapshot), { emitCurrent: true });',
    '  };',
    '  install({ kind: "replay", entryId: "locked-chapter" });',
    '  const continueContext = () => {',
    '    const next = continueNovelContextPreview(engine(), target, { maxTransitions: 512 });',
    '    setStatus(statusOf(next)); setSnapshot(next.snapshot);',
    '  };',
    '  const current = () => snapshot();',
    '  const active = () => current()?.active;',
    '  const background = () => String(current()?.stage?.background ?? "-");',
    '  const routeNo = () => String(current()?.variables?.routeNo ?? "-");',
    '  const routeCode = () => String(current()?.variables?.routeCode ?? "-");',
    '  const mainOnly = () => String(current()?.variables?.mainOnly ?? "-");',
    '  const callStack = () => current()?.callStack?.map((frame: any) => frame.returnTo.label + ":" + frame.returnTo.index).join(",") || "none";',
    '  const activeLine = () => active() ? active().kind + ":" + String(active().id ?? "") : "none";',
    '  const location = () => active()?.location ? active().location.label + ":" + active().location.index : current()?.location ? current().location.label + ":" + current().location.index : "none";',
    '  onCleanup(() => { removeUpdates?.(); engine()?.dispose(); host.dispose(); });',
    '  return <Screen class="relative w-full h-full">',
    '    <Show when={engine()}>{activeEngine => <NovelView engine={activeEngine()} host={host} assets={assetsDocument as NovelAssets} title="Safe context roots" onNewGame={() => {}} />}</Show>',
    '    <Text class="absolute left-[220] top-[4] text-xs">CTX_STATUS={status()}</Text>',
    '    <Text class="absolute left-[220] top-[20] text-xs">CTX_ROOT={rootIdentity()}</Text>',
    '    <Text class="absolute left-[220] top-[36] text-xs">CTX_VARS=routeNo:{routeNo()};code:{routeCode()};mainOnly:{mainOnly()}</Text>',
    '    <Text class="absolute left-[220] top-[52] text-xs">CTX_BACKGROUND={background()}</Text>',
    '    <Text class="absolute left-[220] top-[68] text-xs">CTX_CALLSTACK={callStack()}</Text>',
    '    <Text class="absolute left-[220] top-[84] text-xs">CTX_ACTIVE={activeLine()}</Text>',
    '    <Text class="absolute left-[220] top-[100] text-xs">CTX_LOCATION={location()}</Text>',
    '    <Text class="absolute left-[220] top-[116] text-xs">CTX_META={JSON.stringify(current()?.meta?.endingIds ?? [])}</Text>',
    '    <Show when={status() === "choice" || status() === "input"}>',
    '      <Focusable class="absolute left-[8] top-[580] w-[220] h-[44] bg-[#18321f]" onPress={continueContext}><Text class="text-xs">继续重建上下文</Text></Focusable>',
    '    </Show>',
    '    <Show when={status() === "reached"}>',
    '      <Focusable class="absolute left-[220] top-[560] w-[120] h-[44] bg-[#18321f]" onPress={() => install({ kind: "blueprint", label: "wrong_root" })}><Text class="text-xs">错误根</Text></Focusable>',
    '    </Show>',
    '  </Screen>;',
    '}',
    'mount(() => <App />);',
  ].join("\n");
}

test("Editor selects only safe context roots and the same replay route runs in pinned Guest", { timeout: 300_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-context-entry-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const runId = `entry-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
  const runDir = join(qaRoot, runId);
  mkdirSync(project, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(project, "art"), { recursive: true });
  cpSync(lanternAssetPath, join(project, "art/station.png"));

  for (const [name, value] of [
    ["pocket.json", { pocket: 2, id: "test.context-entry", name: projectId, app: { entry: "app.tsx", framework: "solid" } }],
    ["manifest.json", { pocket: 2, id: "test.context-entry", capabilities: { requires: [], optional: [] } }],
    ["editor.json", { id: projectId, appId: "test.context-entry", name: projectId, version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }],
    ["package.json", { name: projectId, version: "0.1.0", private: true, type: "module", dependencies: {
      "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
      "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
      "@pocket/spine": `file:${join(sdkRoot, "packages/pocket_spine")}`,
      "@pocket/live2d": `file:${join(sdkRoot, "packages/pocket_live2d")}`,
    } }],
    ["story.json", story],
    ["novel.assets.json", assets],
    ["images.json", { "art/station.png": { linear: true } }],
    ["novel.locales.json", { format: "pocket-vn-locales", formatVersion: 1, catalogs: {} }],
  ] as const) writeJson(join(project, name), value);
  writeFileSync(join(project, "app.tsx"), guestSource());

  const originalStoryBytes = readFileSync(join(project, "story.json"));
  const sourceStoryHash = sha256(originalStoryBytes);
  const sourceAppHash = sha256File(join(project, "app.tsx"));
  const browserErrors: string[] = [];
  const browserScreenshots: Array<Record<string, unknown>> = [];
  const nativeFrames: Array<Record<string, unknown>> = [];
  const observations: Record<string, unknown> = {};
  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browserVersion = "";
  let buildArtifacts: Record<string, unknown> = {};
  let result: "passed" | "failed" = "failed";
  let phase = "prepare";
  let failure: string | undefined;
  let browserTargetFacts: Record<string, any> | undefined;
  let browserTargetStatus = "";

  const capture = async (page: import("playwright").Page, name: string): Promise<void> => {
    const path = join(runDir, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    browserScreenshots.push({ path: relative(qaRoot, path), sha256: sha256File(path) });
  };
  const recordFrame = (name: string, frame: Frame): void => nativeFrames.push({ name, frame, text: textOf(frame) });
  const selectTarget = async (page: import("playwright").Page, address: { label: string; index: number }): Promise<void> => {
    await page.locator(".nv-jump-control select").selectOption(address.label);
    await page.locator(".nv-jump-control input").fill(String(address.index));
  };
  const status = (page: import("playwright").Page) => page.locator("#novel-context-preview-status");

  try {
    phase = "verify pinned Bun and native Probe";
    assert.equal(
      Boolean(explicitProbePath),
      Boolean(explicitProbeSha256),
      "set POCKET_NATIVE_PROBE and POCKET_NATIVE_PROBE_SHA256 together; otherwise the frozen release Probe is used",
    );
    assert.match(expectedProbeSha256, /^[a-f0-9]{64}$/, "the expected Probe identity must be an explicit SHA-256 value");
    assert.equal(resolve(process.execPath), resolve(expectedBunPath), "acceptance uses the pinned Bun 1.4.4 executable");
    assert.equal(execFileSync(expectedBunPath, ["--version"], { encoding: "utf8" }).trim(), "1.4.4");
    assert.ok(existsSync(probePath), `the release pocket_probe is missing: ${probePath}`);
    const probeHash = sha256File(probePath);
    assert.equal(probeHash, expectedProbeSha256, "the selected Probe matches its frozen or explicitly supplied binary identity");
    process.env.POCKET_NATIVE_PROBE = probePath;

    phase = "launch Editor using Playwright Chromium";
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on("pageerror", error => browserErrors.push(error.message));
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await page.goto(`${origin}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();

    phase = "build the actual Guest through the pinned buildGuest pipeline";
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    const buildStatus = await (await fetch(`${origin}/api/projects/${projectId}/status`)).json() as Record<string, any>;
    const buildNotice = await page.locator("#novel-notice").innerText();
    assert.match(buildNotice, /Guest 已构建完成/, `pinned buildGuest failed: ${buildNotice}; logs=${JSON.stringify(buildStatus.logs ?? [])}; diagnostics=${await page.locator("#novel-diagnostics").innerText().catch(() => "unavailable")}`);
    assert.equal(buildStatus.builtRevision, buildStatus.revision);
    const artifact = join(workspace, "builds", projectId, String(buildStatus.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    buildArtifacts = Object.fromEntries(["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"].filter(name => existsSync(join(artifact, name))).map(name => {
      const path = join(artifact, name);
      return [name, { sha256: sha256File(path), bytes: readFileSync(path).byteLength }];
    }));

    phase = "observe the canonical main path before reconstructing from an independent root";
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "main_gate:0");
    assert.equal(JSON.parse(await page.locator("#novel-variables").innerText()).mainOnly, 123);
    assert.match(await page.locator("#novel-live-view").innerText(), /背景 · station/);
    const roots = page.locator("#novel-context-preview-root");
    const rootOptions = await roots.locator("option").evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, title: option.textContent?.trim() ?? "" })));
    for (const required of ["main", "replay:chapter-preview", "replay:locked-chapter", "blueprint:blueprint_entry", "blueprint:chapter_root", "blueprint:wrong_root"]) {
      assert.ok(rootOptions.some(option => option.value === required), `safe root candidate ${required} is listed`);
    }
    for (const rejected of ["blueprint:blueprint_initialize", "blueprint:stale_root", "blueprint:wrong_shape", "blueprint:unmarked_chapter"]) {
      assert.equal(rootOptions.some(option => option.value === rejected), false, `unsafe root candidate ${rejected} is excluded`);
    }
    observations.safeRoots = rootOptions;
    await capture(page, "main-preview-before-safe-root");

    phase = "reconstruct from explicit main root and verify its isolated call path";
    await roots.selectOption("main");
    await selectTarget(page, { label: "main_gate", index: 0 });
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    let facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "choice", "targeting a choice executes that target OP and leaves its real blocker active");
    assert.equal(facts.active?.id, "main-choice");
    assert.equal(facts.variables?.mainOnly, 123);
    assert.equal(facts.stage?.background, "station");
    assert.deepEqual(facts.callStack?.[0]?.returnTo, { label: "start", index: 3 });
    assert.equal(await status(page).getAttribute("data-root-kind"), "main");
    assert.equal(await status(page).getAttribute("data-root-location"), "start:0");
    await capture(page, "main-root-choice");

    phase = "visit a nonzero declared replay entry and assert its first OP trace row";
    const entryNextBreakpoint = page.locator(".nv-breakpoint-row").filter({ hasText: "safe_route:2" }).locator("input");
    await entryNextBreakpoint.check();
    await roots.selectOption("replay:locked-chapter");
    await selectTarget(page, { label: "safe_route", index: 1 });
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.variables?.routeNo, 59, "the replay begins at its declared index 1 and executes the target set OP");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "beforeReplayEntry"), false, "the entry prefix before index 1 did not execute");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "mainOnly"), false, "the new replay engine does not inherit main variables");
    assert.equal(facts.stage?.background, null, "the authored breakpoint holds before the first scene after the selected entry");
    assert.deepEqual(facts.callStack, [], "a fresh replay root has no main-route call frame");
    assert.equal(facts.meta?.endingIds?.includes("locked-proof"), false, "author preview never invents progress for a locked replay");
    assert.equal(await page.locator("#novel-live-view .nv-stage-bg").innerText(), "背景未设置", "the first registered image is not used as a fake scene when the replay has not executed a scene OP");
    assert.equal(await page.locator('#novel-live-view .nv-stage-background[data-background-role="base"]').count(), 0, "an empty engine stage does not paint the registry's first background");
    assert.equal(await status(page).getAttribute("data-root-kind"), "replay");
    assert.equal(await status(page).getAttribute("data-root-location"), "safe_route:1");
    const entryTargetRow = page.locator('#novel-execution-trace [data-location="safe_route:1"][data-op="set"]');
    assert.equal(await entryTargetRow.count(), 1, "the nonzero entry target OP is traced exactly once");
    observations.entryTarget = { rootLocation: "safe_route:1", target: "safe_route:1", variables: facts.variables, traceRows: await entryTargetRow.count() };
    await capture(page, "nonzero-replay-entry-op");
    await entryNextBreakpoint.uncheck();

    phase = "reconstruct the replay route and stop at an unresolved real choice";
    await selectTarget(page, target);
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "choice");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "choice");
    assert.equal(facts.active?.id, "chapter-route");
    assert.equal(facts.variables?.routeNo, 59);
    assert.equal(Object.hasOwn(facts.variables ?? {}, "routeCode"), false);
    assert.equal(Object.hasOwn(facts.variables ?? {}, "mainOnly"), false, "no previous main state is carried across root selection");
    assert.equal(facts.stage?.background, "roof");
    assert.deepEqual(facts.callStack, [], "the replay choice has no inherited main call stack");
    await page.waitForTimeout(timeoutMs * 3);
    assert.equal(await status(page).getAttribute("data-status"), "choice", "a timed choice remains unresolved while context reconstruction is blocked");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.id, "chapter-route");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "routeCode"), false, "no route is guessed after the timeout window");
    await capture(page, "replay-choice-no-timeout-selection");

    phase = "resolve the real choice and input to reach the nonzero say target";
    await page.locator('#novel-live-view .nv-button.choice-button').filter({ hasText: "进入章节" }).click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "input");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "input");
    assert.equal(facts.active?.id, "chapter-code");
    assert.equal(facts.callStack?.length, 1);
    assert.deepEqual(facts.callStack?.[0]?.returnTo, { label: "chapter_entry", index: 1 });
    assert.equal(Object.hasOwn(facts.variables ?? {}, "routeCode"), false, "unsubmitted input remains a draft");
    const inputDraft = page.getByLabel("玩家输入草稿", { exact: true });
    await inputDraft.fill("NORTH");
    assert.equal(JSON.parse(await page.locator("#novel-context-preview-facts").innerText()).variables?.routeCode, undefined);
    await page.locator("#novel-live-view .nv-preview-input-submit").click();
    await page.locator("#novel-context-preview-continue").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    browserTargetFacts = facts;
    browserTargetStatus = await status(page).getAttribute("data-status") ?? "";
    assert.equal(facts.active?.kind, "say");
    assert.equal(facts.active?.id, "chapter-target");
    assert.equal(facts.active?.complete, true);
    assert.equal(facts.variables?.routeCode, "NORTH");
    assert.equal(facts.variables?.routeNo, 59);
    assert.equal(Object.hasOwn(facts.variables ?? {}, "mainOnly"), false);
    assert.equal(facts.stage?.background, "dawn");
    assert.equal(facts.stage?.characters?.mira?.expression, "hopeful");
    assert.deepEqual(facts.callStack?.[0]?.returnTo, { label: "chapter_entry", index: 1 });
    assert.equal(facts.active?.location?.label, "chapter_body");
    assert.equal(facts.active?.location?.index, 2);
    assert.equal(await page.locator('#novel-execution-trace [data-location="chapter_body:0"][data-op="scene"]').count(), 1);
    assert.equal(await page.locator('#novel-execution-trace [data-location="chapter_body:2"][data-op="say"]').count(), 1, "the helper-driven target say appears in the visible trace exactly once");
    observations.browserReached = facts;
    await capture(page, "replay-input-continued-target-reached");

    phase = "locate exact original source addresses and ensure draft edits invalidate the frozen context";
    const dialogueSource = page.locator('#novel-live-view .nv-preview-source[data-source-kind="dialogue"]');
    assert.equal(await dialogueSource.getAttribute("data-source-location"), "chapter_body:2");
    await dialogueSource.click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "chapter_body");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    const labelId = page.getByLabel("标签 ID", { exact: true });
    await labelId.fill("chapter_body_renamed");
    await labelId.press("Tab");
    assert.equal(await labelId.inputValue(), "chapter_body_renamed");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "idle");
    assert.equal(await page.locator("#novel-context-preview-facts").isHidden(), true, "renaming the source invalidates the old execution snapshot");
    const renamedDialogueSource = page.locator('#novel-live-view .nv-preview-source[data-source-kind="dialogue"]');
    assert.equal(await renamedDialogueSource.getAttribute("data-source-location"), "chapter_body_renamed:2", "a unique unchanged executed instruction remaps to its current original-story label");
    assert.equal(await renamedDialogueSource.isDisabled(), false, "the remapped source still identifies the same stable say instruction");
    assert.equal(await roots.inputValue(), "replay:locked-chapter", "source navigation and rename do not silently change the selected root identity");
    await capture(page, "source-rename-invalidated-context");
    await renamedDialogueSource.click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "chapter_body_renamed", "the remapped executed dialogue locates the renamed source document");

    phase = "reconstruct against the renamed original story label and locate its current scene source";
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.locator(".nv-jump-control select").selectOption("chapter_body_renamed");
    await page.locator(".nv-jump-control input").fill("0");
    await roots.selectOption("blueprint:chapter_root");
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "reached");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.stage?.background, "dawn");
    assert.equal(facts.callStack?.length, 1);
    assert.equal(await status(page).getAttribute("data-root-kind"), "blueprint");
    assert.equal(await status(page).getAttribute("data-root-identity"), "chapter_root");
    const renamedBackground = page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"]');
    const renamedCharacter = page.locator('#novel-live-view .nv-preview-source[data-source-kind="character"]');
    assert.equal(await renamedBackground.getAttribute("data-source-location"), "chapter_body_renamed:0");
    assert.equal(await renamedCharacter.getAttribute("data-source-location"), "chapter_body_renamed:0");
    assert.equal(await page.locator('#novel-execution-trace [data-location="chapter_body_renamed:0"][data-op="scene"]').count(), 1);
    await renamedCharacter.click();
    assert.equal(await page.locator(".nv-label.active .nv-label-name").innerText(), "chapter_body_renamed");
    const expressionField = page.getByLabel("表情键", { exact: true }).first();
    assert.equal(await expressionField.inputValue(), "hopeful");
    await expressionField.fill("neutral");
    await expressionField.press("Tab");
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "idle");
    assert.equal(await page.locator("#novel-context-preview-facts").isHidden(), true, "draft edits invalidate context facts and source locators");
    assert.equal(await page.locator('#novel-live-view .nv-preview-source[data-source-kind="character"]').getAttribute("data-source-location"), "");
    await page.getByRole("button", { name: "故事编辑", exact: true }).click();
    await clickNovelHistory(page, "undo");
    assert.equal(await page.getByLabel("表情键", { exact: true }).first().inputValue(), "hopeful", "context work does not consume the author's undo history");

    phase = "root change while blocked preserves the old engine pause and cannot timeout-select";
    await page.getByRole("button", { name: "试玩与调试", exact: true }).click();
    await page.getByRole("button", { name: "运行 / 重新开始", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#novel-preview-location")?.textContent === "main_gate:0");
    await roots.selectOption("replay:locked-chapter");
    await selectTarget(page, { label: "chapter_body_renamed", index: 2 });
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "choice");
    const oldRootKind = await status(page).getAttribute("data-root-kind");
    const oldRootIdentity = await status(page).getAttribute("data-root-identity");
    await roots.selectOption("blueprint:wrong_root");
    assert.ok(!["choice", "input", "replaying"].includes((await status(page).getAttribute("data-status")) ?? ""), "selecting another root cancels the old context session");
    assert.equal(await page.locator("#novel-context-preview-facts").isHidden(), true);
    assert.equal(await status(page).getAttribute("data-root-kind"), oldRootKind);
    assert.equal(await status(page).getAttribute("data-root-identity"), oldRootIdentity, "old view provenance is not relabeled to the newly selected root");
    const retainedChoice = page.locator('#novel-live-view .nv-button.choice-button').filter({ hasText: "进入章节" });
    assert.equal(await retainedChoice.count(), 1, "the old unresolved choice remains visible while its engine is paused");
    assert.equal(await retainedChoice.isDisabled(), true, "a cancelled root cannot accept a choice against its stale continuation");
    for (const source of await page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"], #novel-live-view .nv-preview-source[data-source-kind="character"]').all()) {
      assert.equal(await source.isDisabled(), true, "old stage pixels cannot claim provenance from the selected new root");
      assert.equal(await source.getAttribute("data-source-location"), "");
    }
    await page.waitForTimeout(timeoutMs * 3);
    assert.equal(await retainedChoice.count(), 1, "the paused timed choice does not auto-select after root invalidation");
    assert.equal(await status(page).getAttribute("data-root-identity"), oldRootIdentity);
    await capture(page, "root-changed-old-choice-paused");

    phase = "explicitly reconstruct the different valid blueprint root and report its real early ending";
    await page.locator("#novel-preview-context").click();
    await page.waitForFunction(() => document.querySelector("#novel-context-preview-status")?.getAttribute("data-status") === "ended");
    facts = JSON.parse(await page.locator("#novel-context-preview-facts").innerText()) as Record<string, any>;
    assert.equal(facts.active?.kind, "ending");
    assert.equal(facts.active?.id, "wrong-ending");
    assert.equal(facts.stage?.background, "archive");
    assert.equal(Object.hasOwn(facts.variables ?? {}, "mainOnly"), false);
    assert.equal(await status(page).getAttribute("data-root-kind"), "blueprint");
    assert.equal(await status(page).getAttribute("data-root-identity"), "wrong_root");
    assert.equal(await page.locator('#novel-execution-trace [data-location="wrong_body:0"][data-op="scene"]').count(), 1);
    assert.equal(await page.locator('#novel-live-view .nv-preview-source[data-source-kind="background"]').getAttribute("data-source-location"), "wrong_body:0");
    observations.wrongRoot = { status: "ended", root: "blueprint:wrong_root", target: "chapter_body_renamed:2", active: facts.active, stage: facts.stage };
    await capture(page, "wrong-blueprint-root-ended-before-target");

    phase = "run the same selected replay path inside a real pinned QuickJS Guest NativeSession";
    native = new NativeSession({ bytecodePath: join(artifact, "app.qjbc"), pakPath: join(artifact, "app.pak"), metadataPath, runtimeAbi: metadata.runtimeAbi }, { width: 360, height: 640, deadlineMs: 30_000 });
    let nativeFrame = await native.boot();
    nativeFrame = await native.tap("启程 · 开始新的故事", nativeFrame);
    recordFrame("guest-locked-replay-choice", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=choice/);
    assert.match(textOf(nativeFrame), /CTX_ROOT=replay:locked-chapter/);
    assert.match(textOf(nativeFrame), /CTX_VARS=routeNo:59;code:-;mainOnly:-/);
    assert.match(textOf(nativeFrame), /CTX_BACKGROUND=roof/);
    assert.match(textOf(nativeFrame), /CTX_CALLSTACK=none/);
    assert.match(textOf(nativeFrame), /CTX_META=\[\]/, "locked author preview does not fabricate ending progress in QuickJS");
    await new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs * 3));
    nativeFrame = await native.frame();
    assert.match(textOf(nativeFrame), /CTX_STATUS=choice/, "without an attached host clock the Guest does not guess timed choices");

    nativeFrame = await native.tap("进入章节", nativeFrame);
    recordFrame("guest-choice-applied", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=choice/, "the helper waits for explicit continuation after the real Guest choice");
    nativeFrame = await native.tap(continueLabel, nativeFrame);
    recordFrame("guest-input-blocker", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=input/);
    assert.match(textOf(nativeFrame), /CTX_VARS=routeNo:59;code:-;mainOnly:-/);
    const inputPlaceholder = textOp(nativeFrame, "输入代码");
    const inputPoint = center(inputPlaceholder, "输入代码");
    observations.nativeInputTarget = { text: inputPlaceholder.text, bounds: { x: inputPlaceholder.x, y: inputPlaceholder.y, w: inputPlaceholder.w, h: inputPlaceholder.h }, pointer: inputPoint };
    native.sendEvent("input.pointer", { phase: "down", id: 0, x: inputPoint.x, y: inputPoint.y });
    const inputDown = await native.frame();
    recordFrame("guest-input-focus-down", inputDown);
    native.sendEvent("input.pointer", { phase: "up", id: 0, x: inputPoint.x, y: inputPoint.y });
    nativeFrame = await native.frame();
    recordFrame("guest-input-focus-up", nativeFrame);
    const inputSamples = [inputDown, nativeFrame];
    let opened = inputSamples.flatMap(frame => frame.events ?? []).find(event => event.name === "textInput.open")?.payload;
    for (let attempt = 0; !opened && attempt < 12; attempt++) {
      nativeFrame = await native.frame();
      recordFrame(`guest-input-focus-poll-${attempt + 1}`, nativeFrame);
      inputSamples.push(nativeFrame);
      opened = inputSamples.flatMap(frame => frame.events ?? []).find(event => event.name === "textInput.open")?.payload;
    }
    assert.ok(opened, "the real Guest opens the registered text input protocol for the unresolved choice route");
    native.sendEvent("textInput.edit", {
      id: opened!.id,
      editingSession: opened!.editingSession,
      revision: opened!.revision + 1,
      jsRevision: opened!.jsRevision,
      text: "NORTH",
      selectionBase: 5,
      selectionExtent: 5,
      composingBase: -1,
      composingExtent: -1,
    });
    nativeFrame = await native.frame();
    recordFrame("guest-input-draft", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_VARS=routeNo:59;code:-;mainOnly:-/, "the input draft does not become a story variable before submit");
    nativeFrame = await native.tap("提交", nativeFrame);
    recordFrame("guest-input-submitted", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=input/);
    nativeFrame = await native.tap(continueLabel, nativeFrame);
    nativeFrame = await native.settle(nativeFrame, 2);
    recordFrame("guest-target-reached", nativeFrame);
    const nativeFinalText = textOf(nativeFrame);
    assert.match(nativeFinalText, /CTX_STATUS=reached/);
    assert.match(nativeFinalText, /CTX_ROOT=replay:locked-chapter/);
    assert.match(nativeFinalText, /CTX_VARS=routeNo:59;code:NORTH;mainOnly:-/);
    assert.match(nativeFinalText, /CTX_BACKGROUND=dawn/);
    assert.match(nativeFinalText, /CTX_CALLSTACK=chapter_entry:1/);
    assert.match(nativeFinalText, /CTX_ACTIVE=say:chapter-target/);
    assert.match(nativeFinalText, /CTX_LOCATION=chapter_body:2/);
    assert.ok((nativeFrame.ops ?? []).some(operation => operation.type === "text" && operation.text?.includes("Chapter NORTH / 59")), "QuickJS Guest renders the target say after actual native input");
    const nativeLine = (key: string): string => {
      const line = nativeFinalText.split("\n").find(value => value.startsWith(`${key}=`));
      assert.ok(line, `Guest facts must include ${key}`);
      return line!.slice(key.length + 1);
    };
    assert.deepEqual({
      status: nativeLine("CTX_STATUS"),
      root: nativeLine("CTX_ROOT"),
      variables: nativeLine("CTX_VARS"),
      background: nativeLine("CTX_BACKGROUND"),
      callStack: nativeLine("CTX_CALLSTACK"),
      active: nativeLine("CTX_ACTIVE"),
      location: nativeLine("CTX_LOCATION"),
    }, {
      status: browserTargetStatus,
      root: "replay:locked-chapter",
      variables: `routeNo:${browserTargetFacts!.variables.routeNo};code:${browserTargetFacts!.variables.routeCode};mainOnly:${browserTargetFacts!.variables.mainOnly ?? "-"}`,
      background: browserTargetFacts!.stage.background,
      callStack: browserTargetFacts!.callStack.map((frame: any) => frame.returnTo.label + ":" + frame.returnTo.index).join(","),
      active: browserTargetFacts!.active.kind + ":" + browserTargetFacts!.active.id,
      location: browserTargetFacts!.active.location.label + ":" + browserTargetFacts!.active.location.index,
    }, "Browser and the pinned Guest execute the same declared replay entry and actual choice/input route to matching engine facts");

    nativeFrame = await native.tap("错误根", nativeFrame);
    recordFrame("guest-wrong-blueprint-root", nativeFrame);
    assert.match(textOf(nativeFrame), /CTX_STATUS=ended/);
    assert.match(textOf(nativeFrame), /CTX_ROOT=blueprint:wrong_root/);
    assert.match(textOf(nativeFrame), /CTX_BACKGROUND=archive/);
    assert.match(textOf(nativeFrame), /CTX_ACTIVE=ending:wrong-ending/);
    assert.doesNotMatch(textOf(nativeFrame), /CTX_LOCATION=chapter_body:2/);
    observations.native = { matchingPath: true, wrongRoot: "ended", wrongEnding: "wrong-ending", frames: nativeFrames.map(frame => frame.name) };

    assert.deepEqual(browserErrors, [], `Browser page errors: ${JSON.stringify(browserErrors)}`);
    assert.deepEqual(readFileSync(join(project, "story.json")), originalStoryBytes, "context preview, source locating, rename draft, and undo never save story.json implicitly");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "novel.assets.json"), "utf8")), assets);
    result = "passed";
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
    throw error;
  } finally {
    try { await native?.quit(); } catch (error) { observations.nativeCleanupError = String(error); }
    try { await browser?.close(); } finally {
      try { await server?.stop(true); } finally {
        if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE;
        else process.env.POCKET_NATIVE_PROBE = previousProbe;
        const sourcePaths = [
          "sdk/packages/pocket_vn/src/engine.ts",
          "sdk/packages/pocket_vn/src/editor-runtime.ts",
          "sdk/packages/pocket_vn/src/preview-context.ts",
          "sdk/packages/pocket_vn/src/replay.ts",
          "sdk/packages/pocket_vn/src/types.ts",
          "sdk/editor/client/novel.js",
          "sdk/editor/client/novel.css",
          "sdk/editor/test/novel_context_entry_browser.test.ts",
          "demo/js/tests/native_session.ts",
        ];
        const record = {
          outcome: result,
          failure,
          phase,
          projectId,
          storySha256: sourceStoryHash,
          appSha256: sourceAppHash,
          retainedFixtureAsset: { path: "demo/js/apps/lantern/art/station.png", sha256: sha256File(lanternAssetPath), bytes: readFileSync(lanternAssetPath).byteLength },
          rootTarget: target,
          environment: {
            bunPath: resolve(process.execPath),
            bunVersion: execFileSync(expectedBunPath, ["--version"], { encoding: "utf8" }).trim(),
            playwrightChromium: browserVersion,
            probePath,
            probeSha256: existsSync(probePath) ? sha256File(probePath) : null,
            probeExpectedSha256: expectedProbeSha256,
            probeIdentitySource: explicitProbePath ? "explicit-environment-pair" : "frozen-default",
            compilerPath: process.env.POCKET_TOOLS_PACKAGE ? join(process.env.POCKET_TOOLS_PACKAGE, "compiler/tools/build.ts") : null,
            compilerSha256: process.env.POCKET_TOOLS_PACKAGE && existsSync(join(process.env.POCKET_TOOLS_PACKAGE, "compiler/tools/build.ts"))
              ? sha256File(join(process.env.POCKET_TOOLS_PACKAGE, "compiler/tools/build.ts"))
              : null,
          },
          sources: Object.fromEntries(sourcePaths.filter(path => existsSync(join(repository, path))).map(path => [path, sha256File(join(repository, path))])),
          buildArtifacts,
          observations,
          browserScreenshots,
          nativeFrames,
          browserErrors,
        };
        writeJson(join(runDir, "context-entry-browser-result.json"), record);
        rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
});
