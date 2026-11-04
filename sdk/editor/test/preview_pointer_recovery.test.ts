import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const probeCandidates = process.env.POCKET_NATIVE_PROBE
  ? [resolve(process.env.POCKET_NATIVE_PROBE)]
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ];
const probe = probeCandidates.find(existsSync);
const fixture = join(import.meta.dir, "fixtures/scroll");

test("native pointer recovery rolls back failed edges and cancels the captured target", { timeout: 60_000 }, async () => {
  assert.ok(probe, `pocket_probe is required for pointer recovery: ${probeCandidates.join(", ")}`);
  const output = mkdtempSync(join(tmpdir(), "pocket-editor-pointer-recovery-"));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reconnectReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const manager = createPreviewManager({
    probePath: probe,
    width: 390,
    height: 360,
    idleDisposeMs: 1_000,
    artifacts: undefined,
  });
  const projectId = "pointer-recovery";
  const base = `http://127.0.0.1/api/projects/${projectId}/preview`;
  const send = async (payload: Record<string, unknown>): Promise<Response> => manager.handle(
    new Request(`${base}/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    projectId,
    "input",
  );
  try {
    const built = await buildGuest({ projectRoot: fixture, outDir: output, tickHz: 60 });
    // Resolve artifacts after the build so the test exercises the checked-in
    // native probe, not a mock command transport.
    (manager as any).options.artifacts = {
      bytecode: built.bytecode,
      pak: built.pak,
      revision: 1,
      tickHz: 60,
    };
    const stream = await manager.handle(new Request(`${base}/stream?presentation=browser`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    // Native rejects this DOWN because x is outside the real 390px viewport.
    // The failed admission must not leave a backend target reservation.
    const rejectedDown = await send({ type: "pointer", phase: "down", id: 0, x: 1023, y: 12 });
    assert.equal(rejectedDown.status, 400);
    assert.match(await rejectedDown.text(), /input\.pointer/);

    const firstDown = await send({ type: "pointer", phase: "down", id: 0, x: 12, y: 12 });
    assert.equal(firstDown.status, 200);
    // A fresh DOWN on an already captured id must cancel that original target
    // before admitting the replacement, rather than returning id-active.
    const duplicateDown = await send({ type: "pointer", phase: "down", id: 0, x: 18, y: 18 });
    assert.equal(duplicateDown.status, 200);
    const duplicateUp = await send({ type: "pointer", phase: "up", id: 0, x: 18, y: 18 });
    assert.equal(duplicateUp.status, 200);

    const secondDown = await send({ type: "pointer", phase: "down", id: 0, x: 12, y: 12 });
    assert.equal(secondDown.status, 200);

    // A native UP with an invalid coordinate leaves the old contact captured.
    // The next DOWN must CANCEL that original target before admitting itself.
    const rejectedUp = await send({ type: "pointer", phase: "up", id: 0, x: 1023, y: 12 });
    assert.equal(rejectedUp.status, 400);
    assert.match(await rejectedUp.text(), /input\.pointer/);
    const recoveredDown = await send({ type: "pointer", phase: "down", id: 0, x: 24, y: 24 });
    assert.equal(recoveredDown.status, 200);
    const recoveredUp = await send({ type: "pointer", phase: "up", id: 0, x: 24, y: 24 });
    assert.equal(recoveredUp.status, 200);

    // Frontend cleanup may race a failed DOWN. CANCEL is intentionally
    // idempotent when no backend target exists, while MOVE/UP stay strict.
    const unknownCancel = await send({ type: "pointer", phase: "cancel", id: 7, x: 0, y: 0 });
    assert.equal(unknownCancel.status, 200);

    // A native DOWN can be admitted before the following frame pump fails.
    // The backend must CANCEL that same target, preserve the real pump error,
    // and let the next input restart the failed probe generation cleanly.
    const session = ((manager as any).sessions.get(projectId)) as Record<string, any>;
    const nativeProbe = session.probe as Record<string, any>;
    const checked = nativeProbe.checked.bind(nativeProbe);
    let failNextFrame = true;
    nativeProbe.checked = async (command: Record<string, unknown>) => {
      if (failNextFrame && command.op === "frame") {
        failNextFrame = false;
        throw new Error("forced pointer tick failure");
      }
      return checked(command);
    };
    const tickFailure = await send({ type: "pointer", phase: "down", id: 0, x: 42, y: 42 });
    nativeProbe.checked = checked;
    assert.equal(tickFailure.status, 400);
    assert.match(await tickFailure.text(), /forced pointer tick failure/);
    const afterTickFailure = await send({ type: "pointer", phase: "down", id: 0, x: 48, y: 48 });
    assert.equal(afterTickFailure.status, 200, "a failed DOWN pump must not strand pointer id 0");
    const afterTickFailureUp = await send({ type: "pointer", phase: "up", id: 0, x: 48, y: 48 });
    assert.equal(afterTickFailureUp.status, 200);

    // Closing/reconnecting the browser stream must cancel an admitted contact
    // on its original native target before the next generation reuses id 0.
    const activeDown = await send({ type: "pointer", phase: "down", id: 0, x: 30, y: 30 });
    assert.equal(activeDown.status, 200);
    await reader.cancel();
    reader = undefined;
    await Bun.sleep(25);
    const reconnect = await manager.handle(new Request(`${base}/stream?presentation=browser`), projectId, "stream");
    assert.equal(reconnect.status, 200);
    reconnectReader = reconnect.body!.getReader();
    await reconnectReader.read();
    const reconnectDown = await send({ type: "pointer", phase: "down", id: 0, x: 36, y: 36 });
    assert.equal(reconnectDown.status, 200);
    const reconnectUp = await send({ type: "pointer", phase: "up", id: 0, x: 36, y: 36 });
    assert.equal(reconnectUp.status, 200);
  } finally {
    await reader?.cancel();
    await reconnectReader?.cancel();
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});
