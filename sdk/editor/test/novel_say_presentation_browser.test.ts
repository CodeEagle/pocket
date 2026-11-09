import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { NativeSession, textOf, type DrawOp, type Frame } from "../../../demo/js/tests/native_session.ts";
import { startEditor } from "../server.ts";
import { clickNovelHistory } from "./novel_browser_helpers.ts";

const repository = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repository, "sdk");
const highresTools = process.env.POCKET_TOOLS_PACKAGE ?? join(sdkRoot, ".pocket-build/highres-native-tools-20261107");
const probe = join(highresTools, "bin/pocket_probe");

const authoredStory = {
  id: "t02.say-presentation",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "ordinary", speaker: "Mira", text: "普通对白：灯在海雾里闪烁。" },
      { type: "say", id: "reader", speaker: "Ren", text: "全屏段落：The letter crosses the harbor before the storm, then returns with a long unbroken word, supercalifragilisticexpialidocious, and another line of 中文内容。" },
      { type: "say", id: "floating", speaker: "Mira", text: "浮动文字：海堤尽头的旧灯把雾切成细线，远处的窗逐一亮起，收信人仍没有回信。浮动文字：海堤尽头的旧灯把雾切成细线，远处的窗逐一亮起，收信人仍没有回信。" },
      { type: "ending", id: "end", text: "T02 complete" },
    ],
  },
};

const assets = {
  backgrounds: {}, characters: {}, cgs: {}, audio: {},
  skin: { frame: { image: "art/ui/harbor-frame.png", width: 512, height: 512, inset: 122 } },
};

