import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(sdkRoot, "..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");

async function bodyJson(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("real native preview executes an independent counter fixture and responds to pointer input", { timeout: 60_000 }, async () => {
  // Keep the acceptance test explicit: a missing probe is an environment
  // failure, never a permission to substitute a fake screenshot/runtime.
  assert.ok(existsSync(probe), `pocket_probe is required for preview acceptance: ${probe}`);
  const fixture = join(import.meta.dir, "fixtures/counter");
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-counter-build-"));
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
  const projectId = "counter-fixture";
  const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("x-pocket-preview-transport"), "native-probe-full-frames");
    reader = stream.body!.getReader();
    const firstChunk = await reader.read();
    assert.match(new TextDecoder().decode(firstChunk.value), /"type":"status"/);

    const before = await bodyJson(await manager.handle(new Request(`${prefix}/snapshot`), projectId, "snapshot"));
    assert.equal(before.status.state, "ready");
    assert.equal(before.frame.width, 390);
    assert.equal(before.frame.height, 360);
    assert.ok(before.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "Increment counter"));
    assert.ok(before.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "count=0"));

    const down = await manager.handle(new Request(`${prefix}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "pointer", phase: "down", id: 0, x: 195, y: 120 }),
    }), projectId, "input");
    assert.equal(down.status, 200);
    await manager.handle(new Request(`${prefix}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "pointer", phase: "up", id: 0, x: 195, y: 120 }),
    }), projectId, "input");

    const after = await bodyJson(await manager.handle(new Request(`${prefix}/snapshot`), projectId, "snapshot"));
    const text = after.frame.ops.filter((op: Record<string, unknown>) => op.type === "text").map((op: Record<string, unknown>) => op.text);
    assert.ok(text.includes("count=1"), "native guest counter did not change after real pointer down/up");
    assert.ok(after.frame.frame > before.frame.frame);

    await manager.handle(new Request(`${prefix}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "resize", width: 320, height: 600 }),
    }), projectId, "input");
    const resized = await bodyJson(await manager.handle(new Request(`${prefix}/snapshot`), projectId, "snapshot"));
    assert.equal(resized.frame.width, 320);
    assert.equal(resized.frame.height, 600);

    const page = await manager.handle(new Request(`${prefix}`), projectId, "page");
    assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'self'");
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN");
    const html = await page.text();
    assert.match(html, /PocketEditorPreview/);
    assert.match(html, /preview\.capture\.result/);
    assert.match(html, /preview\.annotation/);
  } finally {
    await reader?.cancel();
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});

test("real native preview boots the Showcase SystemUI with its trusted catalog", async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for preview acceptance: ${probe}`);
  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: join(repositoryRoot, "demo/js"),
    width: 390,
    height: 844,
    idleDisposeMs: 1000,
    artifacts: {
      bytecode: join(repositoryRoot, "demo/assets/app.qjbc"),
      pak: join(repositoryRoot, "demo/assets/app.pak"),
      revision: 1,
      tickHz: 60,
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/stream"), "pocket-host-showcase", "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    const before = await bodyJson(await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/snapshot"), "pocket-host-showcase", "snapshot"));
    assert.equal(before.status.state, "ready");
    assert.equal(before.status.error, undefined);
    assert.ok(before.frame.resources.some((resource: Record<string, unknown>) => resource.asset === "pocket.texture.3"), "Showcase frame must expose its live rounded-mask resource");
    assert.equal(before.frame.inputBounds, undefined, "root-only Showcase frames must not advertise a child input rectangle");
    const text = before.frame.ops.filter((op: Record<string, unknown>) => op.type === "text").map((op: Record<string, unknown>) => op.text);
    assert.ok(text.includes("Pocket Host Lab"), "Showcase SystemUI home did not render");
    assert.ok(text.includes("Open profile app"));
    assert.ok(text.includes("Open lobby app"));
    assert.ok(before.frame.events.some((event: Record<string, unknown>) => event.name === "host.request"), "host capability requests should remain explicit");

    // This is a real root-guest input round trip, not a child fixture or a
    // browser-side counter. The native Showcase page increments its counter.
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/input", {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id: 0, x: 330, y: 534 }),
      }), "pocket-host-showcase", "input");
      assert.equal(response.status, 200);
    }
    const after = await bodyJson(await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/snapshot"), "pocket-host-showcase", "snapshot"));
    const afterText = after.frame.ops.filter((op: Record<string, unknown>) => op.type === "text").map((op: Record<string, unknown>) => op.text);
    assert.ok(afterText.includes("01"), "Showcase root counter did not change after real pointer input");

    // The same root guest owns bottom navigation; no child-app host launch is
    // assumed when checking this local, fully JS-owned route.
    for (const phase of ["down", "up"]) {
      await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/input", {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id: 0, x: 195, y: 820 }),
      }), "pocket-host-showcase", "input");
    }
    const components = await bodyJson(await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/snapshot"), "pocket-host-showcase", "snapshot"));
    const componentText = components.frame.ops.filter((op: Record<string, unknown>) => op.type === "text").map((op: Record<string, unknown>) => op.text);
    assert.ok(componentText.includes("Official building blocks"), "Showcase root navigation did not switch to Components");

    // Native FrameResult resources are deltas. A fresh SSE subscriber and the
    // snapshot endpoint must still receive the live assets used by its latest
    // DrawOps after later frames have emitted an empty resources array.
    assert.ok(components.frame.resources.some((resource: Record<string, unknown>) => resource.asset === "pocket.texture.3"), "resource cache was not joined into snapshot replay");
    const replay = await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/stream"), "pocket-host-showcase", "stream");
    const replayReader = replay.body!.getReader();
    try {
      let packetText = "";
      for (let index = 0; index < 4 && !packetText.includes('"type":"frame"'); index += 1) {
        const chunk = await replayReader.read();
        if (chunk.done) break;
        packetText += new TextDecoder().decode(chunk.value);
      }
      const frameLine = packetText.split("\n").find((line) => line.startsWith("data: ") && line.includes('"type":"frame"'));
      assert.ok(frameLine, "fresh subscriber did not receive a replay frame");
      const replayFrame = JSON.parse(frameLine!.slice("data: ".length)).frame;
      assert.ok(replayFrame.resources.some((resource: Record<string, unknown>) => resource.asset === "pocket.texture.3"), "fresh subscriber replay omitted the live rounded-mask resource");
    } finally {
      await replayReader.cancel();
    }
  } finally {
    await reader?.cancel();
    await manager.dispose();
  }
});

