import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

type DrawOp = { type?: string; text?: string; y?: number; x?: number; w?: number; h?: number };
type Frame = { frame?: number; width?: number; height?: number; ops?: DrawOp[] };
type InputPacket = Record<string, unknown>;

const testDir = resolve(import.meta.dir);
const sdkRoot = resolve(testDir, "../..");
const fixture = join(testDir, "fixtures/scroll");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const playwrightPath = process.env.POCKET_PLAYWRIGHT ?? "/tmp/pocket-playwright-review/node_modules/playwright/index.mjs";

async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string, attempts = 250): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForQuiet(read: () => number, label: string): Promise<number> {
  let previous = read();
  let quiet = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const current = read();
    if (current === previous) {
      quiet += 1;
      if (quiet >= 4) return current;
    } else {
      previous = current;
      quiet = 0;
    }
  }
  throw new Error(`timed out waiting for ${label}`);
}

function markerY(frame: Frame | null, marker: string): number {
  const op = frame?.ops?.find((candidate) => candidate.type === "text" && candidate.text === marker);
  assert.ok(op, `frame ${String(frame?.frame)} is missing marker ${marker}`);
  assert.equal(typeof op!.y, "number", `${marker} DrawOp must expose y`);
  return op!.y!;
}

function markerYOrUndefined(frame: Frame | null, marker: string): number | undefined {
  const op = frame?.ops?.find((candidate) => candidate.type === "text" && candidate.text === marker);
  return typeof op?.y === "number" ? op.y : undefined;
}

function waitFrame(page: any, predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
  return waitFor(
    () => page.evaluate(() => (globalThis as any).PocketEditorPreviewInstance?.getFrame?.() ?? null) as Promise<Frame | null>,
    (frame): frame is Frame => frame !== null && predicate(frame),
    label,
  );
}

