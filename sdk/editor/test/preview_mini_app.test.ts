import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager, type PreviewArtifactPaths, type PreviewFrame } from "../preview.ts";

const repositoryRoot = resolve(import.meta.dir, "../..", "..");
const sdkRoot = join(repositoryRoot, "sdk");
const demoRoot = join(repositoryRoot, "demo/js");
const profileRoot = join(demoRoot, "apps/profile");
const lobbyRoot = join(demoRoot, "apps/lobby");
const profileAppId = "pocket.demo.profile";
const lobbyAppId = "pocket.demo.lobby";
const probeCandidates = process.env.POCKET_NATIVE_PROBE
  ? [resolve(process.env.POCKET_NATIVE_PROBE)]
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ];
const probe = probeCandidates.find(existsSync);

type Snapshot = {
  status: Record<string, any>;
  frame: PreviewFrame;
};

function bodyJson(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

function childTitle(appId: string): string {
  if (appId === profileAppId) return "Pocket Profile";
  if (appId === lobbyAppId) return "Pocket Lobby";
  return appId;
}

function childTextY(snapshot: Snapshot, appId: string): number | undefined {
  const title = childTitle(appId);
  const op = snapshot.frame.ops.find((value) => value.type === "text" && value.text === title);
  const y = op?.y;
  return typeof y === "number" && Number.isFinite(y) ? y : undefined;
}

/** Child DrawOps remain flattened while a presentation is animating. The
 * focused slot is intentionally not used as the visual-presence gate: the
 * adapter only exposes inputBounds once the child is focused and has a frame. */
function hasChild(snapshot: Snapshot, appId: string): boolean {
  return childTextY(snapshot, appId) !== undefined;
}

function textOp(snapshot: Snapshot, text: string): Record<string, unknown> {
  const op = snapshot.frame.ops.find((value) => value.type === "text" && value.text === text);
  assert.ok(op, `preview frame is missing text ${JSON.stringify(text)}`);
  return op;
}

function centerOf(snapshot: Snapshot, text: string): { x: number; y: number } {
  const op = textOp(snapshot, text);
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.equal(typeof op[key], "number", `${text} DrawOp.${key} must be numeric`);
  }
  return {
    x: Number(op.x) + Number(op.w) / 2,
    y: Number(op.y) + Number(op.h) / 2,
  };
}

function closeIconOps(snapshot: Snapshot) {
  const top = 64;
  return snapshot.frame.ops.filter(op =>
    (op.type === "rect" || op.type === "image") && Number(op.color) === 0xff17233b &&
    Number(op.x) > snapshot.frame.width - 80 && Number(op.y) >= 0 &&
    Number(op.y) + Number(op.h) <= top && Number(op.w) > 0 && Number(op.h) > 0);
}