test("real native preview opens Profile, launches Lobby, and returns through SystemUI", async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for mini-app acceptance: ${probe}`);
  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: join(repositoryRoot, "demo/js"),
    width: 390,
    height: 844,
    idleDisposeMs: 1000,
    artifacts: {
      bytecode: join(repositoryRoot, "demo/assets/app.qjbc"),
      pak: join(repositoryRoot, "demo/assets/app.pak"),
      revision: 1,
      tickHz: 60,
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const snapshot = async () => bodyJson(await manager.handle(
    new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/snapshot"),
    "pocket-host-showcase",
    "snapshot",
  ));
  const waitFor = async (predicate: (value: Record<string, any>) => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    let value = await snapshot();
    while (Date.now() < deadline && !predicate(value)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      value = await snapshot();
    }
    assert.ok(predicate(value), `mini-app preview did not reach the expected state before timeout: ${JSON.stringify(value.status)}`);
    return value;
  };
  const childStability = new Map<string, { y: number; h: number; samples: number }>();
  const settledChild = (value: Record<string, any>, title: string): boolean => {
    const bounds = value.frame?.inputBounds;
    const hasTitle = value.frame?.ops?.some((op: Record<string, unknown>) => op.type === "text" && op.text === title) === true;
    if (!hasTitle || !bounds || ![bounds.y, bounds.h].every(Number.isFinite)) {
      childStability.delete(title);
      return false;
    }
    const previous = childStability.get(title);
    const samples = previous && Math.abs(previous.y - bounds.y) < 0.5 && Math.abs(previous.h - bounds.h) < 0.5
      ? previous.samples + 1
      : 0;
    childStability.set(title, { y: bounds.y, h: bounds.h, samples });
    return samples >= 4 && bounds.h >= value.frame.height * 0.9 && bounds.y >= 0 &&
      bounds.y + bounds.h <= value.frame.height + 0.001;
  };
  const pointer = async (id: number, x: number, y: number) => {
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/input", {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id, x, y }),
      }), "pocket-host-showcase", "input");
      assert.equal(response.status, 200);
    }
  };
  try {
    const stream = await manager.handle(new Request("http://127.0.0.1/api/projects/pocket-host-showcase/preview/stream"), "pocket-host-showcase", "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    await waitFor((value) => value.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "Open profile app"));
    await pointer(0, 195, 670);
    // Native host transitions begin with the child below the root. The first
    // frame containing the title is not a tappable browser-space viewport;
    // derive the next pointer from the settled slot instead.
    let value = await waitFor((next) => settledChild(next, "Pocket Profile"));
    assert.equal(value.status.state, "ready", `Profile preview entered ${String(value.status.state)}: ${String(value.status.error ?? "no status.error")}`);
    assert.equal(value.frame.ops.some((op: Record<string, unknown>) => op.type === "hostSurface"), false, "known child surfaces must be flattened by the preview adapter");
    const profileInputBounds = value.frame.inputBounds;
    assert.ok(profileInputBounds, "focused Profile child must expose its native input bounds");
    for (const key of ["x", "y", "w", "h"] as const) assert.equal(typeof profileInputBounds[key], "number", `Profile inputBounds.${key} must be numeric`);
    assert.ok(profileInputBounds.w > 0 && profileInputBounds.h > 0, "focused child input bounds must have positive size");
    assert.ok(profileInputBounds.x >= 0 && profileInputBounds.y >= 0, "focused child input bounds must stay inside the root origin");
    assert.ok(profileInputBounds.x + profileInputBounds.w <= value.frame.width + 0.001, "focused child input bounds must stay inside root width");
    assert.ok(profileInputBounds.y + profileInputBounds.h <= value.frame.height + 0.001, "focused child input bounds must stay inside root height");
    assert.ok(value.frame.resources.some((resource: Record<string, unknown>) => String(resource.asset).startsWith("pocket.runtime.pocket.demo.profile.")), "Profile assets must use a child runtime namespace");

    const save = value.frame.ops.find((op: Record<string, unknown>) => op.type === "text" && op.text === "Save identity & open Lobby") as Record<string, unknown> | undefined;
    assert.equal(typeof save?.y, "number");
    await pointer(1, 195, Number(save!.y) + 8);
    value = await waitFor((next) => settledChild(next, "Pocket Lobby"));
    assert.equal(value.status.state, "ready");
    assert.ok(value.frame.resources.some((resource: Record<string, unknown>) => String(resource.asset).startsWith("pocket.runtime.pocket.demo.lobby.")), "Lobby assets must use a distinct child runtime namespace");
    const lobbyReturn = value.frame.ops.find((op: Record<string, unknown>) => op.type === "text" && op.text === "Return visits to caller") as Record<string, unknown> | undefined;
    assert.equal(typeof lobbyReturn?.y, "number");
    await pointer(2, 195, Number(lobbyReturn!.y) + 8);

    value = await waitFor((next) => settledChild(next, "Pocket Profile") &&
      !next.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "Pocket Lobby"));
    const profileReturn = value.frame.ops.find((op: Record<string, unknown>) => op.type === "text" && op.text === "Return to Showcase") as Record<string, unknown> | undefined;
    assert.equal(typeof profileReturn?.y, "number");
    await pointer(3, 195, Number(profileReturn!.y) + 8);

    value = await waitFor((next) => next.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "App result:"));
    assert.equal(value.status.state, "ready");
    assert.ok(value.frame.ops.some((op: Record<string, unknown>) => op.type === "text" && op.text === "Open profile app"));
    assert.equal(value.frame.ops.some((op: Record<string, unknown>) => op.type === "hostSurface"), false);
    assert.equal(value.status.error, undefined);
  } finally {
    await reader?.cancel();
    await manager.dispose();
  }
});
