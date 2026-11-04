import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { startEditor } from "../server.ts";

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !headers.has("x-pocket-editor")) headers.set("x-pocket-editor", "1");
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, { ...init, headers });
  const type = response.headers.get("content-type") ?? "";
  return { response, value: type.includes("application/json") ? await response.json() : await response.text() };
}

test("SDK scope admission waits for another project's pending build", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "pocket-editor-scope-admission-"));
  const fixture = mkdtempSync(join(tmpdir(), "pocket-editor-scope-artifacts-"));
  const appJs = join(fixture, "app.js");
  const bytecode = join(fixture, "app.qjbc");
  const metadata = join(fixture, "app.bytecode.json");
  const pak = join(fixture, "app.pak");
  writeFileSync(appJs, "globalThis.__scope_admission = true;\n");
  writeFileSync(bytecode, Buffer.from([0x51, 0x4a, 0x42, 0x43, 1]));
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "scope-admission-fixture", bytecodeBytes: 5 }));
  writeFileSync(pak, pack([{ key: "fixture:scope-admission", dtype: 0, data: new Uint8Array([1, 2, 3]) }]));

  let releaseBuild!: () => void;
  let buildStarted!: () => void;
  const buildGate = new Promise<void>((resolve) => { releaseBuild = resolve; });
  const buildEntered = new Promise<void>((resolve) => { buildStarted = resolve; });
  const server = await startEditor({
    port: 0,
    workspace,
    buildRunner: async ({ id }) => {
      if (id === "alpha") {
        buildStarted();
        await buildGate;
      }
      return { appJs, bytecode, metadata, pak, runtimeAbi: "scope-admission-fixture", bytecodeMetadata: JSON.parse(await Bun.file(metadata).text()) };
    },
  });
  try {
    for (const id of ["alpha", "beta"]) {
      const created = await request(server, "/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: id, appId: `pocket.${id}`, version: "0.1.0", tickHz: 60 }),
      });
      expect(created.response.status).toBe(201);
    }

    const buildRequest = request(server, "/api/projects/alpha/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await buildEntered;
    const alphaStatus = await request(server, "/api/projects/alpha/status");
    expect(alphaStatus.value.busy).toBe(true);
    expect((await buildRequest).response.status).toBe(202);

    const denied = await request(server, "/api/projects/beta/codex/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "sdk", text: "update the fixed SDK" }),
    });
    expect(denied.response.status).toBe(409);
    expect(denied.value.error).toContain("SDK scope waits");

    releaseBuild();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await request(server, "/api/projects/alpha/status");
      if (!status.value.busy) break;
      await Bun.sleep(5);
    }
    const finished = await request(server, "/api/projects/alpha/status");
    expect(finished.value.busy).toBe(false);
    expect(finished.value.error).toBeUndefined();
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
