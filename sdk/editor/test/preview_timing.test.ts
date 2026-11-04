/*
 * Browser acceptance for input back-pressure. A delayed DOWN leaves later
 * MOVE records unsent; only the final MOVE may replace the adjacent pending
 * moves, and the terminal UP must remain a separate ordered packet.
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const fixture = join(import.meta.dir, "fixtures/scroll");
const playwrightOverride = process.env.POCKET_PLAYWRIGHT;

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("preview coalesces only unsent same-contact moves under slow input", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for browser timing acceptance: ${probe}`);
  if (playwrightOverride) assert.ok(existsSync(playwrightOverride), `POCKET_PLAYWRIGHT does not exist: ${playwrightOverride}`);
  const { chromium } = playwrightOverride
    ? await import(pathToFileURL(playwrightOverride).href)
    : await import("playwright");
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-timing-build-"));
  let built;
  try {
    built = await buildGuest({ projectRoot: fixture, outDir: output, tickHz: 60 });
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
  const manager = createPreviewManager({
    probePath: probe,
    width: 390,
    height: 360,
    idleDisposeMs: 1000,
    artifacts: {
      bytecode: built.bytecode,
      pak: built.pak,
      revision: 1,
      tickHz: 60,
    },
  });
  const projectId = "scroll-timing";
  const prefix = `/api/projects/${projectId}/preview`;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const pathname = new URL(request.url).pathname;
      const endpoint = pathname.endsWith("/stream")
        ? "stream"
        : pathname.endsWith("/input")
          ? "input"
          : "page";
      return manager.handle(request, projectId, endpoint);
    },
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
  const requests: Array<Record<string, any>> = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/input")) return;
    const body = request.postData();
    if (body) requests.push(JSON.parse(body) as Record<string, any>);
  });
  page.on("response", (response) => {
    if (response.request().method() === "POST" && response.url().endsWith("/input") && !response.ok()) {
      responseErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let delayFirstDown = true;
  let holdStartedResolve!: () => void;
  const holdStarted = new Promise<void>((resolveHold) => { holdStartedResolve = resolveHold; });
  await page.route("**/input", async (route) => {
    const body = route.request().postData();
    const payload = body ? JSON.parse(body) as Record<string, any> : undefined;
    if (delayFirstDown && payload?.type === "pointer" && payload.phase === "down") {
      delayFirstDown = false;
      // Let the real manager receive and process DOWN first, then hold only
      // the browser response. The native timer must keep advancing while the
      // client is back-pressured and its later moves are still unsent.
      const response = await route.fetch();
      holdStartedResolve();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  try {
    const pageResponse = await page.goto(`http://127.0.0.1:${server.port}${prefix}`);
    assert.equal(pageResponse?.status(), 200);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame()), undefined, { timeout: 30_000 });
    const beforeFrame = await page.evaluate(() => Number((window as any).PocketEditorPreviewInstance.getFrame().frame));

    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const rect = canvas.getBoundingClientRect();
      const emit = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 101,
        pointerType: "touch",
        clientX: rect.left + x,
        clientY: rect.top + y,
        buttons: type === "pointerup" ? 0 : 1,
      }));
      emit("pointerdown", 20, 160);
      for (let x = 32; x <= 176; x += 8) emit("pointermove", x, 160);
      emit("pointerup", 176, 160);
    });

    await holdStarted;
    await waitFor(
      () => page.evaluate(() => Number((window as any).PocketEditorPreviewInstance.getFrame().frame)),
      (frame) => frame > beforeFrame + 1,
      "scheduled frames during held input response",
    );

    await waitFor(
      () => requests.filter((value) => value.type === "pointer").length,
      (count) => count >= 3,
      "coalesced pointer burst",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const packets = requests.filter((value) => value.type === "pointer");
    assert.deepEqual(packets.map((value) => value.phase), ["down", "move", "up"]);
    assert.equal(packets[0].id, packets[1].id);
    assert.equal(packets[1].id, packets[2].id);
    assert.ok(packets[1].x > packets[0].x, "the retained move must use the final point, not the first queued point");
    assert.equal(packets[1].x, packets[2].x, "UP must follow the retained final MOVE point");
    assert.equal(packets[1].y, packets[2].y);
    assert.deepEqual(responseErrors, []);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    server.stop(true);
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});