function closeCenter(snapshot: Snapshot): { x: number; y: number } {
  const ops = closeIconOps(snapshot);
  assert.ok(ops.length, "top-right circular close icon must be rendered");
  const left = Math.min(...ops.map(op => Number(op.x)));
  const right = Math.max(...ops.map(op => Number(op.x) + Number(op.w)));
  const top = Math.min(...ops.map(op => Number(op.y)));
  const bottom = Math.max(...ops.map(op => Number(op.y) + Number(op.h)));
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

function closePaintBounds(ops: Record<string, any>[]) {
  assert.ok(ops.length, "close shape has native paint operations");
  const x = Math.min(...ops.map(op => Number(op.x)));
  const y = Math.min(...ops.map(op => Number(op.y)));
  const right = Math.max(...ops.map(op => Number(op.x) + Number(op.w)));
  const bottom = Math.max(...ops.map(op => Number(op.y) + Number(op.h)));
  return { x, y, width: right - x, height: bottom - y, cx: (x + right) / 2, cy: (y + bottom) / 2 };
}

function assertCloseGeometry(value: Snapshot): void {
  // Native round fills are four corner mask DrawOps; inspect their combined
  // bounds instead of assuming a circle is one rectangle in FrameResult.
  const icons = closeIconOps(value);
  const childTitleIndex = value.frame.ops.findIndex(op => op.type === "text" && op.text === "Pocket Profile");
  assert.ok(value.frame.ops.indexOf(icons[0]!) > childTitleIndex, "floating close control paints after the child content");
  const ring = closePaintBounds(icons.filter(op => Number(op.w) > 4 && Number(op.h) > 4));
  const dot = closePaintBounds(icons.filter(op => Number(op.w) <= 4 && Number(op.h) <= 4));
  assert.ok(ring.width >= 12, "close ring remains legible");
  assert.equal(ring.height, ring.width, "close ring is circular");
  assert.ok(dot.width > 0 && dot.width < ring.width, "close dot fits inside the ring");
  assert.equal(dot.height, dot.width, "close dot is circular");
  assert.equal(ring.cx, dot.cx, "close ring and dot share x center");
  assert.equal(ring.cy, dot.cy, "close ring and dot share y center");
  const backing = closePaintBounds(value.frame.ops.filter(op =>
    [0xfff5f6f7, 0xffeef0f4, 0xffd6dce7].includes(Number(op.color)) && Number(op.x) > value.frame.width - 80 &&
    Number(op.y) >= 0 && Number(op.y) + Number(op.h) <= 64));
  assert.ok(backing.width >= 30, "close backing has a useful diameter");
  assert.equal(backing.width, backing.height, "close backing is circular");
  assert.equal(backing.cx, ring.cx, "backing and icon share x center");
  assert.equal(backing.cy, ring.cy, "backing and icon share y center");
}

async function sampleUntil(
  read: () => Promise<Snapshot>,
  predicate: (snapshot: Snapshot) => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<{ value: Snapshot; frames: Snapshot[] }> {
  const deadline = Date.now() + timeoutMs;
  const frames: Snapshot[] = [];
  let lastFrame = -1;
  while (Date.now() < deadline) {
    const value = await read();
    if (value.frame.frame !== lastFrame) {
      frames.push(value);
      lastFrame = value.frame.frame;
    }
    if (predicate(value)) return { value, frames };
    await Bun.sleep(16);
  }
  throw new Error(`timed out waiting for ${label}; last frame=${String(frames.at(-1)?.frame.frame)}`);
}

async function sampleSettledChild(
  read: () => Promise<Snapshot>,
  appId: string,
  label: string,
): Promise<{ value: Snapshot; frames: Snapshot[] }> {
  const deadline = Date.now() + 5_000;
  const frames: Snapshot[] = [];
  let lastFrame = -1;
  let lastY: number | undefined;
  let stableFrames = 0;
  while (Date.now() < deadline) {
    const value = await read();
    if (value.frame.frame !== lastFrame) {
      lastFrame = value.frame.frame;
      frames.push(value);
    }
    if (hasChild(value, appId)) {
      const y = childTextY(value, appId);
      if (y !== undefined && lastY !== undefined && Math.abs(y - lastY) < 0.5) stableFrames += 1;
      else stableFrames = 0;
      if (y !== undefined) lastY = y;
      // inputBounds is an input-routing fact, not a visual-presence fact. It
      // is required only after the child text has reached a settled position.
      if (stableFrames >= 4 && y !== undefined && y >= 0 && y < 80 && value.frame.inputBounds !== undefined) return { value, frames };
    } else {
      stableFrames = 0;
      lastY = undefined;
    }
    await Bun.sleep(16);
  }
  const last = await read();
  throw new Error(`timed out waiting for settled ${label}: ${JSON.stringify({ status: last.status, inputBounds: last.frame.inputBounds, text: last.frame.ops.filter(op => op.type === "text").slice(0, 12).map(op => ({ text: op.text, x: op.x, y: op.y, clip: op.clip })) })}`);
}

async function sampleChildClosing(
  read: () => Promise<Snapshot>,
  appId: string,
): Promise<{ value: Snapshot; frames: Snapshot[] }> {
  return sampleUntil(read, (snapshot) => !hasChild(snapshot, appId), `${appId} close`);
}

function assertOpeningAnimation(frames: Snapshot[], appId: string): void {
  const ys = frames.map((snapshot) => childTextY(snapshot, appId))
    .filter((value): value is number => value !== undefined);
  assert.ok(ys.length >= 2, `${appId} opening must expose intermediate child text frames`);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 4, `${appId} opening y did not move: ${ys.join(", ")}`);
  assert.ok(ys[0]! > ys.at(-1)! + 4, `${appId} opening must move upward: ${ys.join(" -> ")}`);
  const finalY = ys.at(-1)!;
  assert.ok(finalY >= 0 && finalY < 80, `${appId} full-screen content must start at the viewport top: ${finalY}`);
}

function assertClosingAnimation(frames: Snapshot[], appId: string): void {
  const ys = frames.map((snapshot) => childTextY(snapshot, appId))
    .filter((value): value is number => value !== undefined);
  assert.ok(ys.length >= 2, `${appId} closing must expose intermediate child text frames`);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 4, `${appId} close y did not move: ${ys.join(", ")}`);
  assert.ok(ys.at(-1)! > ys[0]! + 4, `${appId} closing must move downward: ${ys.join(" -> ")}`);
}

