import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { createPreviewManager, type PreviewFrame } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(sdkRoot, "..");
const demoRoot = join(repositoryRoot, "demo/js");
const bytecode = join(repositoryRoot, "demo/assets/app.qjbc");
const pak = join(repositoryRoot, "demo/assets/app.pak");
const probe = process.env.POCKET_NATIVE_PROBE ?? resolveNativeProbePath(sdkRoot);
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

function textOp(frame: PreviewFrame, text: string): Record<string, unknown> | undefined {
  return frame.ops.find((value) => value.type === "text" && value.text === text);
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("browser RecordingPanel records, verifies, and exports a real preview archive", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required: ${probe}`);
  assert.ok(existsSync(bytecode), `Showcase bytecode is required: ${bytecode}`);
  assert.ok(existsSync(pak), `Showcase pak is required: ${pak}`);
  assert.ok(existsSync(playwrightPath), `Playwright Chromium module is required: ${playwrightPath}`);

  // This imports the pinned Playwright package and launches its bundled
  // Chromium. The test never starts or attaches to the system Chrome.
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: demoRoot,
    width: 390,
    height: 844,
    idleDisposeMs: 30_000,
    artifacts: { bytecodePath: bytecode, pakPath: pak, revision: 1, tickHz: 60 },
  });
  const projectId = `showcase-recording-browser-${Math.random().toString(36).slice(2)}`;
  const prefix = `/api/projects/${projectId}/preview`;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    fetch: (request: Request) => {
      const pathname = new URL(request.url).pathname;
      const endpoint = pathname.endsWith("/stream")
        ? "stream"
        : pathname.endsWith("/input")
          ? "input"
          : pathname.endsWith("/snapshot")
            ? "snapshot"
            : "page";
      return manager.handle(request, projectId, endpoint);
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    const previewRequests: string[] = [];
    page.on("request", (request: any) => {
      if (request.url().includes(prefix)) previewRequests.push(`${request.method()} ${request.url()} ${request.postData() ?? ""}`);
    });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__previewFrameEvidence = [];
      window.addEventListener("message", (event) => {
        const packet = event.data;
        if (packet?.source !== "pocket-editor-preview" || packet?.type !== "preview.frame") return;
        const frame = packet.frame;
        if (!frame || typeof frame !== "object") return;
        (window as any).__previewFrameEvidence.push({
          frame: Number(frame.frame),
          resources: Array.isArray(frame.resources) ? frame.resources : [],
          ops: Array.isArray(frame.ops) ? frame.ops : [],
        });
      });
    });
    const response = await page.goto(`http://127.0.0.1:${server.port}${prefix}`);
    assert.equal(response?.status(), 200, "preview page must load");
    const previewFrame = page.frames().find((frame) => frame.url().includes(prefix));
    assert.ok(previewFrame, "preview iframe/document must be attached");
    await previewFrame!.waitForFunction(
      () => Boolean((globalThis as any).PocketEditorPreviewInstance?.getFrame?.()),
      undefined,
      { timeout: 30_000 },
    );
    const canvas = previewFrame!.locator("canvas");
    await canvas.waitFor({ state: "visible", timeout: 10_000 });

    const readCurrent = async (): Promise<PreviewFrame> =>
      previewFrame!.evaluate(() => (globalThis as any).PocketEditorPreviewInstance.getFrame()) as Promise<PreviewFrame>;
    const pointFor = async (x: number, y: number): Promise<{ x: number; y: number }> => {
      const frame = await readCurrent();
      const box = await canvas.boundingBox();
      assert.ok(box, "preview canvas must retain a browser box");
      return {
        x: box!.x + x * box!.width / Number(frame.width),
        y: box!.y + y * box!.height / Number(frame.height),
      };
    };
    const clickLogical = async (x: number, y: number): Promise<void> => {
      const frame = await readCurrent();
      const box = await canvas.boundingBox();
      assert.ok(box, "preview canvas must retain a browser box");
      await canvas.click({
        position: { x: x * box!.width / Number(frame.width), y: y * box!.height / Number(frame.height) },
      });
    };
    const clickText = async (label: string): Promise<void> => {
      const frame = await readCurrent();
      const op = textOp(frame, label);
      assert.ok(op, `current native frame must expose ${label}`);
      const box = await canvas.boundingBox();
      assert.ok(box, "preview canvas must retain a browser box");
      await canvas.click({
        position: {
          x: (Number(op!.x) + Number(op!.w) / 2) * box!.width / Number(frame.width),
          y: (Number(op!.y) + Number(op!.h) / 2) * box!.height / Number(frame.height),
        },
      });
    };
    const dragLogical = async (fromX: number, fromY: number, toX: number, toY: number): Promise<void> => {
      const from = await pointFor(fromX, fromY);
      const to = await pointFor(toX, toY);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await page.mouse.up();
    };
    const stableText = async (label: string, timeoutMs = 10_000): Promise<PreviewFrame> => {
      let previousY = Number.NaN;
      let stableSamples = 0;
      return waitFor(
        readCurrent,
        (frame) => {
          const op = textOp(frame, label);
          if (!op) return false;
          const y = Number(op.y);
          stableSamples = Number.isFinite(previousY) && Math.abs(y - previousY) < 0.01 ? stableSamples + 1 : 0;
          previousY = y;
          return stableSamples >= 5;
        },
        `stable ${label}`,
        timeoutMs,
      );
    };
    const revealText = async (label: string): Promise<PreviewFrame> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          return await stableText(label, 1_000);
        } catch {
          await dragLogical(12, 600, 12, 250);
        }
      }
      return stableText(label);
    };

    const home = await waitFor(readCurrent, (frame) => !!textOp(frame, "Host"), "Showcase home");
    assert.ok(textOp(home, "Pocket"), `native home title should render; browser errors=${JSON.stringify(errors)}`);
    await clickText("Host");
    const hostPage = await waitFor(readCurrent, (frame) => !!textOp(frame, "Runtime") && !!textOp(frame, "Ready"), "Host page and startup host info");
    assert.ok(hostPage.events.some((event) => event.name === "host.request"), "Host startup requests must survive the initial rendered load frame");

    // Runtime diagnostics intentionally live below the compact viewport. Use
    // a real pointer drag through the canvas so the test exercises the same
    // JS scroll/input path as a user, rather than selecting a hidden DrawOp.
    await dragLogical(12, 500, 12, 100);
    const revealed = await stableText("Start recording");
    const start = textOp(revealed, "Start recording");
    assert.ok(start, "recording start control must be painted after the real scroll");
    await clickText("Start recording");

    let active: PreviewFrame;
    try {
      active = await waitFor(
        readCurrent,
        (frame) => (frame.ops.some((value) => value.type === "text" && typeof value.text === "string" && value.text.startsWith("Recording · 1 guests ·"))),
        "active recording status",
        45_000,
      );
    } catch (error) {
      const session = (manager as any).sessions.get(projectId) as any;
      const frame = await readCurrent();
      throw new Error(`${String(error)}; session=${JSON.stringify(session?.previewRecordingStatus?.())}; texts=${JSON.stringify(frame.ops.filter((value) => value.type === "text").map((value) => value.text).slice(-80))}; requests=${JSON.stringify(previewRequests.slice(-20))}`);
    }
    const resourceEvidence = await page.evaluate(() => (window as any).__previewFrameEvidence as Array<Record<string, unknown>>);
    assert.ok(resourceEvidence.some((frame) => Array.isArray(frame.resources) && frame.resources.length > 0), "recording restart must publish native resources from the real rendered load response");
    const session = (manager as any).sessions.get(projectId) as any;
    const activeStatus = session.previewRecordingStatus();
    assert.equal(activeStatus.recording, true, "Start recording must arm the real native trace");
    assert.equal(activeStatus.incomplete, false, JSON.stringify(activeStatus));

    await revealText("Stop & verify replay");
    await clickText("Stop & verify replay");
    const verified = await waitFor(
      readCurrent,
      (frame) => frame.ops.some((value) => value.type === "text" && typeof value.text === "string" && value.text.startsWith("Replay matched · 1 native guests")),
      "verified replay status",
      45_000,
    );
    await revealText("Export recording");
    await clickText("Export recording");
    let exported: PreviewFrame;
    try {
      exported = await waitFor(
        readCurrent,
        (frame) => frame.ops.some((value) => value.type === "text" && typeof value.text === "string" && value.text.startsWith("Exported:")),
        "export status",
        5_000,
      );
    } catch (error) {
      const session = (manager as any).sessions.get(projectId) as any;
      const frame = await readCurrent();
      throw new Error(`${String(error)}; session=${JSON.stringify(session?.previewRecordingStatus?.())}; texts=${JSON.stringify(frame.ops.filter((value) => value.type === "text").map((value) => value.text).slice(-80))}; requests=${JSON.stringify(previewRequests.slice(-20))}`);
    }
    const exportOp = exported.ops.find((value) => value.type === "text" && typeof value.text === "string" && value.text.startsWith("Exported:"));
    const manifestPath = String(exportOp?.text).slice("Exported:".length).replace(/[\r\n]/g, "").trim();
    assert.ok(manifestPath.endsWith("/recordings.json"), `unexpected export path: ${manifestPath}`);
    assert.ok(existsSync(manifestPath), `exported archive is missing: ${manifestPath}`);
    const archive = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    assert.equal(archive.schema, "pocket.recording.archive");
    assert.equal(Object.keys(archive.recordings ?? {}).length, 1);
    const recording = Object.values(archive.recordings)[0] as Record<string, any>;
    assert.equal(recording.schema, "pocket.runtime.recording");
    assert.equal(recording.incomplete, false, JSON.stringify(recording));
    assert.ok(recording.entries.some((entry: Record<string, any>) => entry.kind === "loadBytecode"));
    assert.ok(recording.entries.some((entry: Record<string, any>) => entry.kind === "frame"));
    assert.ok(recording.entries.every((entry: Record<string, any>) => entry.kind === "create" || entry.result?.traceClock));
    console.log(JSON.stringify({ acceptance: "preview-recording-browser", manifestPath, entries: recording.entries.length }));
  } finally {
    await browser.close();
    server.stop();
    await manager.dispose();
  }
});

