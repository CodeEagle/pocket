/*
 * Browser acceptance setup:
 *   bun install
 *   bunx playwright install chromium
 *   bun test editor/test/preview_pointer.test.ts --timeout 60000
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("browser preview keeps pointer contacts ordered across multi-pointer, wheel, and lost-capture input", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for browser pointer acceptance: ${probe}`);
  if (playwrightOverride) assert.ok(existsSync(playwrightOverride), `POCKET_PLAYWRIGHT does not exist: ${playwrightOverride}`);
  const { chromium } = playwrightOverride
    ? await import(pathToFileURL(playwrightOverride).href)
    : await import("playwright");
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-pointer-build-"));
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
  const projectId = "scroll-pointer";
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
  const page = await browser.newPage({ viewport: { width: 390, height: 520 } });
  const requests: Array<Record<string, unknown>> = [];
  const responseErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/input")) return;
    const body = request.postData();
    if (body) requests.push(JSON.parse(body) as Record<string, unknown>);
  });
  page.on("response", (response) => {
    if (response.request().method() === "POST" && response.url().endsWith("/input") && !response.ok()) {
      responseErrors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let failNextDown = false;
  let failNextNativeMove = false;
  const nativeMoveResponses: number[] = [];
  await page.route("**/input", async (route) => {
    const body = route.request().postData();
    const payload = body ? JSON.parse(body) as Record<string, any> : undefined;
    if (failNextDown && payload?.type === "pointer" && payload.phase === "down") {
      failNextDown = false;
      await route.fulfill({ status: 400, contentType: "text/plain", body: "simulated pointer down failure" });
      return;
    }
    if (failNextNativeMove && payload?.type === "pointer" && payload.phase === "move") {
      failNextNativeMove = false;
      // Execute the real preview route first, then replace only the browser
      // response. The native contact was accepted even though the client sees
      // a transport failure.
      const response = await route.fetch();
      nativeMoveResponses.push(response.status());
      await route.fulfill({ response, status: 503, contentType: "text/plain", body: "simulated post-native MOVE failure" });
      return;
    }
    await route.continue();
  });

  try {
    // Use the checked-in browser client through the real native preview HTTP
    // routes. This is intentionally not a source-shape assertion or a fake
    // fetch: the independently built public SDK guest receives the generated
    // pointer frames.
    const pageResponse = await page.goto(`http://127.0.0.1:${server.port}${prefix}`);
    assert.equal(pageResponse?.status(), 200);
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame()), undefined, { timeout: 30_000 });
    assert.equal(await page.locator("canvas").count(), 1);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    assert.ok(box, "preview canvas must have a browser layout box");
    const point = (x: number, y: number) => ({ x: box!.x + x, y: box!.y + y });

    // Regression for the production error: a mouse may go DOWN on the editor
    // chrome below/outside the canvas, then move into the canvas while its
    // buttons bit is still set. No canvas DOWN means no native contact, so the
    // browser client must ignore the move and subsequent UP entirely.
    const beforeOutsideDown = requests.length;
    await page.mouse.move(195, 900);
    await page.mouse.down();
    await page.mouse.move(point(195, 200).x, point(195, 200).y);
    await page.mouse.up();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(requests.length, beforeOutsideDown, "outside-canvas mouse down must not emit an unknown-contact move");

    // A real Playwright mouse stream emits browser pointer events. Hover moves
    // before DOWN must not reach native input, while the captured drag must be
    // one ordered contact even though fetches resolve asynchronously.
    const beforeMouse = requests.length;
    await page.mouse.move(point(150, 300).x, point(150, 300).y);
    await page.mouse.down();
    await page.mouse.move(point(160, 305).x, point(160, 305).y, { steps: 3 });
    await page.mouse.up();
    await waitFor(() => requests.length, (length) => length >= beforeMouse + 3, "mouse down/move/up requests");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const mousePackets = requests.slice(beforeMouse).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.ok(mousePackets.length >= 3, "a captured drag must retain DOWN, at least one MOVE, and UP");
    assert.equal(mousePackets[0].phase, "down");
    assert.equal(mousePackets.at(-1)?.phase, "up");
    assert.ok(mousePackets.slice(1, -1).every((value) => value.phase === "move"), "coalesced drag packets may only contain MOVE between DOWN and UP");
    assert.ok(mousePackets.every((value) => value.id === mousePackets[0].id), "one browser contact must retain one native slot");

    // If DOWN itself fails, the client emits an idempotent CANCEL cleanup;
    // moves/UP already queued behind it must still be discarded rather than
    // turning into the reported unknown-contact error. A later fresh click
    // must still be able to reuse the released slot.
    const beforeFailedDown = requests.length;
    failNextDown = true;
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const emit = (type: string) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 88,
        pointerType: "touch",
        clientX: 120,
        clientY: 220,
        buttons: type === "pointerup" ? 0 : 1,
      }));
      emit("pointerdown");
      emit("pointermove");
      emit("pointerup");
    });
    await waitFor(() => requests.length, (length) => length >= beforeFailedDown + 1, "failed pointer down request");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const failedPackets = requests.slice(beforeFailedDown).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(failedPackets.map((value) => value.phase), ["down", "cancel"]);
    const beforeRecovery = requests.length;
    await page.mouse.click(point(170, 310).x, point(170, 310).y);
    await waitFor(() => requests.length, (length) => length >= beforeRecovery + 2, "post-failure pointer recovery");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const recoveryPackets = requests.slice(beforeRecovery).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(recoveryPackets.map((value) => value.phase), ["down", "up"]);

    // Interleave two browser contacts and a wheel gesture. Wheel owns a
    // reserved native slot and stays active across the burst; its silence
    // timeout sends one CANCEL rather than one UP per delta. It must not steal
    // either active contact or send a move after its terminal edge.
    const beforeMixed = requests.length;
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const emit = (type: string, pointerId: number, clientX: number, clientY: number) => {
        canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          pointerId,
          pointerType: "touch",
          clientX,
          clientY,
          buttons: type === "pointerup" ? 0 : 1,
        }));
      };
      emit("pointerdown", 41, 40, 120);
      emit("pointerdown", 42, 80, 140);
      emit("pointermove", 41, 50, 125);
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 24, clientX: 120, clientY: 180 }));
      emit("pointermove", 42, 90, 145);
      emit("pointerup", 41, 50, 125);
      emit("pointerup", 42, 90, 145);
    });
    await waitFor(
      () => requests.slice(beforeMixed),
      (packets) => packets.filter((value) => value.type === "pointer" && (value.phase === "up" || value.phase === "cancel")).length >= 3,
      "multi-pointer and wheel terminal requests",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const mixed = requests.slice(beforeMixed).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    const mixedById = new Map<number, string[]>();
    for (const packet of mixed) {
      const phases = mixedById.get(packet.id) ?? [];
      phases.push(packet.phase);
      mixedById.set(packet.id, phases);
    }
    const mixedSequences = [...mixedById.values()];
    assert.equal(mixedSequences.length, 3, "two browser contacts plus one wheel contact must use three native ids");
    assert.equal(mixedSequences.filter((sequence) => sequence.at(-1) === "up").length, 2, "browser contacts must retain their UP terminals");
    assert.equal(mixedSequences.filter((sequence) => sequence.at(-1) === "cancel").length, 1, "wheel contact must use a CANCEL terminal");
    assert.ok(mixedSequences.every((sequence) => sequence[0] === "down" && sequence[1] === "move"), "every mixed contact must retain DOWN then MOVE ordering");
    assert.ok(mixedSequences.filter((sequence) => sequence.at(-1) === "cancel")[0]!.every((phase) => ["down", "move", "cancel"].includes(phase)), "wheel contact must contain no UP or post-terminal MOVE");

    // A lost capture is terminal for that browser contact. The later UP is a
    // browser cleanup edge and must not become an unknown native MOVE/UP.
    const beforeLost = requests.length;
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const event = (type: string) => new PointerEvent(type, {
        bubbles: true,
        pointerId: 77,
        pointerType: "touch",
        clientX: 200,
        clientY: 300,
        buttons: type === "pointerup" ? 0 : 1,
      });
      canvas.dispatchEvent(event("pointerdown"));
      canvas.dispatchEvent(event("lostpointercapture"));
      canvas.dispatchEvent(event("pointerup"));
    });
    await waitFor(() => requests.length, (length) => length >= beforeLost + 2, "lost capture cancellation");
    const lost = requests.slice(beforeLost).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(lost.map((value) => value.phase), ["down", "cancel"]);

    // A MOVE can reach native successfully while its HTTP response is lost
    // after transport. The queued UP must not be dropped without first
    // cancelling the native contact, otherwise its slot remains active and
    // the next browser click reports an "already active" native error.
    const beforeNativeMoveFailure = requests.length;
    failNextNativeMove = true;
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      const emit = (type: string, clientX: number, clientY: number) => canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 99,
        pointerType: "touch",
        clientX,
        clientY,
        buttons: type === "pointerup" ? 0 : 1,
      }));
      emit("pointerdown", 120, 220);
      emit("pointermove", 130, 230);
      emit("pointerup", 130, 230);
    });
    await waitFor(
      () => requests.length,
      (length) => length >= beforeNativeMoveFailure + 2,
      "post-native MOVE failure request",
    );
    await waitFor(
      () => requests.slice(beforeNativeMoveFailure),
      (packets) => packets.some((value) => value.type === "pointer" && value.phase === "cancel"),
      "post-native MOVE failure cancellation",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const nativeMoveFailurePackets = requests.slice(beforeNativeMoveFailure).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.equal(nativeMoveResponses.at(-1), 200, "the injected MOVE response must come from a real native success");
    assert.deepEqual(nativeMoveFailurePackets.map((value) => value.phase), ["down", "move", "cancel"]);
    const beforeRecoveryAfterNativeFailure = requests.length;
    const responseErrorsBeforeRecovery = responseErrors.length;
    await page.mouse.click(point(175, 310).x, point(175, 310).y);
    await waitFor(
      () => requests.length,
      (length) => length >= beforeRecoveryAfterNativeFailure + 2,
      "post-native failure pointer recovery",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const recoveryAfterNativeFailure = requests.slice(beforeRecoveryAfterNativeFailure).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(recoveryAfterNativeFailure.map((value) => value.phase), ["down", "up"]);
    assert.equal(responseErrors.length, responseErrorsBeforeRecovery, "a fresh click must not report an active native contact");

    // Losing browser focus while a native contact is still down must emit a
    // CANCEL before the next contact can reuse the slot.
    const beforeBlur = requests.length;
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 101,
        pointerType: "touch",
        clientX: 120,
        clientY: 220,
        buttons: 1,
      }));
    });
    await waitFor(() => requests.length, (length) => length >= beforeBlur + 1, "blur contact DOWN");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await waitFor(
      () => requests.slice(beforeBlur),
      (packets) => packets.some((value) => value.type === "pointer" && value.phase === "cancel"),
      "blur contact cancellation",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const blurPackets = requests.slice(beforeBlur).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(blurPackets.map((value) => value.phase), ["down", "cancel"]);
    const responseErrorsBeforeBlurRecovery = responseErrors.length;
    const beforeBlurRecovery = requests.length;
    await page.mouse.click(point(175, 310).x, point(175, 310).y);
    await waitFor(() => requests.length, (length) => length >= beforeBlurRecovery + 2, "post-blur pointer recovery");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const blurRecoveryPackets = requests.slice(beforeBlurRecovery).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(blurRecoveryPackets.map((value) => value.phase), ["down", "up"]);
    assert.equal(responseErrors.length, responseErrorsBeforeBlurRecovery, "post-blur click must not report an active native contact");

    // Closing the preview with a pending contact must perform the same native
    // cleanup before the next page generation is allowed to reuse slot zero.
    const beforeClose = requests.length;
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas")!;
      canvas.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 102,
        pointerType: "touch",
        clientX: 120,
        clientY: 220,
        buttons: 1,
      }));
    });
    await waitFor(() => requests.length, (length) => length >= beforeClose + 1, "close contact DOWN");
    const closePromise = page.evaluate(async () => {
      await (globalThis as any).PocketEditorPreviewInstance.close();
    });
    await waitFor(
      () => requests.slice(beforeClose),
      (packets) => packets.some((value) => value.type === "pointer" && value.phase === "cancel"),
      "close contact cancellation",
    );
    await closePromise;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const closePackets = requests.slice(beforeClose).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(closePackets.map((value) => value.phase), ["down", "cancel"]);
    const responseErrorsBeforeCloseRecovery = responseErrors.length;
    await page.reload();
    await page.waitForFunction(() => Boolean((window as any).PocketEditorPreviewInstance?.getFrame()), undefined, { timeout: 30_000 });
    const reloadedBox = await canvas.boundingBox();
    assert.ok(reloadedBox, "reloaded preview canvas must have a browser layout box");
    const beforeCloseRecovery = requests.length;
    await page.mouse.click(reloadedBox!.x + 175, reloadedBox!.y + 310);
    await waitFor(() => requests.length, (length) => length >= beforeCloseRecovery + 2, "post-close pointer recovery");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    const closeRecoveryPackets = requests.slice(beforeCloseRecovery).filter((value) => value.type === "pointer") as Array<Record<string, any>>;
    assert.deepEqual(closeRecoveryPackets.map((value) => value.phase), ["down", "up"]);
    assert.equal(responseErrors.length, responseErrorsBeforeCloseRecovery, "post-close click must not report an active native contact");

    assert.equal(responseErrors.length, 2, `unexpected native input failures: ${responseErrors.join(", ")}`);
    assert.ok(responseErrors.some((value) => /400/.test(value)), `missing pre-native failure response: ${responseErrors.join(", ")}`);
    assert.ok(responseErrors.some((value) => /503/.test(value)), `missing post-native failure response: ${responseErrors.join(", ")}`);
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    server.stop(true);
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});
