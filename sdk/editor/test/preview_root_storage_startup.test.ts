import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const repository = resolve(import.meta.dir, "../../..");
const demo = join(repository, "demo/js");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(repository, "sdk/native/target/debug/pocket_probe");

test("native Editor startup completes a root platform.storage.get while SystemUI initializes", { timeout: 180_000 }, async () => {
  assert.ok(existsSync(probe), "the real pocket_probe is required");
  const output = mkdtempSync(join(tmpdir(), "pocket-root-storage-startup-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const suppliedBytecode = process.env.POCKET_STORAGE_TEST_BYTECODE;
    const suppliedPak = process.env.POCKET_STORAGE_TEST_PAK;
    let bytecode: string;
    let pak: string;
    if (suppliedBytecode || suppliedPak) {
      assert.ok(suppliedBytecode && suppliedPak, "set both POCKET_STORAGE_TEST_BYTECODE and POCKET_STORAGE_TEST_PAK");
      assert.ok(existsSync(suppliedBytecode), `missing supplied QJBC: ${suppliedBytecode}`);
      assert.ok(existsSync(suppliedPak), `missing supplied PAK: ${suppliedPak}`);
      bytecode = suppliedBytecode;
      pak = suppliedPak;
    } else {
      const built = await buildGuest({ projectRoot: demo, outDir: join(output, "root"), tickHz: 60 });
      bytecode = built.bytecode;
      pak = built.pak;
    }
    const preview = createPreviewManager({
      probePath: probe,
      projectDirectory: demo,
      width: 390,
      height: 844,
      commandTimeoutMs: 15_000,
      idleDisposeMs: 1_000,
      artifacts: { bytecode, pak, tickHz: 60 },
    });
    manager = preview;
    const id = "root-storage-startup";
    const base = `http://127.0.0.1/api/projects/${id}/preview`;
    const session = (preview as any).session(id);
    const storageResponses: Array<{ result: unknown; error: unknown }> = [];
    const sendHostResponse = session.sendHostResponse.bind(session);
    session.sendHostResponse = async (runtime: unknown, requestId: string, capability: string, result: unknown, error: unknown) => {
      if (capability === "platform.storage.get") storageResponses.push({ result, error });
      return sendHostResponse(runtime, requestId, capability, result, error);
    };
    const stream = await preview.handle(new Request(`${base}/stream`), id, "stream");
    assert.equal(stream.status, 200, stream.status === 200 ? undefined : await stream.text());
    reader = stream.body!.getReader();
    await reader.read();

    assert.ok(session?.rootRuntime?.probe, "the preview must load the generated QJBC in a native runtime");
    const snapshot = async (): Promise<Record<string, any>> =>
      await (await preview.handle(new Request(`${base}/snapshot`), id, "snapshot")).json();
    const hasShowcase = (value: Record<string, any>) =>
      value.frame?.ops?.some((op: Record<string, unknown>) => op.type === "text" && op.text === "POCKET SHOWCASE");
    const deadline = Date.now() + 12_000;
    let latest = await snapshot();
    while (Date.now() < deadline &&
        (storageResponses.length === 0 || !hasShowcase(latest)) &&
        latest.status.state !== "error") {
      await Bun.sleep(16);
      latest = await snapshot();
    }
    assert.equal(latest.status.state, "ready", `native startup failed: ${latest.status.error ?? "unknown error"}`);
    assert.ok(storageResponses.length > 0, "the actual guest must complete its startup platform.storage.get");
    assert.equal(storageResponses[0]?.error, undefined, "the JS SystemUI kernel must authorize and answer storage");
    assert.ok(hasShowcase(latest), "the ready native frame should show the real Showcase root");
  } finally {
    await reader?.cancel();
    await manager?.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});