function assertNoPreviewError(snapshot: Snapshot, label: string): void {
  assert.equal(snapshot.status.state, "ready", `${label} entered ${String(snapshot.status.state)}`);
  assert.equal(snapshot.status.error, undefined, `${label} reported ${String(snapshot.status.error)}`);
}

test("mini-app surfaces rise from the bottom and close through SystemUI cancellation", { timeout: 180_000 }, async () => {
  assert.ok(probe, `pocket_probe is required for mini-app animation acceptance: ${probeCandidates.join(", ")}`);
  const outputRoot = mkdtempSync(join(tmpdir(), "pocket-preview-mini-app-root-"));
  const outputProfile = mkdtempSync(join(tmpdir(), "pocket-preview-mini-app-profile-"));
  const outputLobby = mkdtempSync(join(tmpdir(), "pocket-preview-mini-app-lobby-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    // buildGuest materializes @pocket/ui at each consumer's package boundary;
    // keep these builds ordered so parallel acceptance runs cannot contend on
    // the per-project preparation lock.
    const root = await buildGuest({ projectRoot: demoRoot, outDir: outputRoot, tickHz: 60 });
    const profile = await buildGuest({ projectRoot: profileRoot, outDir: outputProfile, tickHz: 60 });
    const lobby = await buildGuest({ projectRoot: lobbyRoot, outDir: outputLobby, tickHz: 60 });
    const applications: Record<string, PreviewArtifactPaths> = {
      [profileAppId]: { bytecodePath: profile.bytecode, pakPath: profile.pak, appId: profileAppId },
      [lobbyAppId]: { bytecodePath: lobby.bytecode, pakPath: lobby.pak, appId: lobbyAppId },
    };
    manager = createPreviewManager({
      probePath: probe,
      projectDirectory: demoRoot,
      width: 390,
      height: 844,
      idleDisposeMs: 1_000,
      artifacts: {
        bytecodePath: root.bytecode,
        pakPath: root.pak,
        revision: 1,
        tickHz: 60,
        compositorSurfaces: { [profileAppId]: 2, [lobbyAppId]: 3 },
        applications,
      },
    });
    const prefix = "http://127.0.0.1/api/projects/pocket-host-showcase/preview";
    const snapshot = async (): Promise<Snapshot> => bodyJson(await manager!.handle(
      new Request(`${prefix}/snapshot`),
      "pocket-host-showcase",
      "snapshot",
    )) as Promise<Snapshot>;
    const pointer = async (id: number, point: { x: number; y: number }): Promise<void> => {
      for (const phase of ["down", "up"] as const) {
        const response = await manager!.handle(new Request(`${prefix}/input`, {
          method: "POST",
          body: JSON.stringify({ type: "pointer", phase, id, x: point.x, y: point.y }),
        }), "pocket-host-showcase", "input");
        assert.equal(response.status, 200, `${phase} pointer failed with ${response.status}`);
      }
    };

    const stream = await manager.handle(new Request(`${prefix}/stream`), "pocket-host-showcase", "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    let value = (await sampleUntil(snapshot, (next) =>
      next.status.state === "ready" && next.status.error === undefined &&
      next.frame.ops.some((op) => op.type === "text" && op.text === "Open profile app"),
    "Showcase open action")).value;
    await pointer(0, centerOf(value, "Open profile app"));
    let opened = await sampleSettledChild(snapshot, profileAppId, "Profile opening");
    assertNoPreviewError(opened.value, "Profile opening");
    assertOpeningAnimation(opened.frames, profileAppId);
    assertCloseGeometry(opened.value);
    const profileClose = closeCenter(opened.value);
    assert.deepEqual(opened.value.frame.inputBounds, { x: 0, y: 0, w: 390, h: 844 }, "child fills the logical viewport under the floating control");
    assert.ok(profileClose.y < 64, "close control floats over the top-right content");
    // Persistence regression: once the sheet has settled, leave it idle for
    // at least six seconds before pressing the top-right close control. The
    // parent SystemUI is quiescent during this interval; closing must still
    // wake the visible child and publish its animation without any extra
    // input/polling edge. sampleChildClosing below records every native frame
    // until the child disappears and asserts that at least two intermediate
    // positions were emitted.
    const idleOpenedAt = Date.now();
    await Bun.sleep(6_000);
    assert.ok(Date.now() - idleOpenedAt >= 6_000, "settled mini-app must remain open for at least six seconds before close");
    const down = await manager.handle(new Request(`${prefix}/input`, {
      method: "POST", body: JSON.stringify({ type: "pointer", phase: "down", id: 1, ...profileClose }),
    }), "pocket-host-showcase", "input");
    assert.equal(down.status, 200);
    const held = (await sampleUntil(snapshot, next => next.frame.ops.some(op =>
      Number(op.color) === 0xffdce2eb && Number(op.x) > next.frame.width - 80 && Number(op.y) < 56), "close Button pressed feedback")).value;
    assert.ok(hasChild(held, profileAppId), "holding Button must not close before release");
    const up = await manager.handle(new Request(`${prefix}/input`, {
      method: "POST", body: JSON.stringify({ type: "pointer", phase: "up", id: 1, ...profileClose }),
    }), "pocket-host-showcase", "input");
    assert.equal(up.status, 200);
    const profileClosed = await sampleChildClosing(snapshot, profileAppId);
    assertClosingAnimation(profileClosed.frames, profileAppId);
    value = (await sampleUntil(snapshot, (next) => !next.frame.inputBounds && next.frame.ops.some((op) => op.type === "text" && typeof op.text === "string" && op.text.startsWith("Cancelled:")), "Profile cancellation result")).value;
    assertNoPreviewError(value, "Profile cancellation");

    await pointer(2, centerOf(value, "Open profile app"));
    opened = await sampleSettledChild(snapshot, profileAppId, "Profile reopening");
    assertOpeningAnimation(opened.frames, profileAppId);
    await pointer(3, centerOf(opened.value, "Save identity & open Lobby"));
    const lobbyOpened = await sampleSettledChild(snapshot, lobbyAppId, "Lobby opening");
    assertNoPreviewError(lobbyOpened.value, "Lobby opening");
    assertOpeningAnimation(lobbyOpened.frames, lobbyAppId);
    const lobbyClose = closeCenter(lobbyOpened.value);
    await pointer(4, lobbyClose);
    const lobbyClosed = await sampleChildClosing(snapshot, lobbyAppId);
    assertClosingAnimation(lobbyClosed.frames, lobbyAppId);
    const resumed = await sampleSettledChild(snapshot, profileAppId, "Profile retained after Lobby close");
    assert.ok(!hasChild(resumed.value, lobbyAppId), "only the top mini app closes");
    assert.ok(hasChild(resumed.value, profileAppId), "Profile remains available after Lobby closes");
    await pointer(5, closeCenter(resumed.value));
    await sampleChildClosing(snapshot, profileAppId);
    const final = (await sampleUntil(snapshot, (next) =>
      !next.frame.inputBounds &&
      closeIconOps(next).length === 0 &&
      next.frame.ops.some((op) => op.type === "text" && op.text === "Open profile app"),
    "nested cancellation cleanup")).value;
    assertNoPreviewError(final, "final Showcase");
    assert.equal(final.frame.inputBounds, undefined, "all child input bounds must be cleared after close");
    assert.equal(closeIconOps(final).length, 0, "close capsule must disappear after the child closes");
  } finally {
    await reader?.cancel();
    await manager?.dispose();
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(outputProfile, { recursive: true, force: true });
    rmSync(outputLobby, { recursive: true, force: true });
  }
});
