import { clickNovelHistory } from "./novel_browser_helpers.ts";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { test } from "bun:test";
import { NativeSession, textOf, type Frame } from "../../../demo/js/tests/native_session.ts";
import { startEditor } from "../server.ts";

const repository = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repository, "sdk");
const projectId = "e02-3-story-graph-canvas";
const qaRoot = join(sdkRoot, ".pocket-build/story-graph-20261109");
const nativeProbe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe");

const initialStory = {
  id: "test.e02-3.graph-canvas",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "say", id: "opening", speaker: "旁白", text: "Canvas route starts here." },
      { type: "jump", target: "old-route" },
    ],
    "old-route": [
      { type: "say", id: "old-route-line", speaker: "旁白", text: "OLD ROUTE MUST NOT RUN" },
      { type: "ending", id: "old-route-ending", text: "OLD ROUTE ENDING" },
    ],
    "new-route": [
      { type: "say", id: "new-route-line", speaker: "旁白", text: "NEW ROUTE REACHED" },
      { type: "ending", id: "new-route-ending", text: "NEW ROUTE ENDING" },
    ],
  },
};

const assets = { backgrounds: {}, characters: {}, cgs: {}, audio: {} };

async function readPositionAsync(node: Locator): Promise<{ x: number; y: number }> {
  const position = await node.evaluate(element => ({
    x: Number(element.getAttribute("data-graph-x")),
    y: Number(element.getAttribute("data-graph-y")),
  }));
  assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), `node must expose finite world coordinates: ${JSON.stringify(position)}`);
  return position;
}

function positionAt(saved: any, label: string): { x: number; y: number } {
  const position = saved.editor?.graph?.positions?.[label];
  assert.ok(position, `saved story must retain graph position for ${label}`);
  assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), `saved graph position must be finite for ${label}`);
  assert.ok(Math.abs(position.x) <= 100_000 && Math.abs(position.y) <= 100_000, `saved graph position must be bounded for ${label}`);
  return { x: position.x, y: position.y };
}

async function waitNativeText(session: NativeSession, initial: Frame, text: string): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 180; index += 1) {
    if (textOf(frame).includes(text)) return frame;
    frame = await session.frame();
  }
  throw new Error(`NativeSession did not paint ${JSON.stringify(text)}; painted=${textOf(frame)}`);
}

test("free story graph canvas persists layout and route edits without changing the pinned Guest", { timeout: 300_000 }, async () => {
  assert.ok(existsSync(nativeProbe), `the pinned release pocket_probe must exist: ${nativeProbe}`);
  const temporary = mkdtempSync(join(tmpdir(), "pocket-novel-graph-canvas-"));
  const project = join(temporary, "project");
  const workspace = join(temporary, "workspace");
  const storyPath = join(project, "story.json");
  mkdirSync(project, { recursive: true });
  mkdirSync(qaRoot, { recursive: true });
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: projectId, appId: "test.e02-3.graph-canvas", name: "E02.3 Story Graph Canvas", version: "0.1.0", build: 1, entry: "app.tsx", framework: "solid", tickHz: 60 }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    pocket: 2,
    id: "test.e02-3.graph-canvas",
    name: "E02.3 Story Graph Canvas",
    app: { entry: "app.tsx", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
  }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "test.e02-3.graph-canvas", capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(project, "package.json"), JSON.stringify({
    type: "module",
    dependencies: {
      "@pocket/ui": `file:${join(sdkRoot, "packages/pocket_ui")}`,
      "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}`,
    },
  }));
  writeFileSync(storyPath, `${JSON.stringify(initialStory, null, 2)}\n`);
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
  return <NovelView host={host} engine={engine} assets={assets as NovelAssets} title="Graph route acceptance" onNewGame={() => engine.start()} />;
}

