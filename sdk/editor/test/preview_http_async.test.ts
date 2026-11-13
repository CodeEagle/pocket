import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager, parsePreviewHostAdapterConfig, type PreviewFrame } from "../preview.ts";

const repository = resolve(import.meta.dir, "../../..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(repository, "sdk/native/target/debug/pocket_probe");
const projectId = "preview-http-async";
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
  timeoutMs = 12_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let value = await readSnapshot(manager);
  while (Date.now() < deadline && !predicate(value)) {
    await Bun.sleep(16);
    value = await readSnapshot(manager);
  }
  assert.ok(predicate(value), `timed out waiting for ${label}: ${JSON.stringify({ status: value.status, frame: value.frame?.frame })}`);
  return value;
}

function textOp(frame: PreviewFrame, label: string): Record<string, any> {
  const found = frame.ops.find((op) => op.type === "text" && op.text === label);
  assert.ok(found, `native frame is missing ${JSON.stringify(label)}: ${frame.ops.filter((op) => op.type === "text").map((op) => op.text).join(" | ")}`);
  return found as Record<string, any>;
}

async function tap(manager: ReturnType<typeof createPreviewManager>, frame: PreviewFrame, label: string): Promise<void> {
  const op = textOp(frame, label);
  const x = Number(op.x) + Math.max(1, Number(op.width ?? op.w) || 1) / 2;
  const y = Number(op.y) + Math.max(1, Number(op.height ?? op.h) || 1) / 2;
  for (const phase of ["down", "up"] as const) {
    const response = await manager.handle(new Request(`${prefix}/input`, {
      method: "POST",
      body: JSON.stringify({ type: "pointer", phase, id: 0, x, y }),
    }), projectId, "input");
    assert.equal(response.status, 200, `${phase} ${label}: ${await response.text()}`);
  }
}

test("native Preview keeps processing Guest input during HTTP and drops responses after dispose", { timeout: 180_000 }, async () => {
  assert.ok(existsSync(probe), `real pocket_probe is required: ${probe}`);
  const root = mkdtempSync(join(tmpdir(), "pocket-preview-http-async-"));
  const project = join(root, "project");
  const outDir = join(root, "out");
  mkdirSync(project);

  let arrivalCount = 0;
  const arrivalWaiters: Array<() => void> = [];
  const responseGates: Array<() => void> = [];
  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      assert.equal(new URL(request.url).pathname, "/api/v1/slow");
      arrivalCount += 1;
      arrivalWaiters.shift()?.();
      await new Promise<void>((resolveGate) => responseGates.push(resolveGate));
      return Response.json({ message: `response-${arrivalCount}` });
    },
  });
  const origin = `http://127.0.0.1:${api.port}`;
  const appId = "pocket.test.preview-http-async";
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "preview-http-async", private: true, type: "module" }));
  await writeFile(join(project, "pocket.json"), JSON.stringify({
    pocket: 2,
    id: appId,
    version: "1.0.0",
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  }));
  await writeFile(join(project, "manifest.json"), JSON.stringify({
    capabilities: { requires: [], optional: ["dio.request"] },
    permissions: { optional: ["network"] },
  }));
  await writeFile(join(project, "pocket.system.json"), JSON.stringify({
    roles: { systemUI: appId },
    applications: { catalog: [] },
    installation: { installedPackages: [appId] },
  }));
  await writeFile(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Focusable, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketDioClient } from "@pocket/ui/dio";

const dio = createPocketDioClient(createHostBridge());
const [status, setStatus] = createSignal("Ready");
const [clicks, setClicks] = createSignal(0);

async function load() {
  setStatus("Loading");
  try {
    const response = await dio.request({ url: ${JSON.stringify(`${origin}/api/v1/slow`)}, method: "GET", responseType: "json" });
    setStatus("Done " + response.data.message);
  } catch {
    setStatus("Unavailable");
  }
}

