import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { resolveNativeProbePath } from "../../scripts/native_probe_path.ts";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager, type PreviewHostFontMetrics } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(sdkRoot, "..");
const demoRoot = join(repositoryRoot, "demo/js");
const bytecode = join(repositoryRoot, "demo/assets/app.qjbc");
const pak = join(repositoryRoot, "demo/assets/app.pak");
const probe = process.env.POCKET_NATIVE_PROBE ?? resolveNativeProbePath(sdkRoot);

function metrics(offset: number): PreviewHostFontMetrics {
  return {
    lineHeights: Array(21).fill(18 + offset),
    cjkAdvances: Array(21).fill(15 + offset),
    asciiAdvances: Array(21 * 95).fill(8 + offset),
  };
}

function assertFontMetricsVersion(actual: PreviewHostFontMetrics | undefined, expected: PreviewHostFontMetrics, label: string): void {
  assert.ok(actual, `${label} must include host font metrics`);
  assert.equal(actual.lineHeights[0], expected.lineHeights[0], `${label} line height version`);
  assert.equal(actual.cjkAdvances[0], expected.cjkAdvances[0], `${label} CJK version`);
  assert.equal(actual.asciiAdvances[0], expected.asciiAdvances[0], `${label} ASCII version`);
  assert.equal(actual.lineHeights.length, expected.lineHeights.length, `${label} line height count`);
  assert.equal(actual.cjkAdvances.length, expected.cjkAdvances.length, `${label} CJK count`);
  assert.equal(actual.asciiAdvances.length, expected.asciiAdvances.length, `${label} ASCII count`);
}

async function setHostFonts(manager: ReturnType<typeof createPreviewManager>, projectId: string, hostFonts: PreviewHostFontMetrics): Promise<void> {
  const response = await manager.handle(new Request(`http://127.0.0.1/api/projects/${projectId}/preview/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "hostFonts", hostFonts }),
  }), projectId, "input");
  assert.equal(response.status, 200, await response.text());
}

function recordFontUpdates(runtime: any): PreviewHostFontMetrics[] {
  const updates: PreviewHostFontMetrics[] = [];
  const checked = runtime.probe.checked.bind(runtime.probe);
  runtime.probe.checked = async (command: Record<string, any>) => {
    if (command.op === "setHostFonts") updates.push(command.hostFonts);
    return checked(command);
  };
  return updates;
}

test("recording holds one host font table for root and child, then refreshes both on stop", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required: ${probe}`);

  const output = mkdtempSync(join(tmpdir(), "pocket-editor-recording-fonts-build-"));
  const projectDirectory = join(output, "system-project");
  const childAppId = "fixture.child.counter";
  mkdirSync(projectDirectory, { recursive: true });
  let built;
  try {
    built = await buildGuest({
      projectRoot: join(import.meta.dir, "fixtures/counter"),
      outDir: join(output, "guest"),
      tickHz: 60,
    });
    writeFileSync(join(projectDirectory, "pocket.system.json"), `${JSON.stringify({
      roles: { systemUI: "fixture.system" },
      applications: { catalog: [{ package: childAppId, manifest: "apps/counter/pocket.json" }] },
      installation: { installedPackages: [childAppId] },
    }, null, 2)}\n`);
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }

  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory,
    width: 390,
    height: 360,
    idleDisposeMs: 30_000,
    artifacts: {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      revision: 1,
      tickHz: 60,
      applications: {
        [childAppId]: { bytecodePath: built.bytecode, pakPath: built.pak, appId: childAppId, revision: 1, tickHz: 60 },
      },
    },
  });
  const projectId = `preview-recording-fonts-${Math.random().toString(36).slice(2, 8)}`;
  const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let probePrototype: any;
  let originalChecked: any;
  const rootCreateCommands: Array<Record<string, any>> = [];
  try {
    const page = await manager.handle(new Request(`http://127.0.0.1/api/projects/${projectId}/preview`), projectId, "page");
    assert.equal(page.status, 200);
    const session = (manager as any).sessions.get(projectId) as any;
    const initialMetrics = metrics(0);
    const updatedMetrics = metrics(3);

    const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    const settleDeadline = Date.now() + 10_000;
    while ((session.pendingSystemRequests.size > 0 || session.rootRuntime?.pumping > 0) && Date.now() < settleDeadline) {
      await Bun.sleep(10);
    }
    await setHostFonts(manager, projectId, initialMetrics);
    assertFontMetricsVersion(session.hostFontMetrics, initialMetrics, "initial browser hostFonts input");

    const oldRoot = session.rootRuntime;
    probePrototype = Object.getPrototypeOf(oldRoot.probe);
    originalChecked = probePrototype.checked;
    probePrototype.checked = function(this: any, command: Record<string, any>) {
      if (this !== oldRoot.probe && command.op === "create") rootCreateCommands.push(command);
      return originalChecked.call(this, command);
    };
    await session.enqueue(async () => {
      oldRoot.pumping = 1;
      try {
        await session.handleRuntimeEvent(oldRoot, {
          type: "event",
          name: "host.request",
          payload: {
            requestId: "recording-host-fonts-start",
            capability: "diagnostics.recording.start",
            params: {},
          },
        }, 0);
      } finally {
        oldRoot.pumping = 0;
      }
    });
    const restartDeadline = Date.now() + 10_000;
    while ((!session.rootRuntime || session.rootRuntime === oldRoot || session.previewRecordingStatus().restarting) && Date.now() < restartDeadline) {
      await Bun.sleep(10);
    }
    const root = session.rootRuntime;
    assert.ok(root, "recording restart must install a fresh root before exposing recording status");
    assert.notEqual(root, oldRoot, `recording must use a fresh traced root probe; status=${JSON.stringify(session.previewRecordingStatus())}`);
    assert.equal(session.status().state, "ready", "the fresh traced root must finish loading before assertions");
    assertFontMetricsVersion(rootCreateCommands[0]?.hostFonts, initialMetrics,
      `actual recording root create; active=${session.hostFontMetrics?.lineHeights?.[0]}; status=${JSON.stringify(session.previewRecordingStatus())}`);
    const rootCapture = session.previewRecording.captures.get(root);
    assertFontMetricsVersion(rootCapture?.createArgs?.hostFonts, initialMetrics, "recorded root create");
    const rootUpdates = recordFontUpdates(root);

    await setHostFonts(manager, projectId, updatedMetrics);
    assert.equal(rootUpdates.length, 0, "font changes must not mutate the root while a capture is active");

    await session.handleRuntimeEvent(root, {
      type: "event",
      name: "host.request",
      payload: {
        requestId: "recording-child-fonts-create",
        capability: "system.runtime.create",
        params: { appId: childAppId },
      },
    }, 0);
    const childDeadline = Date.now() + 10_000;
    while (!session.childRuntimes.get(childAppId) && Date.now() < childDeadline) await Bun.sleep(10);
    const child = session.childRuntimes.get(childAppId);
    assert.ok(child, "the catalog child must load during recording");
    assertFontMetricsVersion(rootCreateCommands[1]?.hostFonts, initialMetrics, "actual recording child create");
    const childCapture = session.previewRecording.captures.get(child);
    assertFontMetricsVersion(childCapture?.createArgs?.hostFonts, initialMetrics, "recorded child create");
    const childUpdates = recordFontUpdates(child);

    const stopped = await session.genericCapabilityResult(root, "diagnostics.recording.stop", {});
    assert.equal(stopped.stopped, true, JSON.stringify(stopped));
    assert.deepEqual(rootUpdates, [updatedMetrics], "stop must apply the latest table to the root");
    assert.deepEqual(childUpdates, [updatedMetrics], "stop must apply the latest table to the existing child");
  } finally {
    if (probePrototype && originalChecked) probePrototype.checked = originalChecked;
    await reader?.cancel();
    await manager.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});

