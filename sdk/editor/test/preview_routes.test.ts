import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

type JsonRecord = Record<string, any>;

const sdkRoot = resolve(import.meta.dir, "../..");
const repositoryRoot = resolve(sdkRoot, "..");
const probe = process.env.POCKET_NATIVE_PROBE ?? join(sdkRoot, "native/target/debug/pocket_probe");
const bytecode = process.env.POCKET_PREVIEW_APP_QJBC ?? join(repositoryRoot, "demo/assets/app.qjbc");
const pak = process.env.POCKET_PREVIEW_APP_PAK ?? join(repositoryRoot, "demo/assets/app.pak");
const projectDirectory = join(repositoryRoot, "demo/js");

const routes = ["Mobile UI", "Transitions", "Hardware"] as const;

function routeHeading(frame: JsonRecord | null, route: string): JsonRecord | undefined {
  return frame?.ops?.find((op: JsonRecord) =>
    op.type === "text" && op.text === route && typeof op.x === "number" && typeof op.y === "number" && op.y < 80,
  );
}

async function snapshot(manager: ReturnType<typeof createPreviewManager>, projectId: string): Promise<JsonRecord> {
  const response = await manager.handle(
    new Request(`http://127.0.0.1/api/projects/${projectId}/preview/snapshot`),
    projectId,
    "snapshot",
  );
  assert.equal(response.status, 200);
  return await response.json() as JsonRecord;
}

async function sendPointer(
  manager: ReturnType<typeof createPreviewManager>,
  projectId: string,
  phase: "down" | "up",
  id: number,
  x: number,
  y: number,
): Promise<void> {
  const response = await manager.handle(
    new Request(`http://127.0.0.1/api/projects/${projectId}/preview/input`, {
      method: "POST",
      body: JSON.stringify({ type: "pointer", phase, id, x, y }),
    }),
    projectId,
    "input",
  );
  assert.equal(response.status, 200, `${phase} pointer request must be accepted`);
}

test("native preview route transitions finish without a second input", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(probe), `pocket_probe is required for route transition acceptance: ${probe}`);
  assert.ok(existsSync(bytecode), `preview app.qjbc is required for route transition acceptance: ${bytecode}`);
  assert.ok(existsSync(pak), `preview app.pak is required for route transition acceptance: ${pak}`);

  for (const route of routes) {
    const projectId = `route-${route.toLowerCase().replace(/\s+/g, "-")}`;
    const manager = createPreviewManager({
      probePath: probe,
      projectDirectory,
      width: 390,
      height: 844,
      idleDisposeMs: 5_000,
      artifacts: { bytecode, pak, revision: 1, tickHz: 60 },
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let inputCount = 0;
    try {
      const stream = await manager.handle(
        new Request(`http://127.0.0.1/api/projects/${projectId}/preview/stream`),
        projectId,
        "stream",
      );
      assert.equal(stream.status, 200, `${route} stream must start`);
      reader = stream.body!.getReader();
      await reader.read();

      const initial = await snapshot(manager, projectId);
      assert.equal(initial.status.state, "ready", `${route} preview must be ready`);
      const target = initial.frame.ops.find((op: JsonRecord) => op.type === "text" && op.text === route);
      assert.ok(target, `${route} home entry must be present in the native FrameResult`);
      assert.equal(typeof target.x, "number");
      assert.equal(typeof target.y, "number");
      assert.equal(typeof target.w, "number");
      assert.equal(typeof target.h, "number");

      const x = Number(target.x) + Number(target.w) / 2;
      const y = Number(target.y) + Number(target.h) / 2;
      await sendPointer(manager, projectId, "down", 0, x, y);
      inputCount += 1;
      await sendPointer(manager, projectId, "up", 0, x, y);
      inputCount += 1;
      assert.equal(inputCount, 2, `${route} transition must use exactly one pointer contact`);

      const positions: number[] = [];
      const frames: number[] = [];
      let lastFrame = -1;
      const deadline = Date.now() + 900;
      while (Date.now() < deadline) {
        const value = await snapshot(manager, projectId);
        const heading = routeHeading(value.frame, route);
        const frameNumber = Number(value.frame?.frame);
        if (heading && frameNumber !== lastFrame) {
          positions.push(Number(heading.x));
          frames.push(frameNumber);
          lastFrame = frameNumber;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }

      const distinctPositions = [...new Set(positions.map((value) => value.toFixed(3)))];
      assert.ok(frames.length >= 3, `${route} must expose at least two intermediate native frames`);
      assert.ok(distinctPositions.length >= 3, `${route} heading must move through at least two intermediate positions`);
      for (let index = 1; index < frames.length; index += 1) {
        assert.ok(frames[index] > frames[index - 1], `${route} FrameResult frame numbers must increase while transitioning`);
      }

      const final = await snapshot(manager, projectId);
      const finalHeading = routeHeading(final.frame, route);
      assert.ok(finalHeading, `${route} must render its destination heading`);
      const finalX = Number(finalHeading.x);
      await new Promise((resolveWait) => setTimeout(resolveWait, 180));
      const settled = await snapshot(manager, projectId);
      const settledHeading = routeHeading(settled.frame, route);
      assert.ok(settledHeading, `${route} destination heading must remain visible`);
      assert.equal(Number(settledHeading.x).toFixed(3), finalX.toFixed(3), `${route} must settle without another input`);
      assert.equal(settled.frame.frame, final.frame.frame, `${route} must stop emitting frames after settling`);
      assert.ok(
        settled.status.nextWakeDelayMs === null || settled.status.nextWakeDelayMs < 0,
        `${route} must not keep a continuous idle timer after settling`,
      );
      console.log(JSON.stringify({ acceptance: "preview-route-transition", route, intermediatePositions: distinctPositions.length, finalFrame: settled.frame.frame }));
    } finally {
      await reader?.cancel();
      await manager.dispose();
    }
  }
});