test("preview clock ledger advances with elapsed time during continuous input", { timeout: 60_000 }, async () => {
  // This probe is deliberately only a line-protocol clock instrument. It
  // avoids demo assets and reports every frame's received delta in the real
  // PreviewSession FrameResult path, so the assertion can distinguish wall
  // elapsed time from the number of zero-delta input edges.
  const root = mkdtempSync(join(tmpdir(), "pocket-editor-clock-probe-"));
  const probePath = join(root, "clock-probe.mjs");
  const bytecodePath = join(root, "app.qjbc");
  const pakPath = join(root, "app.pak");
  const source = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
let frame = 0;
let totalDelta = 0;
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.op === "frame") {
    const deltaMs = Number(command.deltaMs);
    const delta = Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
    totalDelta += delta;
    frame += 1;
    reply({ ok: true, frame: { frame, width: 390, height: 360, ops: [], events: [{ name: "debug.clock", payload: { deltaMs: delta, totalDelta } }], resources: [] } });
  } else if (command.op === "schedule") reply({ ok: true, nextWakeDelayMs: 0 });
  else if (["create", "loadBytecode", "load", "send", "resize", "destroy"].includes(command.op)) reply({ ok: true });
  else if (command.op === "quit") { reply({ ok: true }); setImmediate(() => process.exit(0)); }
  else reply({ ok: false, error: "unsupported clock probe command" });
});
`;
  await writeFile(probePath, source, "utf8");
  await chmod(probePath, 0o755);
  await writeFile(bytecodePath, "clock-probe-bytecode", "utf8");
  await writeFile(pakPath, "clock-probe-pak", "utf8");
  const manager = createPreviewManager({
    probePath,
    width: 390,
    height: 360,
    idleDisposeMs: 1000,
    artifacts: { bytecode: bytecodePath, pak: pakPath, revision: 1, tickHz: 60 },
  });
  const projectId = "clock-ledger";
  const inputUrl = `http://127.0.0.1/api/projects/${projectId}/preview/input`;
  const snapshotTotal = async (): Promise<number> => {
    const response = await manager.handle(new Request(`http://127.0.0.1/api/projects/${projectId}/preview/snapshot`), projectId, "snapshot");
    const body = await response.json() as { frame?: { events?: Array<Record<string, any>> } };
    const event = body.frame?.events?.find((value) => value.name === "debug.clock");
    return Number(event?.payload?.totalDelta ?? 0);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`http://127.0.0.1/api/projects/${projectId}/preview/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const initialTotal = await snapshotTotal();
    const startedAt = performance.now();
    for (let index = 0; index < 20; index += 1) {
      const phase = index === 0 ? "down" : "move";
      const response = await manager.handle(new Request(inputUrl, {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id: 0, x: 20 + index, y: 120 }),
      }), projectId, "input");
      assert.equal(response.status, 200);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
    }
    const duringInputTotal = await snapshotTotal();
    assert.ok(duringInputTotal > initialTotal + 1, "a real scheduled frame must advance while input is still arriving");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
    const elapsedMs = performance.now() - startedAt;
    const finalTotal = await snapshotTotal();
    const advancedMs = finalTotal - initialTotal;
    assert.ok(advancedMs >= elapsedMs * 0.3, `clock delta ${advancedMs}ms must track elapsed ${elapsedMs}ms`);
    assert.ok(advancedMs <= elapsedMs * 2 + 40, `clock delta ${advancedMs}ms must not multiply by input event count over ${elapsedMs}ms`);
  } finally {
    await reader?.cancel();
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