test("child load pending during a font refresh is synchronized before attach", { timeout: 120_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required: ${probe}`);
  assert.ok(existsSync(bytecode), `Showcase bytecode is required: ${bytecode}`);
  assert.ok(existsSync(pak), `Showcase pak is required: ${pak}`);

  const manager = createPreviewManager({
    probePath: probe,
    projectDirectory: demoRoot,
    width: 390,
    height: 844,
    idleDisposeMs: 30_000,
    artifacts: { bytecodePath: bytecode, pakPath: pak, revision: 1, tickHz: 60 },
  });
  const projectId = `preview-font-load-race-${Math.random().toString(36).slice(2, 8)}`;
  const prefix = `http://127.0.0.1/api/projects/${projectId}/preview`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let releaseChildLoad = () => {};
  let childLoadStarted = () => {};
  let childLoadWasBlocked = false;
  let childCreateMetrics: PreviewHostFontMetrics | undefined;
  const childUpdates: PreviewHostFontMetrics[] = [];
  let prototype: any;
  let originalChecked: any;
  try {
    const stream = await manager.handle(new Request(`${prefix}/stream`), projectId, "stream");
    assert.equal(stream.status, 200);
    reader = stream.body!.getReader();
    await reader.read();

    const session = (manager as any).sessions.get(projectId) as any;
    const initialMetrics = metrics(0);
    const updatedMetrics = metrics(3);
    await setHostFonts(manager, projectId, initialMetrics);
    const root = session.rootRuntime;
    const rootProbe = root.probe;
    prototype = Object.getPrototypeOf(rootProbe);
    originalChecked = prototype.checked;
    const childLoadGate = new Promise<void>((resolveGate) => { releaseChildLoad = resolveGate; });
    const childLoadEntered = new Promise<void>((resolveEntered) => { childLoadStarted = resolveEntered; });
    prototype.checked = async function(this: any, command: Record<string, any>) {
      if (this !== rootProbe && command.op === "create") childCreateMetrics = command.hostFonts;
      if (this !== rootProbe && command.op === "loadBytecode" && !childLoadWasBlocked) {
        childLoadWasBlocked = true;
        childLoadStarted();
        await childLoadGate;
      }
      if (this !== rootProbe && command.op === "setHostFonts") childUpdates.push(command.hostFonts);
      return originalChecked.call(this, command);
    };

    const childAppId = "pocket.demo.profile";
    await session.handleRuntimeEvent(root, {
      type: "event",
      name: "host.request",
      payload: {
        requestId: "font-refresh-pending-child-create",
        capability: "system.runtime.create",
        params: { appId: childAppId },
      },
    }, 0);
    await Promise.race([
      childLoadEntered,
      Bun.sleep(30_000).then(() => { throw new Error("child load did not reach the deterministic pause"); }),
    ]);

    await setHostFonts(manager, projectId, updatedMetrics);
    assert.deepEqual(childCreateMetrics, initialMetrics, "the in-flight child create used the previously active table");
    assert.equal(childUpdates.length, 0, "the in-flight child is not in the runtime refresh snapshot yet");

    releaseChildLoad();
    const deadline = Date.now() + 30_000;
    while (!session.childRuntimes.get(childAppId) && Date.now() < deadline) await Bun.sleep(10);
    const child = session.childRuntimes.get(childAppId);
    assert.ok(child, "the pending child must eventually attach");
    assert.deepEqual(childUpdates, [updatedMetrics], "the stale child must receive the current table before attach");
  } finally {
    releaseChildLoad();
    if (prototype && originalChecked) prototype.checked = originalChecked;
    await reader?.cancel();
    await manager.dispose();
  }
});
