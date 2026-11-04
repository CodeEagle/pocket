import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

test("same-revision builds publish completed generations and block partial preview loads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-editor-build-generation-"));
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "cache-app", name: "cache-app", app: { entry: "app.tsx", framework: "solid" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "app.tsx"), "export {};\n");
  const appJs = join(directory, "app.js"), bytecode = join(directory, "app.qjbc"), metadata = join(directory, "app.bytecode.json"), pak = join(directory, "app.pak");
  const bytecodeMetadata = { entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-abi", bytecodeBytes: 4 };
  writeFileSync(appJs, "globalThis.fixture = true;"); writeFileSync(bytecode, "QJBC");
  writeFileSync(metadata, JSON.stringify(bytecodeMetadata)); writeFileSync(pak, "fixture");
  let release!: () => void;
  let gate = new Promise<void>(resolve => { release = resolve; });
  const server = await startEditor({ port: 0, projectRoot: project, workspace: join(directory, "workspace"), buildRunner: async () => {
    await gate; return { appJs, bytecode, metadata, pak, runtimeAbi: "fixture-abi", bytecodeMetadata };
  } });
  const base = `http://127.0.0.1:${server.port}/api/projects/cache-app`;
  const build = () => fetch(`${base}/build`, { method: "POST", headers: { "x-pocket-editor": "1", "content-type": "application/json" }, body: "{}" });
  const status = async () => { const x = await (await fetch(`${base}/status`)).json() as any; return x.status ?? x; };
  const completed = async () => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) { const x = await status(); if (!x.busy) return x; await Bun.sleep(10); }
    throw new Error("fixture build did not finish");
  };
  try {
    expect((await build()).status).toBe(202);
    expect((await fetch(`${base}/preview/stream`)).status).toBe(409);
    release(); const first = await completed();
    expect(first.error).toBeUndefined(); expect(typeof first.artifacts.generation).toBe("string");
    gate = new Promise<void>(resolve => { release = resolve; });
    expect((await build()).status).toBe(202);
    expect((await status()).artifacts.generation).toBe(first.artifacts.generation);
    expect((await fetch(`${base}/preview`)).status).toBe(409);
    release(); const second = await completed();
    expect(second.revision).toBe(first.revision);
    expect(second.artifacts.generation).not.toBe(first.artifacts.generation);
    const info = await (await fetch(`${base}/artifacts/build.json`)).json() as any;
    expect(info.generation).toBe(second.artifacts.generation);
  } finally { release(); server.stop(true); rmSync(directory, { recursive: true, force: true }); }
});