mount(App);
`);

  const previousProbe = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = nativeProbe;
  let server: Awaited<ReturnType<typeof startEditor>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let native: NativeSession | undefined;
  let phase = "fixture setup";
  const pageErrors: string[] = [];

  const buildArtifacts = async (page: Page, origin: string, suffix: string) => {
    phase = `pinned buildGuest ${suffix}`;
    await page.getByRole("button", { name: "构建 Guest", exact: true }).click();
    await page.waitForFunction(() => /Guest 已构建完成|构建失败/.test(document.querySelector("#novel-notice")?.textContent ?? ""), undefined, { timeout: 120_000 });
    const notice = await page.locator("#novel-notice").innerText();
    assert.ok(notice.includes("Guest 已构建完成"), `${suffix} pinned buildGuest failed: ${notice}; diagnostics=${await page.locator("#novel-diagnostics").innerText()}`);
    const statusResponse = await fetch(`${origin}/api/projects/${projectId}/status`);
    assert.equal(statusResponse.status, 200);
    const status: any = await statusResponse.json();
    assert.equal(status.builtRevision, status.revision, `${suffix} Guest must be built from the current story revision`);

    const output = join(qaRoot, suffix);
    mkdirSync(output, { recursive: true });
    for (const name of ["app.qjbc", "app.pak", "app.bytecode.json"]) {
      const response = await fetch(`${origin}/api/projects/${projectId}/artifacts/${name}`);
      assert.equal(response.status, 200, `${suffix} artifact ${name} must be served by the editor build`);
      writeFileSync(join(output, name), Buffer.from(await response.arrayBuffer()));
    }
    const metadata = JSON.parse(readFileSync(join(output, "app.bytecode.json"), "utf8"));
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    assert.equal(typeof metadata.runtimeAbi, "string");
    writeFileSync(join(output, "build-status.json"), `${JSON.stringify({ revision: status.revision, builtRevision: status.builtRevision, runtimeAbi: metadata.runtimeAbi, bytecodeBytes: metadata.bytecodeBytes }, null, 2)}\n`);
    return {
      bytecodePath: join(output, "app.qjbc"),
      pakPath: join(output, "app.pak"),
      metadataPath: join(output, "app.bytecode.json"),
      runtimeAbi: metadata.runtimeAbi as string,
    };
  };

  const runNativeRoute = async (artifacts: Awaited<ReturnType<typeof buildArtifacts>>, suffix: string): Promise<string> => {
    phase = `NativeSession ${suffix}`;
    native = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 90_000 });
    let frame = await native.boot();
    frame = await native.tap("启程 · 开始新的故事", frame);
    frame = await waitNativeText(native, frame, "Canvas route starts here.");
    for (let attempt = 0; attempt < 4 && !textOf(frame).includes("NEW ROUTE REACHED"); attempt += 1) {
      const continueText = (frame.ops ?? []).find(op => op.type === "text" && op.text?.includes("轻触"))?.text;
      assert.ok(continueText, `NativeSession must expose the story advance control: ${textOf(frame)}`);
      frame = await native.tap(continueText!, frame);
      for (let index = 0; index < 20 && !textOf(frame).includes("NEW ROUTE REACHED"); index += 1) frame = await native.frame();
    }
    frame = await waitNativeText(native, frame, "NEW ROUTE REACHED");
    assert.ok(!textOf(frame).includes("OLD ROUTE MUST NOT RUN"), `edited route must skip the old target: ${textOf(frame)}`);
    const result = textOf(frame);
    await native.quit();
    native = undefined;
    return result;
  };

  try {
    server = await startEditor({ projectRoot: project, workspace, port: 0, updatePort: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on("pageerror", error => pageErrors.push(error.message));

    phase = "load editor and open the graph canvas";
    const response = await page.goto(`${origin}/novel?project=${projectId}`);
    assert.equal(response?.status(), 200);
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    const canvas = page.locator("[data-graph-canvas]");
    await canvas.waitFor();
    assert.equal(await page.locator("[data-graph-node]").count(), 3, "the full canvas must show every retained script label");
    await page.locator('#novel-graph-edges [data-graph-edge="start:1:jump"][data-graph-target="old-route"]').waitFor();
    await page.screenshot({ path: join(qaRoot, "graph-canvas-initial.png") });

    phase = "temporary viewport navigation";
    const beforeViewportOnlyChange = JSON.parse(readFileSync(storyPath, "utf8"));
    const startNode = page.locator('[data-graph-node="start"]');
    const oldRouteNode = page.locator('[data-graph-node="old-route"]');
    const newRouteNode = page.locator('[data-graph-node="new-route"]');
    const initialPositions = {
      start: await readPositionAsync(startNode),
      oldRoute: await readPositionAsync(oldRouteNode),
      newRoute: await readPositionAsync(newRouteNode),
    };
    await page.locator('[data-graph-zoom="in"]').click();
    await page.locator('[data-graph-zoom="out"]').click();
    await page.locator('[data-graph-zoom="fit"]').click();
    const panPoint = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>("[data-graph-canvas]");
      if (!viewport) return null;
      const rect = viewport.getBoundingClientRect();
      for (let y = rect.bottom - 20; y > rect.top + 20; y -= 24) {
        for (let x = rect.right - 20; x > rect.left + 20; x -= 24) {
          const hit = document.elementFromPoint(x, y);
          if (hit && !hit.closest("[data-graph-node], button, select, input, a")) return { x, y };
        }
      }
      return null;
    });
    assert.ok(panPoint, "canvas must expose a blank region that can pan the viewport");
    const world = page.locator("[data-graph-world]");
    const transformBeforePan = await world.evaluate(element => (element as HTMLElement).style.transform);
    await page.mouse.move(panPoint!.x, panPoint!.y);
    await page.mouse.down();
    await page.mouse.move(panPoint!.x + 64, panPoint!.y + 40, { steps: 4 });
    await page.mouse.up();
    const transformAfterPan = await world.evaluate(element => (element as HTMLElement).style.transform);
    assert.notEqual(transformAfterPan, transformBeforePan, "dragging blank canvas must pan the view");
    await page.locator('[data-graph-zoom="fit"]').click();
    assert.deepEqual(await readPositionAsync(startNode), initialPositions.start, "pan/zoom must not change stored world positions");
    assert.deepEqual(await readPositionAsync(oldRouteNode), initialPositions.oldRoute);
    assert.deepEqual(await readPositionAsync(newRouteNode), initialPositions.newRoute);
    assert.deepEqual(JSON.parse(readFileSync(storyPath, "utf8")), beforeViewportOnlyChange, "temporary pan/zoom state must not write story metadata");

    phase = "drag node with undo and redo";
    const beforePosition = await readPositionAsync(startNode);
    const oldRouteBeforeDrag = await readPositionAsync(oldRouteNode);
    const newRouteBeforeDrag = await readPositionAsync(newRouteNode);
    const handle = startNode.locator("[data-graph-drag-handle]");
    const handleBox = await handle.boundingBox();
    assert.ok(handleBox, "node header drag handle must be visible");
    const dragStart = { x: handleBox!.x + handleBox!.width / 2, y: handleBox!.y + handleBox!.height / 2 };
    const zoom = Number(await canvas.getAttribute("data-graph-scale"));
    assert.ok(Number.isFinite(zoom) && zoom > 0, "canvas must expose its current zoom");
    const dragDelta = { x: 60 * zoom, y: 220 * zoom };
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(dragStart.x + dragDelta.x * step / 8, dragStart.y + dragDelta.y * step / 8);
      assert.deepEqual(await readPositionAsync(oldRouteNode), oldRouteBeforeDrag, `other node old-route must not jump during drag preview ${step}`);
      assert.deepEqual(await readPositionAsync(newRouteNode), newRouteBeforeDrag, `other node new-route must not jump during drag preview ${step}`);
    }
    await page.mouse.up();
    const draggedPosition = await readPositionAsync(startNode);
    assert.notDeepEqual(draggedPosition, beforePosition, "dragging a node must change its world position");
    assert.deepEqual(await readPositionAsync(oldRouteNode), oldRouteBeforeDrag, "committing a drag must preserve every other node position");
    assert.deepEqual(await readPositionAsync(newRouteNode), newRouteBeforeDrag, "committing a drag must preserve every other node position");
    await clickNovelHistory(page, "undo");
    assert.deepEqual(await readPositionAsync(startNode), beforePosition, "one undo must restore the node's original position");
    await clickNovelHistory(page, "redo");
    assert.deepEqual(await readPositionAsync(startNode), draggedPosition, "one redo must restore the dragged node position");

    phase = "connect the existing jump port to the new route";
    const jumpPort = page.locator('[data-graph-port="start:1:jump"]');
    assert.equal(await jumpPort.count(), 1, "existing jump instruction must expose one route port");
    await jumpPort.click();
    await page.locator('[data-graph-connect-target="new-route"]').click();
    const jumpTarget = page.locator('[data-graph-node="start"] [data-graph-target="jump"]');
    await page.waitForFunction(() => document.querySelector('[data-graph-node="start"] [data-graph-target="jump"]')?.value === "new-route");
    assert.equal(await jumpTarget.inputValue(), "new-route", "port-to-node connection must update the canonical route select");
    await page.locator('#novel-graph-edges [data-graph-edge="start:1:jump"][data-graph-target="new-route"]').waitFor();

    phase = "create a node and preserve its position through rename/delete history";
    page.once("dialog", dialog => dialog.accept("scratch-node"));
    await page.locator("[data-graph-add-node]").click();
    const scratchNode = page.locator('[data-graph-node="scratch-node"]');
    await scratchNode.waitFor();
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    const scratchHandle = scratchNode.locator("[data-graph-drag-handle]");
    const scratchHandleBox = await scratchHandle.boundingBox();
    assert.ok(scratchHandleBox, "newly created graph node must have a reachable drag handle");
    const scratchDragStart = { x: scratchHandleBox!.x + scratchHandleBox!.width / 2, y: scratchHandleBox!.y + scratchHandleBox!.height / 2 };
    const scratchBefore = await readPositionAsync(scratchNode);
    await page.mouse.move(scratchDragStart.x, scratchDragStart.y);
    await page.mouse.down();
    await page.mouse.move(scratchDragStart.x + 88, scratchDragStart.y + 56, { steps: 6 });
    await page.mouse.up();
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    const scratchPosition = await readPositionAsync(scratchNode);
    assert.notDeepEqual(scratchPosition, scratchBefore, "new graph nodes must be draggable");
    assert.ok(Math.abs(scratchPosition.x - scratchBefore.x) > 20 || Math.abs(scratchPosition.y - scratchBefore.y) > 20,
      `new node must move beyond the automatic placement delta: before=${JSON.stringify(scratchBefore)}, after=${JSON.stringify(scratchPosition)}`);

    await scratchNode.locator('[aria-label="打开标签 scratch-node 的指令"]').click();
    const labelId = page.getByLabel("标签 ID", { exact: true });
    await labelId.fill("renamed-scratch");
    await labelId.press("Tab");
    await page.waitForFunction(() => document.querySelector(".nv-panel-heading h1")?.textContent === "renamed-scratch");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const renamedBeforeUndo = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.deepEqual(positionAt(renamedBeforeUndo, "renamed-scratch"), scratchPosition, "rename must persist the moved coordinate under its new label key");
    await clickNovelHistory(page, "undo");
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    const scratchAfterRenameUndo = page.locator('[data-graph-node="scratch-node"]');
    await scratchAfterRenameUndo.waitFor();
    assert.deepEqual(await readPositionAsync(scratchAfterRenameUndo), scratchPosition, "undoing rename must restore the original label and position key");
    await clickNovelHistory(page, "redo");
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    const renamedNode = page.locator('[data-graph-node="renamed-scratch"]');
    await renamedNode.waitFor();
    assert.equal(await scratchAfterRenameUndo.count(), 0, "redoing rename must remove the old node key");
    assert.deepEqual(await readPositionAsync(renamedNode), scratchPosition, "redoing rename must move its saved position to the new label key");
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const renamedSaved = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.deepEqual(positionAt(renamedSaved, "renamed-scratch"), scratchPosition, "the renamed position key must be present in the saved story before deletion");

    await renamedNode.locator('[aria-label="打开标签 renamed-scratch 的指令"]').click();
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "删除标签", exact: true }).click();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-graph-node="renamed-scratch"]'));
    await clickNovelHistory(page, "undo");
    await page.locator('[data-graph-world][data-graph-laid-out="true"]').waitFor();
    const restoredNode = page.locator('[data-graph-node="renamed-scratch"]');
    await restoredNode.waitFor();
    assert.deepEqual(await readPositionAsync(restoredNode), scratchPosition, "undoing delete must restore the deleted label and its coordinate key");
    await clickNovelHistory(page, "redo");
    await page.waitForFunction(() => !document.querySelector('[data-graph-node="renamed-scratch"]'));

    const startBoxAfterEdit = await startNode.boundingBox();
    const oldRouteBoxAfterEdit = await oldRouteNode.boundingBox();
    const newRouteBoxAfterEdit = await newRouteNode.boundingBox();
    assert.ok(startBoxAfterEdit && oldRouteBoxAfterEdit && newRouteBoxAfterEdit, "all script nodes must remain visible after editing");
    const intersects = (first: NonNullable<typeof startBoxAfterEdit>, second: NonNullable<typeof oldRouteBoxAfterEdit>) =>
      first.x < second.x + second.width && first.x + first.width > second.x &&
      first.y < second.y + second.height && first.y + first.height > second.y;
    assert.ok(!intersects(startBoxAfterEdit!, oldRouteBoxAfterEdit!), "the dragged start node must not obscure old-route");
    assert.ok(!intersects(startBoxAfterEdit!, newRouteBoxAfterEdit!), "the dragged start node must not obscure new-route");
    await page.screenshot({ path: join(qaRoot, "graph-canvas-after-drag-and-connect.png") });

    phase = "save and reopen graph layout";
    await page.locator("#novel-save").click();
    await page.waitForFunction(() => document.querySelector("#novel-save-state")?.textContent === "已保存");
    const saved = JSON.parse(readFileSync(storyPath, "utf8"));
    assert.deepEqual(saved.script.start[1].target, "new-route");
    assert.deepEqual(positionAt(saved, "start"), draggedPosition, "save must retain the dragged node's world coordinates");
    assert.equal(saved.editor.graph.version, 1);
    assert.equal(Object.hasOwn(saved.script, "scratch-node"), false);
    assert.equal(Object.hasOwn(saved.script, "renamed-scratch"), false);
    assert.equal(Object.hasOwn(saved.editor.graph.positions, "scratch-node"), false);
    assert.equal(Object.hasOwn(saved.editor.graph.positions, "renamed-scratch"), false);

    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    await page.getByRole("button", { name: "剧情地图", exact: true }).click();
    const reopenedNode = page.locator('[data-graph-node="start"]');
    assert.deepEqual(await readPositionAsync(reopenedNode), draggedPosition, "saved node coordinates must survive editor reopen");
    assert.equal(await page.locator('[data-graph-node="start"] [data-graph-target="jump"]').inputValue(), "new-route");

    const withLayoutArtifacts = await buildArtifacts(page, origin, "with-editor-layout");
    const withLayoutResult = await runNativeRoute(withLayoutArtifacts, "with editor layout");

    phase = "build and execute the same graph with editor metadata removed";
    const withoutEditor = JSON.parse(readFileSync(storyPath, "utf8"));
    delete withoutEditor.editor;
    writeFileSync(storyPath, `${JSON.stringify(withoutEditor, null, 2)}\n`);
    await page.reload();
    await page.locator(".nv-instruction").first().waitFor();
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(storyPath, "utf8")), "editor"), false);
    const noLayoutArtifacts = await buildArtifacts(page, origin, "without-editor-layout");
    const withoutLayoutResult = await runNativeRoute(noLayoutArtifacts, "without editor layout");
    assert.equal(withoutLayoutResult, withLayoutResult, "editor layout metadata must not change the played story output");
    assert.ok(withoutLayoutResult.includes("NEW ROUTE REACHED"));
    assert.deepEqual(pageErrors, [], "the browser must not report runtime errors");

    writeFileSync(join(qaRoot, "acceptance.json"), `${JSON.stringify({
      projectId,
      nativeProbe,
      screenshots: ["graph-canvas-initial.png", "graph-canvas-after-drag-and-connect.png"],
      savedGraph: { version: saved.editor.graph.version, positions: saved.editor.graph.positions, jumpTarget: saved.script.start[1].target },
      withLayoutOutput: withLayoutResult,
      withoutLayoutOutput: withoutLayoutResult,
      routeSemanticsMatch: withoutLayoutResult === withLayoutResult,
      pageErrors,
    }, null, 2)}\n`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; phase=${phase}; pageErrors=${JSON.stringify(pageErrors)}`);
  } finally {
    await native?.quit();
    await browser?.close();
    await server?.stop(true);
    if (previousProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previousProbe;
    rmSync(temporary, { recursive: true, force: true });
  }
});
