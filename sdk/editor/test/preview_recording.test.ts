import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");

test("web preview records real probe boundaries and replays the exported native trace", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for preview recording: ${probe}`);
  const fixture = join(import.meta.dir, "fixtures/counter");
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-recording-build-"));
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
    artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
  });
  const projectId = "counter-recording";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const stream = await manager.handle(new Request(`${base}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();
    const session = (manager as any).sessions.get(projectId) as any;
    const root = session.rootRuntime;
    // Exercise the same host.request bridge used by RecordingPanel. Keep the
    // old runtime pumping while the request is answered so start arms a safe
    // post-turn fresh probe instead of closing the response transport.
    await session.enqueue(async () => {
      root.pumping = 1;
      try {
        await session.handleRuntimeEvent(root, {
          type: "event",
          name: "host.request",
          payload: { requestId: "preview-recording-start", capability: "diagnostics.recording.start", params: {} },
        }, 0);
      } finally {
        root.pumping = 0;
      }
    });
    const restartDeadline = Date.now() + 5_000;
    while ((session.rootRuntime === root || session.previewRecordingStatus().restarting === true) && Date.now() < restartDeadline) await Bun.sleep(1);
    assert.notEqual(session.rootRuntime, root, "Start recording must replace the live probe before tracing");
    const started = session.previewRecordingStatus();
    assert.equal(started.enabled, true);
    assert.equal(started.recording, true);
    assert.equal(started.runtimes.length, 1);
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request(`${base}/input`, {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id: 0, x: 195, y: 120 }),
      }), projectId, "input");
      assert.equal(response.status, 200);
    }
    const stopped = await session.genericCapabilityResult(root, "diagnostics.recording.stop", {});
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.incomplete, false);
    for (const phase of ["down", "up"]) {
      const response = await manager.handle(new Request(`${base}/input`, {
        method: "POST",
        body: JSON.stringify({ type: "pointer", phase, id: 1, x: 195, y: 120 }),
      }), projectId, "input");
      assert.equal(response.status, 200, `post-stop ${phase} should keep preview interactive`);
    }
    const replay = await session.genericCapabilityResult(root, "diagnostics.recording.replay", {});
    assert.equal(replay.ok, true, JSON.stringify(replay));
    const exported = await session.genericCapabilityResult(root, "diagnostics.recording.export", { inputTape: { v: 1, frames: 0, masks: [] } });
    assert.equal(typeof exported.path, "string");
    const archive = JSON.parse(readFileSync(exported.path, "utf8"));
    assert.equal(archive.schema, "pocket.recording.archive");
    const recording = Object.values(archive.recordings)[0] as any;
    assert.equal(recording.schema, "pocket.runtime.recording");
    assert.equal(recording.metadata.width, 390);
    assert.equal(recording.metadata.height, 360);
    assert.equal(recording.entries.some((entry: any) => entry.kind === "auxiliary" && entry.args.operation === "create"), false);
    assert.ok(recording.entries.some((entry: any) => entry.kind === "loadBytecode"));
    assert.ok(recording.entries.some((entry: any) => entry.kind === "frame"));
    assert.ok(recording.entries.some((entry: any) => entry.kind === "send"));
    assert.ok(recording.entries.some((entry: any) => entry.result.traceClock));
  } finally {
    await reader?.cancel();
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});
