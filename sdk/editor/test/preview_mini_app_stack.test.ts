import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { createPreviewManager } from "../preview.ts";

const repository = resolve(import.meta.dir, "../../..");
const demo = join(repository, "demo/js");
const profileId = "pocket.demo.profile";
const lobbyId = "pocket.demo.lobby";
const probe = join(repository, "sdk/native/target/debug/pocket_probe");
type Snapshot = Record<string, any>;

test("stacked mini apps retain their parent and reverse every dismissal path", { timeout: 180_000 }, async () => {
  assert.ok(existsSync(probe), "real pocket_probe is required");
  const output = mkdtempSync(join(tmpdir(), "pocket-mini-stack-"));
  let manager: ReturnType<typeof createPreviewManager> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const root = await buildGuest({ projectRoot: demo, outDir: join(output, "root"), tickHz: 60 });
    const profile = await buildGuest({ projectRoot: join(demo, "apps/profile"), outDir: join(output, "profile"), tickHz: 60 });
    const lobby = await buildGuest({ projectRoot: join(demo, "apps/lobby"), outDir: join(output, "lobby"), tickHz: 60 });
    manager = createPreviewManager({
      probePath: probe, projectDirectory: demo, width: 390, height: 844,
      artifacts: { bytecode: root.bytecode, pak: root.pak, tickHz: 60, applications: {
        [profileId]: { bytecode: profile.bytecode, pak: profile.pak },
        [lobbyId]: { bytecode: lobby.bytecode, pak: lobby.pak },
      } },
    });
    const id = "retained-mini-stack";
    const base = `http://127.0.0.1/api/projects/${id}/preview`;
    const stream = await manager.handle(new Request(`${base}/stream`), id, "stream");
    reader = stream.body!.getReader();
    await reader.read();
    const session = (manager as any).sessions.get(id);
    const launches = new Map<string, string>();
    const sendResponse = session.sendHostResponse.bind(session);
    session.sendHostResponse = async (runtime: any, request: string, capability: string, result: any, error: any) => {
      if (capability === "platform.apps.open" && result?.requestId) launches.set(result.targetAppId, result.requestId);
      return sendResponse(runtime, request, capability, result, error);
    };
    const snapshot = async (): Promise<Snapshot> => (await manager!.handle(new Request(`${base}/snapshot`), id, "snapshot")).json();
    const input = async (payload: Record<string, unknown>) => {
      const response = await manager!.handle(new Request(`${base}/input`, { method: "POST", body: JSON.stringify(payload) }), id, "input");
      assert.equal(response.status, 200, await response.text());
    };
    const text = (value: Snapshot, label: string) => value.frame.ops.find((op: any) => op.type === "text" && op.text === label);
    const titleY = (value: Snapshot, app: string): number | undefined => text(value, app === profileId ? "Pocket Profile" : "Pocket Lobby")?.y;
    const wait = async (predicate: (value: Snapshot) => boolean, label: string, samples: Snapshot[] = []) => {
      const end = Date.now() + 7_000;
      let lastFrame = -1;
      while (Date.now() < end) {
        const value = await snapshot();
        assert.equal(value.status.state, "ready", `${label}: ${value.status.error}`);
        if (value.frame.frame !== lastFrame) { samples.push(value); lastFrame = value.frame.frame; }
        if (predicate(value)) return value;
        await Bun.sleep(16);
      }
      throw new Error(`timeout: ${label}`);
    };
    let pointer = 0;
    const click = async (x: number, y: number) => {
      const pointerId = pointer++;
      for (const phase of ["down", "up"]) await input({ type: "pointer", phase, id: pointerId, x, y });
    };
    const clickText = async (label: string) => {
      const value = await snapshot();
      const op = text(value, label);
      assert.ok(op, `missing button: ${label}`);
      await click(op.x + op.w / 2, op.y + op.h / 2);
    };
    const settled = async (app: string) => {
      const value = await wait(v => titleY(v, app) !== undefined && Math.abs(titleY(v, app)! - 9) < 0.1 &&
        session.rootRuntime.frame.ops.some((op: any) => op.type === "hostSurface" && op.id === app && op.focused), `${app} foreground`);
      await Bun.sleep(80);
      return snapshot();
    };
    const assertExit = (samples: Snapshot[], app: string, label: string) => {
      const positions = samples.map(v => titleY(v, app)).filter((y): y is number => y !== undefined);
      const intermediate = new Set(positions.filter(y => y > 30 && y < 820).map(y => Math.round(y)));
      assert.ok(intermediate.size >= 2, `${label} must publish reverse animation frames: ${positions.join(",")}`);
      for (let n = 1; n < positions.length; n += 1) assert.ok(positions[n]! >= positions[n - 1]! - 0.6, `${label} reverses toward the bottom: ${positions.join(",")}`);
    };

    await wait(v => !!text(v, "Open profile app"), "Showcase");
    await clickText("Open profile app");
    await settled(profileId);
    await clickText("Lin Mei (VIP 7)");
    await wait(v => !!text(v, "Lin Mei"), "selected profile state");
    const retainedRuntime = session.childRuntimes.get(profileId);
    assert.ok(retainedRuntime);

    for (const closeMode of ["button", "return", "programmatic"] as const) {
      await clickText("Save identity & open Lobby");
      const open = await settled(lobbyId);
      assert.equal(session.childRuntimes.get(profileId), retainedRuntime, "opening Lobby keeps the Profile runtime");
      assert.equal(titleY(open, profileId), 9, "covered Profile stays mounted at its settled position");
      const lobbyTexts = session.childRuntimes.get(lobbyId).frame.ops
        .filter((op: any) => op.type === "text").map((op: any) => op.text);
      assert.ok(lobbyTexts.includes("Lin Mei"), `Lobby reads the selected shared identity: ${lobbyTexts.join(" | ")}`);
      assert.ok(lobbyTexts.some((label: string) => label.includes("USR-LIN-1007")), "Lobby reads the selected account UID");
      const slots = session.rootRuntime.frame.ops.filter((op: any) => op.type === "hostSurface");
      assert.deepEqual(slots.map((op: any) => [op.id, op.focused]), [[profileId, false], [lobbyId, true]], "only the top mini app owns input");
      const samples: Snapshot[] = [open];
      if (closeMode === "button") await click(360, 30);
      else if (closeMode === "return") await clickText("Return visits to caller");
      else {
        const requestId = launches.get(lobbyId);
        assert.ok(requestId, "observe the actual launch token from the native response boundary");
        await session.enqueue(async () => {
          await session.dispatchSystemRequest(session.rootRuntime, "host-test-cancel", "platform.apps.cancel", { requestId }, 0);
          await session.tickNow(0);
        });
      }
      const resumed = await wait(v => titleY(v, lobbyId) === undefined && !!text(v, "Lin Mei") &&
        !session.childRuntimes.has(lobbyId) &&
        v.frame.ops.some((op: any) => op.type === "text" && op.text.includes("Profile remains available")) &&
        session.rootRuntime.frame.ops.some((op: any) => op.type === "hostSurface" && op.id === profileId && op.focused), `${closeMode} restores Profile`, samples);
      assertExit(samples, lobbyId, closeMode);
      assert.equal(session.childRuntimes.get(profileId), retainedRuntime, "dismissal does not recreate the lower mini app");
      assert.equal(titleY(resumed, profileId), 9, "resumed Profile does not replay its entry animation");
      assert.ok(text(resumed, "Lin Mei"), "selected profile survives every nested close path");
      assert.equal(session.childRuntimes.has(lobbyId), false, "only the dismissed runtime is destroyed");
    }
    const profileExit: Snapshot[] = [await snapshot()];
    await clickText("Return to Showcase");
    await wait(v => titleY(v, profileId) === undefined && !session.childRuntimes.has(profileId) &&
      v.frame.ops.some((op: any) => op.type === "text" && String(op.text).startsWith("App result:")), "explicit Profile return", profileExit);
    assertExit(profileExit, profileId, "parent return");
    await clickText("Open lobby app");
    await settled(lobbyId);
    const directLobbyTexts = session.childRuntimes.get(lobbyId).frame.ops
      .filter((op: any) => op.type === "text").map((op: any) => op.text);
    assert.ok(directLobbyTexts.includes("Lin Mei"), "direct Showcase launch reads the same saved identity without Profile launch props");
    await click(360, 30);
    await wait(v => !session.childRuntimes.has(lobbyId) && !!text(v, "Open profile app"), "direct Lobby cleanup");
  } finally {
    await reader?.cancel();
    await manager?.dispose();
    rmSync(output, { recursive: true, force: true });
  }
});