mount(() => <View class="w-full h-full">
  <Focusable class="w-full h-24" onPress={() => void load()}><Text>Load remote</Text></Focusable>
  <Focusable class="w-full h-24" onPress={() => setClicks(clicks() + 1)}><Text>Increment</Text></Focusable>
  <Text>{() => "Clicks: " + clicks()}</Text>
  <Text>{status}</Text>
</View>);
`);

  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopReader = false;
  let readerError: unknown;
  let readerTask: Promise<void> | undefined;
  try {
    const built = await buildGuest({ projectRoot: project, outDir, tickHz: 60 });
    manager = createPreviewManager({
      probePath: probe,
      projectDirectory: project,
      width: 390,
      height: 640,
      commandTimeoutMs: 10_000,
      artifacts: { bytecode: built.bytecode, pak: built.pak, revision: 1, tickHz: 60 },
      previewHostAdapter: parsePreviewHostAdapterConfig({
        projectId,
        hostConfig: { apiBaseUrl: `${origin}/api/v1` },
        http: { allowedOrigins: [origin], allowedRoutes: [{ method: "GET", path: "/api/v1/slow" }] },
      }),
    });
    const session = (manager as any).session(projectId) as {
      sendHostResponse: (...args: any[]) => Promise<void>;
      pendingPreviewHttpControllers: Set<AbortController>;
    };
    let httpResponses = 0;
    const sendHostResponse = session.sendHostResponse.bind(session);
    session.sendHostResponse = async (...args: any[]) => {
      if (args[2] === "dio.request") httpResponses += 1;
      await sendHostResponse(...args);
    };

    const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    readerTask = (async () => {
      while (!stopReader) {
        const next = await reader!.read();
        if (next.done) return;
      }
    })().catch((error) => { readerError = error; });
    let snapshot = await waitFor(manager, (value) => value.status.state === "ready" && value.frame.ops.some((op) => op.type === "text" && op.text === "Load remote"), "initial native frame");

    const waitForArrival = async (expected: number): Promise<void> => {
      if (arrivalCount >= expected) return;
      await Promise.race([
        new Promise<void>((resolveArrival) => arrivalWaiters.push(resolveArrival)),
        Bun.sleep(8_000).then(() => { throw new Error(`HTTP request ${expected} did not reach the local server`); }),
      ]);
      assert.equal(arrivalCount, expected);
    };

    await tap(manager, snapshot.frame, "Load remote");
    await waitForArrival(1);
    snapshot = await waitFor(manager, (value) => value.frame.ops.some((op) => op.type === "text" && op.text === "Loading"), "loading frame while request is pending");
    assert.equal(httpResponses, 0, "the unresolved HTTP response must still be pending");

    await tap(manager, snapshot.frame, "Increment");
    snapshot = await waitFor(manager, (value) => value.frame.ops.some((op) => op.type === "text" && op.text === "Clicks: 1"), "native input while HTTP is unresolved", 3_000);
    assert.ok(snapshot.frame.ops.some((op) => op.type === "text" && op.text === "Loading"), "network completion must not be required to process unrelated Guest input");

    responseGates.shift()?.();
    snapshot = await waitFor(manager, (value) => value.frame.ops.some((op) => op.type === "text" && String(op.text).startsWith("Done response-1")), "HTTP result frame");
    assert.equal(httpResponses, 1, "one completed request must produce exactly one host response");

    await tap(manager, snapshot.frame, "Load remote");
    await waitForArrival(2);
    const pendingController = [...session.pendingPreviewHttpControllers][0];
    assert.ok(pendingController, "the second unresolved request must have a cancellable host request");
    await manager.dispose();
    manager = undefined;
    assert.equal(pendingController.signal.aborted, true, "disposing Preview must abort in-flight HTTP");
    await Bun.sleep(50);
    assert.equal(httpResponses, 1, "an aborted request must not send a stale response into a disposed Guest");
  } finally {
    for (const release of responseGates.splice(0)) release();
    stopReader = true;
    await reader?.cancel().catch(() => {});
    await readerTask;
    await manager?.dispose();
    api.stop(true);
    rmSync(root, { recursive: true, force: true });
    if (readerError) throw readerError;
  }
});