test("destroying a recorded child closes only that native trace capture", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required: ${probe}`);
  assert.ok(existsSync(bytecode), `Showcase bytecode is required: ${bytecode}`);
  assert.ok(existsSync(pak), `Showcase pak is required: ${pak}`);
  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: demoRoot,
    width: 390,
    height: 844,
    idleDisposeMs: 30_000,
    artifacts: { bytecodePath: bytecode, pakPath: pak, revision: 1, tickHz: 60 },
  });
  const projectId = `showcase-recording-child-${Math.random().toString(36).slice(2)}`;
  const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const session = (manager as any).sessions.get(projectId) as any;
    const beforeStart = session.rootRuntime;
    await session.genericCapabilityResult(beforeStart, "diagnostics.recording.start", {});
    const root = session.rootRuntime;
    assert.notEqual(root, beforeStart, "recording must use a fresh traced root probe");
    const childAppId = "pocket.demo.profile";
    await session.handleRuntimeEvent(root, {
      type: "event",
      name: "host.request",
      payload: {
        requestId: "recording-child-create",
        capability: "system.runtime.create",
        params: { appId: childAppId },
      },
    }, 0);
    const child = session.childRuntimes.get(childAppId);
    assert.ok(child, "recording teardown test must create a real catalog child");
    const started = session.previewRecordingStatus();
    assert.equal(started.recording, true, JSON.stringify(started));
    assert.equal(started.runtimes.length, 2, JSON.stringify(started));

    await session.handleRuntimeEvent(root, {
      type: "event",
      name: "host.request",
      payload: {
        requestId: "recording-child-destroy",
        capability: "system.runtime.destroy",
        params: { instanceId: child.instanceId },
      },
    }, 0);
    const afterDestroy = session.previewRecordingStatus();
    const childStatus = afterDestroy.runtimes.find((value: Record<string, unknown>) => value.appId === childAppId);
    assert.ok(childStatus, JSON.stringify(afterDestroy));
    assert.equal(childStatus.finished, true, JSON.stringify(childStatus));
    assert.equal(childStatus.incomplete, false, JSON.stringify(childStatus));
    assert.equal(afterDestroy.recording, true, JSON.stringify(afterDestroy));

    await session.genericCapabilityResult(root, "diagnostics.recording.stop", {});
    const exported = await session.genericCapabilityResult(root, "diagnostics.recording.export", {});
    assert.ok(typeof exported.path === "string" && existsSync(exported.path), String(exported.path));
    const archive = JSON.parse(readFileSync(exported.path, "utf8")) as Record<string, any>;
    assert.equal(archive.schema, "pocket.recording.archive");
    assert.equal(Object.keys(archive.recordings ?? {}).length, 2);
    for (const recording of Object.values(archive.recordings) as Array<Record<string, any>>) {
      assert.equal(recording.incomplete, false, JSON.stringify(recording));
    }
    console.log(JSON.stringify({ acceptance: "preview-recording-child-teardown", manifestPath: exported.path }));
  } finally {
    await reader?.cancel();
    await manager.dispose();
  }
});