async function waitForStableMarker(
  page: any,
  marker: string,
  predicate: (y: number) => boolean,
  label: string,
): Promise<Frame> {
  let previousY: number | undefined;
  let stableFrames = 0;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const frame = await page.evaluate(() => (globalThis as any).PocketEditorPreviewInstance?.getFrame?.() ?? null) as Frame | null;
    const y = markerYOrUndefined(frame, marker);
    if (frame && y !== undefined && predicate(y)) {
      stableFrames = previousY !== undefined && Math.abs(y - previousY) < 0.01 ? stableFrames + 1 : 0;
      previousY = y;
      if (stableFrames >= 8) return frame;
    } else {
      previousY = undefined;
      stableFrames = 0;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("browser preview scrolls a built public SDK guest, flings after release, and bounces at both edges", async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for browser scroll acceptance: ${probe}`);
  assert.ok(existsSync(playwrightPath), `Playwright Chromium module is required: ${playwrightPath}`);
  const { chromium } = await import(pathToFileURL(playwrightPath).href);

  const output = mkdtempSync(join(tmpdir(), "pocket-editor-scroll-build-"));
  let browser: any;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const requests: InputPacket[] = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  let manager!: ReturnType<typeof createPreviewManager>;

  try {
    const built = await buildGuest({ projectRoot: fixture, outDir: output, tickHz: 60 });
    manager = createPreviewManager({
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
      clientPath: process.env.POCKET_PREVIEW_CLIENT,
    });
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const pathname = new URL(request.url).pathname;
        const endpoint = pathname.endsWith("/stream")
          ? "stream"
          : pathname.endsWith("/input")
            ? "input"
            : pathname.endsWith("/snapshot")
              ? "snapshot"
              : "page";
        return manager.handle(request, "scroll", endpoint);
      },
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 520 } });
    page.on("request", (request: any) => {
      if (request.method() !== "POST" || !request.url().endsWith("/input")) return;
      const body = request.postData();
      if (body) requests.push(JSON.parse(body) as InputPacket);
    });
    page.on("response", (response: any) => {
      if (response.request().method() === "POST" && response.url().endsWith("/input") && !response.ok()) {
        responseErrors.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));

    const pageResponse = await page.goto(`http://127.0.0.1:${server.port}/api/projects/scroll/preview`);
    assert.equal(pageResponse?.status(), 200);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame?.()), undefined, { timeout: 30_000 });
    assert.equal(await page.locator("canvas").count(), 1);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    assert.ok(box, "scroll preview canvas must have a browser layout box");
    const point = (x: number, y: number) => ({ x: box!.x + x, y: box!.y + y });
    const readFrame = (): Promise<Frame | null> => page.evaluate(() => (globalThis as any).PocketEditorPreviewInstance?.getFrame?.() ?? null);
    const waitForInputDrain = async (start: number, label: string): Promise<number> => {
      await waitFor(
        () => requests.slice(start),
        (packets) => packets.some((packet) => packet.type === "pointer" && packet.phase === "up"),
        `${label} pointer up`,
      );
      return waitForQuiet(() => requests.length, `${label} input queue`);
    };
    const waitForWheelTerminal = async (start: number, label: string): Promise<number> => {
      await waitFor(
        () => requests.slice(start),
        (packets) => packets.some((packet) => packet.type === "pointer" && (packet.phase === "cancel" || packet.phase === "up")),
        `${label} wheel terminal`,
      );
      // A long delta may re-anchor at a native coordinate edge. That emits an
      // intermediate CANCEL before the same wheel contact is DOWNed again;
      // wait past the 120 ms silence window so assertions observe the final
      // terminal edge rather than the first re-anchor barrier.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 160));
      return waitForQuiet(() => requests.length, `${label} input queue`);
    };

    const dispatchWheelBurst = async (deltas: readonly number[], label: string): Promise<number> => {
      const start = requests.length;
      await page.evaluate(async (values) => {
        const canvas = document.querySelector("canvas")!;
        for (let index = 0; index < values.length; index += 1) {
          canvas.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY: values[index],
            clientX: 195,
            clientY: 180,
          }));
          // Keep the events in one gesture while allowing the real input
          // queue to publish more than one MOVE. A synchronous burst may
          // intentionally coalesce to its latest unsent MOVE.
          if (index + 1 < values.length) await new Promise((resolveDelay) => setTimeout(resolveDelay, 24));
        }
      }, [...deltas]);
      await waitForWheelTerminal(start, label);
      return start;
    };

    const initial = await waitFrame(page, () => true, "initial scroll frame");
    const initialMiddleY = markerY(initial, "SCROLL_MIDDLE");
    assert.equal(initial.width, 390);
    assert.equal(initial.height, 360);
    assert.equal(markerYOrUndefined(initial, "SCROLL_BOTTOM"), undefined, "bottom marker should begin below the clipped viewport");

    // A trackpad's two-finger gesture arrives as a burst of wheel events, with
    // an OS-generated tail after the fingers leave the surface. The preview
    // must expose that burst as one native contact: one DOWN, consecutive
    // MOVEs, then one idle CANCEL. CANCEL deliberately carries zero release
    // velocity through ScrollablePage.onCancel/endDrag(0), so an in-bounds
    // wheel gesture stops at its last input position instead of adding a
    // second fling on top of the trackpad's own momentum.
    const topWheelStart = requests.length;
    await dispatchWheelBurst([-140, -140, -140], "top-edge wheel");
    const topWheelPackets = requests.slice(topWheelStart).filter((packet) => packet.type === "pointer") as Array<Record<string, any>>;
    assert.ok(topWheelPackets.length >= 4, "wheel burst must retain DOWN, multiple MOVEs, and CANCEL");
    const topWheelDowns = topWheelPackets.filter((packet) => packet.phase === "down");
    assert.ok(topWheelDowns.length >= 1, "wheel burst must send at least one DOWN");
    assert.equal(topWheelPackets.filter((packet) => packet.phase === "up").length, 0, "wheel burst must not synthesize UP on every delta");
    assert.equal(topWheelPackets.filter((packet) => packet.phase === "cancel").length, topWheelDowns.length, "wheel silence must cancel every re-anchored contact");
    const topWheelIds = new Set(topWheelPackets.map((packet) => packet.id));
    assert.equal(topWheelIds.size, 1, "wheel re-anchors must retain one reserved native contact id");
    for (const id of topWheelIds) {
      let open = false;
      for (const packet of topWheelPackets.filter((candidate) => candidate.id === id)) {
        if (packet.phase === "down") {
          assert.equal(open, false, `wheel contact ${String(id)} cannot DOWN twice without a CANCEL`);
          open = true;
        } else if (packet.phase === "move") {
          assert.equal(open, true, `wheel contact ${String(id)} MOVE must follow DOWN`);
        } else if (packet.phase === "cancel") {
          assert.equal(open, true, `wheel contact ${String(id)} CANCEL must follow DOWN`);
          open = false;
        }
      }
      assert.equal(open, false, `wheel contact ${String(id)} must end with CANCEL`);
    }
    const topWheelPeak = await waitFrame(
      page,
      (frame) => {
        const y = markerYOrUndefined(frame, "SCROLL_MIDDLE");
        return y !== undefined && y > initialMiddleY + 4;
      },
      "top-edge wheel overscroll",
    );
    const topWheelSettled = await waitFrame(
      page,
      (frame) => {
        const y = markerYOrUndefined(frame, "SCROLL_MIDDLE");
        return frame.frame! > topWheelPeak.frame! && y !== undefined && Math.abs(y - initialMiddleY) < 0.01;
      },
      "top-edge wheel spring settle",
    );
    assert.ok(topWheelSettled.frame! > topWheelPeak.frame!, "wheel edge spring must emit a later native frame");

    // Simulate a macOS two-finger trackpad swipe near the bottom canvas edge
    // with horizontal wobble and a long fractional momentum tail. It must not
    // oscillate backward across re-anchors or keep forwarding sub-pixel tail
    // noise after the gesture has already decayed.
    const macTrackpadStart = requests.length;
    const macSamples = await page.evaluate(async () => {
      const canvas = document.querySelector("canvas")!;
      const sampledY: number[] = [];
      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === "preview.frame" && event.data?.frame?.ops) {
          const op = event.data.frame.ops.find((candidate: any) => candidate.type === "text" && candidate.text === "SCROLL_MIDDLE");
          if (typeof op?.y === "number") sampledY.push(op.y);
        }
      };
      window.addEventListener("message", onMessage);
      const deltas: Array<[number, number]> = [
        [1.2, -12], [2.1, -28], [-1.5, -48], [0.8, -62], [-2.0, -58], [1.1, -46], [-0.9, -38], [0.5, -32],
        [0.4, -28], [-0.3, -25], [0.5, -22], [0.2, -19], [-0.4, -17], [0.3, -15], [0.1, -13], [-0.2, -11.5],
        [0.2, -10], [-0.1, -8.8], [0.1, -7.7], [0.2, -6.8], [-0.1, -6.0], [0.1, -5.2], [0.0, -4.5], [-0.1, -3.9],
        [0.1, -3.4], [0.0, -2.9], [-0.1, -2.5], [0.1, -2.1], [0.0, -1.8], [0.0, -1.5], [-0.1, -1.3], [0.0, -1.1],
        [0.0, -0.9], [0.0, -0.8], [0.0, -0.6], [0.0, -0.5], [0.0, -0.4], [0.0, -0.3], [0.0, -0.2], [0.0, -0.1],
      ];
      for (const [dx, dy] of deltas) {
        canvas.dispatchEvent(new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaX: dx,
          deltaY: dy,
          clientX: 195,
          clientY: 320,
        }));
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 16));
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 380));
      window.removeEventListener("message", onMessage);
      return sampledY;
    });
    await waitForQuiet(() => requests.length, "macOS trackpad momentum queue");
    const macPackets = requests.slice(macTrackpadStart).filter((packet) => packet.type === "pointer") as Array<Record<string, any>>;
    assert.ok(macPackets.length >= 4 && macPackets.length <= 16, `macOS momentum tail should cut off without flooding input (${macPackets.length} packets)`);
    assert.ok(macPackets.every((packet) => packet.x === 195), "dominant-axis lock must ignore horizontal trackpad wobble during vertical scroll");
    assert.ok(macSamples.length >= 4, "macOS trackpad gesture must emit guest frames");
    const peakIndex = macSamples.indexOf(Math.max(...macSamples));
    for (let i = 1; i <= peakIndex; i += 1) {
      assert.ok(macSamples[i]! >= macSamples[i - 1]! - 0.01, `overscroll must not snap backward during re-anchor (${macSamples.join(", ")})`);
    }
    for (let i = peakIndex + 1; i < macSamples.length; i += 1) {
      assert.ok(macSamples[i]! <= macSamples[i - 1]! + 0.01, `overscroll spring return must not oscillate (${macSamples.join(", ")})`);
    }
    const macSettled = await waitFrame(
      page,
      (frame) => {
        const y = markerYOrUndefined(frame, "SCROLL_MIDDLE");
        return frame.frame! > topWheelSettled.frame! && y !== undefined && Math.abs(y - initialMiddleY) < 0.01;
      },
      "macOS trackpad spring settle",
    );

    const inBoundsWheelStart = requests.length;
    await dispatchWheelBurst([48, 32, 16, 8, 4], "in-bounds wheel decay tail");
    const inBoundsWheelPackets = requests.slice(inBoundsWheelStart).filter((packet) => packet.type === "pointer") as Array<Record<string, any>>;
    assert.equal(inBoundsWheelPackets.filter((packet) => packet.phase === "down").length, 1, "in-bounds wheel burst must send one DOWN");
    assert.ok(inBoundsWheelPackets.filter((packet) => packet.phase === "move").length >= 1, "in-bounds wheel burst must send a MOVE");
    assert.equal(inBoundsWheelPackets.filter((packet) => packet.phase === "cancel").length, 1, "in-bounds wheel silence must send one CANCEL");
    assert.equal(inBoundsWheelPackets.filter((packet) => packet.phase === "up").length, 0, "in-bounds wheel burst must not send UP");
    const inBoundsAfterCancel = await waitFrame(
      page,
      (frame) => frame.frame! > macSettled.frame! && markerYOrUndefined(frame, "SCROLL_ROW_3") !== undefined,
      "in-bounds wheel final frame",
    );
    const inBoundsY = markerY(inBoundsAfterCancel, "SCROLL_ROW_3");
    assert.equal(inBoundsY, markerY(macSettled, "SCROLL_ROW_3") - 108, "wheel decay deltas must accumulate into actual guest displacement");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
    const inBoundsQuiet = await readFrame();
    assert.equal(markerY(inBoundsQuiet, "SCROLL_ROW_3"), inBoundsY, "wheel CANCEL must stop at the last in-bounds input position without a second fling");

    // Pull past the top edge. The marker must visibly overshoot first, then
    // return to the legal offset after input stops (real JS rubber + spring).
    const topBeforeRequests = requests.length;
    await page.mouse.move(point(195, 120).x, point(195, 120).y);
    await page.mouse.down();
    await page.mouse.move(point(195, 305).x, point(195, 305).y, { steps: 8 });
    await page.mouse.up();
    const topPeak = await waitFrame(
      page,
      (frame) => {
        const y = markerYOrUndefined(frame, "SCROLL_MIDDLE");
        return y !== undefined && y > initialMiddleY + 4;
      },
      "top-edge overscroll",
    );
    const topInputCount = await waitForInputDrain(topBeforeRequests, "top-edge");
    assert.ok(topInputCount > topBeforeRequests, "top-edge drag must travel through browser HTTP input");
    const topSettled = await waitFrame(
      page,
      (frame) => {
        const y = markerYOrUndefined(frame, "SCROLL_MIDDLE");
        return frame.frame! > topPeak.frame! && y !== undefined && Math.abs(y - initialMiddleY) < 0.01;
      },
      "top-edge spring settle",
    );
    assert.ok(topSettled.frame! > topPeak.frame!, "top spring must emit a later native frame");

    // A quick in-bounds drag must keep moving after UP with no further input
    // packets. This is the real gesture velocity -> JS fling -> frame path.
    const flingBeforeRequests = requests.length;
    await page.mouse.move(point(195, 270).x, point(195, 270).y);
    await page.mouse.down();
    // Spread the real contact over guest frames. Playwright's `steps` sends
    // protocol events as fast as possible; on a fast run the entire drag can
    // share one guest tick and supplies no elapsed time for fling velocity.
    for (let step = 1; step <= 7; step += 1) {
      const next = point(195, 270 - 70 * step / 7);
      await page.mouse.move(next.x, next.y);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await waitForInputDrain(flingBeforeRequests, "fling");
    const releaseFrame = await waitFrame(page, (frame) => frame.frame! > topSettled.frame!, "post-release frame");
    const releaseInertiaY = markerY(releaseFrame, "SCROLL_ROW_3");
    const releaseRequestCount = requests.length;
    const movingFrame = await waitFrame(
      page,
      (frame) => {
        const y = markerYOrUndefined(frame, "SCROLL_ROW_3");
        return frame.frame! > releaseFrame.frame! && y !== undefined && Math.abs(y - releaseInertiaY) > 0.5;
      },
      "inertial frame after pointer up",
    );
    assert.equal(requests.length, releaseRequestCount, "inertia must continue without new browser input packets");
    assert.ok(movingFrame.frame! > releaseFrame.frame!, "fling must advance native frames after release");
    assert.ok(requests.slice(flingBeforeRequests).some((packet) => packet.type === "pointer" && packet.phase === "up"), "fling gesture must include a pointer UP");

    // Keep issuing real drags until the long fixture reaches its legal bottom.
    // Each gesture begins on the canvas and is serialized by the browser client.
    for (let gesture = 0; gesture < 8; gesture += 1) {
      const gestureRequests = requests.length;
      await page.mouse.move(point(195, 300).x, point(195, 300).y);
      await page.mouse.down();
      await page.mouse.move(point(195, 40).x, point(195, 40).y, { steps: 8 });
      await page.mouse.up();
      await waitForInputDrain(gestureRequests, `bottom travel gesture ${gesture + 1}`);
      const current = await readFrame();
      const currentBottomY = markerYOrUndefined(current, "SCROLL_BOTTOM");
      if (currentBottomY !== undefined && currentBottomY < 340) break;
    }
    const bottomLegal = await waitForStableMarker(
      page,
      "SCROLL_BOTTOM",
      (y) => y > 250 && y < 360,
      "legal bottom scroll position",
    );
    const bottomLegalY = markerY(bottomLegal, "SCROLL_BOTTOM");
    assert.ok(bottomLegalY > 250, `bottom marker must be reachable near the viewport tail: y=${bottomLegalY}`);

    // Push past the bottom edge and verify a positive rubber displacement
    // before the same marker returns to the legal bottom position.
    const bottomRequestStart = requests.length;
    await page.mouse.move(point(195, 270).x, point(195, 270).y);
    await page.mouse.down();
    await page.mouse.move(point(195, 20).x, point(195, 20).y, { steps: 10 });
    await page.mouse.up();
    const bottomPeak = await waitFrame(page, (frame) => markerY(frame, "SCROLL_BOTTOM") < bottomLegalY - 4, "bottom-edge overscroll");
    const bottomRequestCount = await waitForInputDrain(bottomRequestStart, "bottom-edge");
    const bottomSamples: string[] = [];
    let bottomSettled: Frame;
    try {
      bottomSettled = await waitFrame(
        page,
        (frame) => {
          const y = markerYOrUndefined(frame, "SCROLL_BOTTOM");
          if (bottomSamples.length < 12) bottomSamples.push(`${frame.frame}:${String(y)}`);
          return frame.frame! > bottomPeak.frame! && y !== undefined && Math.abs(y - bottomLegalY) < 0.01;
        },
        "bottom-edge spring settle",
      );
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; bottom legal=${bottomLegalY}, peak=${bottomPeak.frame}:${markerY(bottomPeak, "SCROLL_BOTTOM")}, samples=${bottomSamples.join(",")}`);
    }
    assert.equal(requests.length, bottomRequestCount, "bottom spring must settle without new browser input packets");
    assert.ok(bottomSettled.frame! > bottomPeak.frame!, "bottom spring must emit a later native frame");

    assert.ok(requests.some((packet) => packet.type === "pointer" && packet.phase === "down"), "browser drag must send pointer DOWN");
    assert.ok(requests.some((packet) => packet.type === "pointer" && packet.phase === "up"), "browser drag must send pointer UP");
    assert.deepEqual(responseErrors, [], `preview input requests failed: ${responseErrors.join(", ")}`);
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join("; ")}`);
    console.log(JSON.stringify({
      acceptance: "preview-scroll",
      initialMiddleY,
      topPeakY: markerY(topPeak, "SCROLL_MIDDLE"),
      topSettledY: markerY(topSettled, "SCROLL_MIDDLE"),
      releaseInertiaY,
      movingInertiaY: markerY(movingFrame, "SCROLL_ROW_3"),
      bottomLegalY,
      bottomPeakY: markerY(bottomPeak, "SCROLL_BOTTOM"),
      bottomSettledY: markerY(bottomSettled, "SCROLL_BOTTOM"),
      wheelDisplacement: markerY(topWheelSettled, "SCROLL_ROW_3") - inBoundsY,
      wheelRestY: markerY(inBoundsQuiet, "SCROLL_ROW_3"),
      inputPackets: requests.length,
    }));
  } finally {
    await browser?.close();
    server?.stop(true);
    await manager?.dispose();
    rmSync(output, { recursive: true, force: true });
  }
}, 60_000);
