import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "bun:test";
import { createPreviewManager } from "../preview.ts";

const repo = resolve(import.meta.dir, "../../..");
test("preview storage shares named buckets and isolates private app buckets", async () => {
  const manager = createPreviewManager({
    probePath: `${repo}/sdk/native/target/debug/pocket_probe`,
    projectDirectory: `${repo}/demo/js`, width: 390, height: 844,
    artifacts: { bytecode: `${repo}/demo/assets/app.qjbc`, pak: `${repo}/demo/assets/app.pak`, tickHz: 60 },
  });
  const id = "storage-scopes";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await manager.handle(new Request(`http://localhost/api/projects/${id}/preview/stream`), id, "stream");
    reader = response.body!.getReader();
    await reader.read();
    const session = (manager as any).sessions.get(id);
    const root = session.rootRuntime;
    let result: unknown;
    let error: any;
    session.sendHostResponse = async (_runtime: unknown, _id: string, _cap: string, value: unknown, failure: unknown) => {
      result = value; error = failure;
    };
    const request = async (appId: string, op: string, params: Record<string, unknown> = {}) => {
      await session.handleSystemRuntimeRequest(root, "storage-test", `system.storage.${op}`, { appId, ...params }, 0);
      assert.equal(error, undefined);
      return result;
    };
    const identity = { name: "Lin Mei", uid: "USR-LIN-1007" };
    await request("profile", "set", { namespace: "identity", key: "userInfo", value: identity });
    assert.deepEqual(await request("lobby", "get", { namespace: "identity", key: "userInfo" }), identity);
    assert.deepEqual(await request("lobby", "keys", { namespace: "identity" }), ["userInfo"]);
    assert.equal(await request("lobby", "get", { namespace: "other", key: "userInfo" }), null);
    await request("profile", "set", { key: "userInfo", value: { name: "Private" } });
    assert.equal(await request("lobby", "get", { key: "userInfo" }), null);
    assert.deepEqual(await request("profile", "keys"), ["userInfo"]);
    assert.deepEqual(await request("lobby", "keys"), []);
    await request("lobby", "remove", { namespace: "identity", key: "userInfo" });
    assert.equal(await request("profile", "get", { namespace: "identity", key: "userInfo" }), null);
    assert.deepEqual(await request("profile", "get", { key: "userInfo" }), { name: "Private" });

    await session.handleSystemRuntimeRequest(root, "batch-unavailable", "system.storage.batch", {
      appId: "profile",
      operations: [{ type: "set", key: "userInfo", value: { name: "Must not partially write" } }],
    }, 0);
    assert.equal(error.code, "system_runtime_error");
    assert.match(error.message, /unsupported system storage operation: batch/);
    error = undefined;
    assert.deepEqual(await request("profile", "get", { key: "userInfo" }), { name: "Private" });
    await session.handleSystemRuntimeRequest({ appId: "lobby" }, "denied", "system.storage.get", { appId: "profile", key: "userInfo" }, 0);
    assert.equal(error.code, "system_context_denied");
  } finally {
    await reader?.cancel();
    await manager.dispose();
  }
});
