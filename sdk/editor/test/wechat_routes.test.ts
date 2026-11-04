import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

test("Editor exposes local WeChat targets and guards mutation requests", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-wechat-route-"));
  const server = await startEditor({ port: 0, workspace });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const create = await fetch(`${origin}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-pocket-editor": "1" },
      body: JSON.stringify({ id: "wechat-guest", name: "Wechat guest", version: "0.1.0", tickHz: 60 }) });
    expect(create.status).toBe(201);
    const response = await fetch(`${origin}/api/projects/wechat-guest/wechat`);
    expect(response.status).toBe(200);
    const snapshot = await response.json() as any;
    expect(snapshot.targets.map((target: any) => target.id)).toEqual(["main"]);
    expect(snapshot.state.state).toBe("idle");
    const denied = await fetch(`${origin}/api/projects/wechat-guest/wechat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetId: "main" }) });
    expect(denied.status).toBe(403);
    const unknown = await fetch(`${origin}/api/projects/wechat-guest/wechat`, { method: "POST", headers: { "content-type": "application/json", "x-pocket-editor": "1" }, body: JSON.stringify({ targetId: "missing" }) });
    expect(unknown.status).toBe(400);
    const stopped = await fetch(`${origin}/api/projects/wechat-guest/wechat`, { method: "DELETE", headers: { "x-pocket-editor": "1" } });
    expect(stopped.status).toBe(200);
    expect((await stopped.json() as any).state.state).toBe("idle");
  } finally { server.stop(true); rmSync(workspace, { recursive: true, force: true }); }
});
