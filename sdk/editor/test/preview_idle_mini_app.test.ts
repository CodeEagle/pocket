import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { createPreviewManager, type PreviewFrame } from "../preview.ts";

const repositoryRoot = resolve(import.meta.dir, "..", "..", "..");
const sdkRoot = join(repositoryRoot, "sdk");
const demoRoot = join(repositoryRoot, "demo/js");
const probe = join(sdkRoot, "native/target/debug/pocket_probe");
const projectId = "preview-idle-mini-app";
const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;

type Snapshot = { status: Record<string, any>; frame: PreviewFrame };

async function readSnapshot(manager: ReturnType<typeof createPreviewManager>): Promise<Snapshot> {
  const response = await manager.handle(new Request(`${prefix}/snapshot`), projectId, "snapshot");
  assert.equal(response.status, 200);
  return await response.json() as Snapshot;
}

async function waitFor(
  manager: ReturnType<typeof createPreviewManager>,
  predicate: (snapshot: Snapshot) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let value = await readSnapshot(manager);
  while (Date.now() < deadline && !predicate(value)) {
    await Bun.sleep(25);
    value = await readSnapshot(manager);
  }
  assert.ok(predicate(value), `timed out waiting for ${label}: ${JSON.stringify({ status: value.status, frame: value.frame?.frame })}`);
  return value;
}

async function pointer(
  manager: ReturnType<typeof createPreviewManager>,
  id: number,
  x: number,
  y: number,
): Promise<void> {
  for (const phase of ["down", "up"] as const) {
    const response = await manager.handle(new Request(`${prefix}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "pointer", phase, id, x, y }),
    }), projectId, "input");
    assert.equal(response.status, 200, `${phase} pointer failed: ${await response.text()}`);
  }
}

test("native mini-app launch rebases the clock after an idle preview", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for idle mini-app acceptance: ${probe}`);
  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: demoRoot,
    width: 390,
    height: 844,
    idleDisposeMs: 30_000,
    artifacts: {
      bytecodePath: join(repositoryRoot, "demo/assets/app.qjbc"),
      pakPath: join(repositoryRoot, "demo/assets/app.pak"),
      revision: 1,
      tickHz: 60,
      compositorSurfaces: { "pocket.demo.profile": 2, "pocket.demo.lobby": 3 },
      applications: {
        "pocket.demo.profile": {
          bytecodePath: join(repositoryRoot, "demo/assets/apps/profile/app.qjbc"),
          pakPath: join(repositoryRoot, "demo/assets/apps/profile/app.pak"),
          appId: "pocket.demo.profile",
        },
        "pocket.demo.lobby": {
          bytecodePath: join(repositoryRoot, "demo/assets/apps/lobby/app.qjbc"),
          pakPath: join(repositoryRoot, "demo/assets/apps/lobby/app.pak"),
          appId: "pocket.demo.lobby",
        },
      },
    },
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopReader = false;
  let consumeError: unknown;
  const decoder = new TextDecoder();
  const acknowledged = new Set<string>();
  let pending = "";
  try {
    const stream = await manager.handle(new Request(`${prefix}/stream?presentation=browser`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    const consume = (async (): Promise<void> => {
      while (!stopReader) {
        const next = await reader!.read();
        if (next.done) return;
        pending += decoder.decode(next.value, { stream: true });
        let boundary = pending.indexOf("\n\n");
        while (boundary >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = block.split(/\r?\n/).find((value) => value.startsWith("data: "));
          if (line) {
            let packet: any;
            try { packet = JSON.parse(line.slice("data: ".length)); } catch { packet = undefined; }
            const tokens = packet?.type === "frame" && Array.isArray(packet.frame?.presentationTokens)
              ? packet.frame.presentationTokens.filter((token: unknown): token is string => typeof token === "string")
              : [];
            const fresh = tokens.filter((token: string) => !acknowledged.has(token));
            for (const token of fresh) acknowledged.add(token);
            if (fresh.length > 0) {
              const response = await manager.handle(new Request(`${prefix}/input`, {
                method: "POST",
                body: JSON.stringify({ type: "presented", tokens: fresh }),
              }), projectId, "input");
              assert.equal(response.status, 200, `presentation ACK failed: ${await response.text()}`);
            }
          }
          boundary = pending.indexOf("\n\n");
        }
      }
    })().catch((error) => { consumeError = error; });

    await waitFor(manager, (value) => value.frame.ops.some((op) => op.type === "text" && op.text === "Open profile app"), "Showcase open action");
    // The root has no active native wake while home is idle. This exceeds the
    // 30-frame guest host-request timeout without making the acceptance slow.
    await Bun.sleep(750);
    const idle = await readSnapshot(manager);
    assert.equal(idle.status.state, "ready");
    assert.equal(idle.status.nextWakeDelayMs, -1);

    await pointer(manager, 0, 195, 670);
    const opened = await waitFor(
      manager,
      (value) => value.status.state === "ready" && value.status.error === undefined &&
        value.frame.ops.some((op) => op.type === "text" && op.text === "Pocket Profile") &&
        value.frame.inputBounds !== undefined,
      "Profile after idle launch",
    );
    assert.ok(acknowledged.size > 0, "browser presentation ACK must have been exercised");
    assert.equal(opened.status.error, undefined);
  } finally {
    stopReader = true;
    await reader?.cancel();
    await manager.dispose();
    if (consumeError) throw consumeError;
  }
});