function normalized(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

async function waitForFragment(session: NativeSession, initial: Frame, fragment: string): Promise<Frame> {
  const wanted = normalized(fragment);
  let frame = initial;
  for (let index = 0; index < 120; index++) {
    if ((frame.ops ?? []).some(op => op.type === "text" && normalized(op.text ?? "").includes(wanted))) return frame;
    if (normalized(textOf(frame)).includes(wanted)) return frame;
    frame = await session.frame();
  }
  throw new Error(`Guest did not paint ${JSON.stringify(fragment)}; painted=${textOf(frame)}`);
}

function bodyTextOp(frame: Frame, fragment: string): DrawOp {
  const wanted = normalized(fragment);
  const op = (frame.ops ?? []).find(item => item.type === "text" && normalized(item.text ?? "").includes(wanted));
  if (!op) throw new Error(`Guest draw list does not contain ${JSON.stringify(fragment)}; painted=${textOf(frame)}`);
  return op;
}

function expectInsideViewport(op: DrawOp, frame: Frame, label: string): void {
  expect(typeof op.x, `${label} text must expose its left coordinate`).toBe("number");
  expect(typeof op.y, `${label} text must expose its top coordinate`).toBe("number");
  expect(typeof op.w, `${label} text must expose its width`).toBe("number");
  expect(typeof op.h, `${label} text must expose its height`).toBe("number");
  expect(op.x!).toBeGreaterThanOrEqual(0);
  expect(op.y!).toBeGreaterThanOrEqual(0);
  expect(op.x! + op.w!).toBeLessThanOrEqual(frame.width! + 1);
  expect(op.y! + op.h!).toBeLessThanOrEqual(frame.height! + 1);
}

test("Editor say layout history survives reopen and the pinned Guest paints three usable layouts", { timeout: 240_000 }, async () => {
  const projectId = "t02-say-presentation";
  const temporary = mkdtempSync(join(tmpdir(), "pocket-t02-say-presentation-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  mkdirSync(project, { recursive: true });
  const previousTools = process.env.POCKET_TOOLS_PACKAGE;
  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "fixture setup";

  try {
    process.env.POCKET_TOOLS_PACKAGE = highresTools;
    process.env.POCKET_NATIVE_PROBE = probe;
    mkdirSync(join(project, "art/ui"), { recursive: true });
    copyFileSync(join(repository, "demo/js/apps/lantern/art/ui/harbor-frame.png"), join(project, "art/ui/harbor-frame.png"));
    writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "test.t02.say-presentation", name: "T02 Say Presentation", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "test.t02.say-presentation", name: "T02 Say Presentation", app: { entry: "app.tsx", output: "app", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "test.t02.say-presentation", capabilities: { requires: [], optional: [] } }));
    writeFileSync(join(project, "package.json"), JSON.stringify({
      type: "module",
      dependencies: {
        "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
        "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
        "@pocket/spine": `file:${join(sdkRoot, "packages/pocket_spine")}`,
        "@pocket/live2d": `file:${join(sdkRoot, "packages/pocket_live2d")}`,
      },
    }));
    writeFileSync(join(project, "story.json"), `${JSON.stringify(authoredStory, null, 2)}\n`);
    writeFileSync(join(project, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
    writeFileSync(join(project, "app.tsx"), `
import { onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { createHostBridge } from "@pocket/ui/host";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView, type NovelAssets } from "@pocket/vn/view";
import story from "./story.json";
import assets from "./novel.assets.json";

function App() {
  const host = createHostBridge();
  const engine = createNovelEngine(story as StoryDefinition, { preferences: { textSpeedCharsPerSecond: 0 } });
  onCleanup(() => { engine.dispose(); host.dispose(); });
  return <NovelView host={host} engine={engine} assets={assets as NovelAssets} title="T02" onNewGame={() => engine.start()} />;
}

mount(App);
`);

    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.setDefaultTimeout(12_000);
    await page.goto(`http://127.0.0.1:${server.port}/novel?project=${projectId}`);
    await page.locator(".nv-instruction").first().waitFor();

    phase = "edit default presentation and exercise undo/redo";
    const cards = page.locator(".nv-instruction");
    const modes = [cards.nth(0).getByLabel("对白呈现", { exact: true }), cards.nth(1).getByLabel("对白呈现", { exact: true }), cards.nth(2).getByLabel("对白呈现", { exact: true })];
    expect(await modes[0]!.inputValue()).toBe("dialogue");
    await modes[0]!.selectOption("fullscreen");
    expect(await modes[0]!.inputValue()).toBe("fullscreen");
    await clickNovelHistory(page, "undo");
    expect(await modes[0]!.inputValue()).toBe("dialogue");
    await clickNovelHistory(page, "redo");
    expect(await modes[0]!.inputValue()).toBe("fullscreen");
    await modes[0]!.selectOption("dialogue");
    expect(await modes[0]!.inputValue()).toBe("dialogue");
    await modes[1]!.selectOption("fullscreen");
    await modes[2]!.selectOption("floating");

    phase = "save and reopen the authored story";
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const storyPath = join(project, "story.json");
    const savedStory = JSON.parse(readFileSync(storyPath, "utf8"));
    expect(Object.hasOwn(savedStory.script.start[0], "presentation")).toBe(false);
    expect(savedStory.script.start[1].presentation).toBe("fullscreen");
    expect(savedStory.script.start[2].presentation).toBe("floating");
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    const reopenedCards = page.locator(".nv-instruction");
    expect(await reopenedCards.nth(0).getByLabel("对白呈现", { exact: true }).inputValue()).toBe("dialogue");
    expect(await reopenedCards.nth(1).getByLabel("对白呈现", { exact: true }).inputValue()).toBe("fullscreen");
    expect(await reopenedCards.nth(2).getByLabel("对白呈现", { exact: true }).inputValue()).toBe("floating");

    phase = "build through the Editor pinned Guest route";
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    expect(await page.locator("#novel-notice").innerText()).toContain("Guest 已构建完成");
    const status = await (await fetch(`http://127.0.0.1:${server.port}/api/projects/${projectId}/status`)).json() as any;
    expect(status.builtRevision).toBe(status.revision);
    const artifact = join(workspace, "builds", projectId, String(status.builtRevision));
    const metadataPath = join(artifact, "app.bytecode.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const bytecodePath = join(artifact, "app.qjbc");
    const pakPath = join(artifact, "app.pak");
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    console.log(`[T02 say presentation Guest] ${JSON.stringify({ storySha256: sha(storyPath), qjbcSha256: sha(bytecodePath), pakSha256: sha(pakPath), pakBytes: readFileSync(pakPath).length, builtRevision: status.builtRevision, modes: savedStory.script.start.slice(0, 3).map((instruction: any) => instruction.presentation ?? "dialogue") })}`);

    phase = "real NativeSession layout and pointer progression";
    native = new NativeSession({ bytecodePath, pakPath, metadataPath, runtimeAbi: metadata.runtimeAbi }, {
      width: 360,
      height: 640,
      deadlineMs: 60_000,
      memory: { heapLimitBytes: 134_217_728, maxPakBytes: 75_497_472 },
    });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);

    frame = await waitForFragment(native, frame, "普通对白：灯在海雾里闪烁。");
    const ordinary = bodyTextOp(frame, "普通对白：灯在海雾里闪烁。");
    expectInsideViewport(ordinary, frame, "dialogue");
    expect((frame.ops ?? []).some(op => op.type === "textureTriangle" && (op as DrawOp & { asset?: string }).asset === "art/ui/harbor-frame.png")).toBe(true);
    frame = await native.tap(ordinary.text!, frame);

    frame = await waitForFragment(native, frame, "The letter crosses");
    const fullscreen = bodyTextOp(frame, "The letter crosses");
    expectInsideViewport(fullscreen, frame, "fullscreen");
    expect(fullscreen.y!).toBeLessThan(ordinary.y! - 60);
    expect((frame.ops ?? []).some(op => op.type === "textureTriangle" && (op as DrawOp & { asset?: string }).asset === "art/ui/harbor-frame.png")).toBe(true);
    expect(normalized(textOf(frame))).toContain("supercalifragilisticexpialidocious");
    expect(normalized(textOf(frame))).toContain("中文内容");
    frame = await native.tap(fullscreen.text!, frame);

    frame = await waitForFragment(native, frame, "浮动文字");
    const floating = bodyTextOp(frame, "浮动文字");
    expectInsideViewport(floating, frame, "floating");
    expect(floating.x!).toBeGreaterThan(fullscreen.x!);
    expect(floating.w!).toBeLessThan(fullscreen.w!);
    expect((frame.ops ?? []).some(op => op.type === "textureTriangle" && (op as DrawOp & { asset?: string }).asset === "art/ui/harbor-frame.png")).toBe(true);
    expect(textOf(frame)).toContain("旧灯把雾切成细线");
    const rect = (op: DrawOp) => ({ x: op.x, y: op.y, width: op.w, height: op.h, text: op.text });
    console.log(`[T02 say presentation native geometry] ${JSON.stringify({ viewport: { width: frame.width, height: frame.height }, dialogue: rect(ordinary), fullscreen: rect(fullscreen), floating: rect(floating) })}`);
    frame = await native.tap(floating.text!, frame);
    await waitForFragment(native, frame, "T02 complete");
  } catch (error) {
    throw new Error(`T02 say-presentation workflow failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await native?.quit();
    await browser?.close();
    await server?.stop(true);
    if (previousTools === undefined) delete process.env.POCKET_TOOLS_PACKAGE; else process.env.POCKET_TOOLS_PACKAGE = previousTools;
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    rmSync(temporary, { recursive: true, force: true });
  }
});
