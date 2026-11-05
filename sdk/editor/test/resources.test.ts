import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packPak } from "../../scripts/package_update.ts";
import { startEditor } from "../server.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-resources-"));
}

async function waitForBuild(base: string): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/status`);
    const value = await response.json() as any;
    const status = value.status ?? value;
    if (!status.busy) return status;
    await Bun.sleep(20);
  }
  throw new Error("resource fixture build did not finish");
}

test("Editor exposes catalog resources, validates placements, and snapshots policy revisions", async () => {
  const directory = temporaryDirectory();
  const project = join(directory, "project");
  mkdirSync(join(project, "assets"), { recursive: true });
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    pocket: 2,
    id: "resource-app",
    name: "resource-app",
    version: "0.1.0",
    app: { entry: "app.tsx", framework: "solid" },
  }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(project, "app.tsx"), "export default function App(){ return <text value='resources'/>; }\n");
  writeFileSync(join(project, "assets", "poster.bin"), Buffer.from([1, 2, 3, 4]));
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>';
  writeFileSync(join(project, "assets", "poster.svg"), image);
  writeFileSync(join(project, "extra.svg"), image);
  const artifactRoot = join(directory, "runner");
  mkdirSync(artifactRoot);
  const appJs = join(artifactRoot, "app.js");
  const bytecode = join(artifactRoot, "app.qjbc");
  const metadata = join(artifactRoot, "app.bytecode.json");
  const pak = join(artifactRoot, "app.pak");
  writeFileSync(appJs, "globalThis.resourceFixture = true;\n");
  writeFileSync(bytecode, Buffer.from("fixture-bytecode"));
  const packed = packPak([
    { key: "ui:font.body", dtype: 0, data: new Uint8Array([1, 2, 3]) },
    { key: "ui:img.hero", dtype: 0, data: new Uint8Array([4, 5, 6, 7]) },
    { key: "ui:img.extra.svg", dtype: 0, data: new Uint8Array([4, 5, 6, 7]) },
    { key: "runtime.styles", dtype: 0, data: new Uint8Array([8, 9]) },
  ]);
  writeFileSync(pak, packed);
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-abi", bytecodeBytes: 16, version: "0.1.0", build: 1 }));

  const server = await startEditor({
    port: 0,
    projectRoot: project,
    workspace: join(directory, "workspace"),
    buildRunner: async () => ({
      appJs,
      bytecode,
      metadata,
      pak,
      runtimeAbi: "fixture-abi",
      bytecodeMetadata: { entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-abi", bytecodeBytes: 16, version: "0.1.0", build: 1 },
    }),
  });
  const base = `http://127.0.0.1:${server.port}/api/projects/resource-app`;
  const headers = { "x-pocket-editor": "1", "content-type": "application/json" };
  try {
    const initial = await (await fetch(`${base}/resources`)).json() as any;
    expect(initial.revision).toBe(1);
    expect(initial.packages).toEqual([{ id: "resource-app", title: "resource-app", manifest: "pocket.json", resources: [] }]);

    expect((await fetch(`${base}/build`, { method: "POST", headers, body: "{}" })).status).toBe(202);
    const built = await waitForBuild(base);
    expect(built.error).toBeUndefined();
    const inventory = await (await fetch(`${base}/resources`)).json() as any;
    const resources = inventory.packages[0].resources;
    expect(resources.find((item: any) => item.key === "pak:ui:img.hero")).toMatchObject({ kind: "pak", bytes: 4, placement: "pak" });
    expect(resources.find((item: any) => item.key === "asset:assets/poster.bin")).toMatchObject({ kind: "asset", bytes: 4, placement: "pak" });
    expect(resources.find((item: any) => item.key === "pak:ui:font.body")).toMatchObject({ locked: true, placement: "pak" });
    const previewUrl = resources.find((item: any) => item.key === "asset:assets/poster.svg").previewUrl;
    const origin = `http://127.0.0.1:${server.port}`;
    const preview = await fetch(origin + previewUrl);
    expect(preview.headers.get("content-type")).toBe("image/svg+xml");
    expect(preview.headers.get("content-security-policy")).toContain("sandbox");
    expect(await preview.text()).toBe(image);
    writeFileSync(join(project, "assets", "poster.svg"), "changed after build");
    expect(await (await fetch(origin + previewUrl)).text()).toBe(image);
    const pakPreviewUrl = resources.find((item: any) => item.key === "pak:ui:img.extra.svg").previewUrl;
    writeFileSync(join(project, "extra.svg"), "changed after build");
    expect(await (await fetch(origin + pakPreviewUrl)).text()).toBe(image);
    expect((await fetch(origin + previewUrl.replace("revision=1", "revision=99"))).status).toBe(404);
    expect((await fetch(origin + previewUrl.replace("asset%3Aassets%2Fposter.svg", "asset%3A..%2Fsecret.svg"))).status).toBe(404);

    // Persisted builds from before resource inventory was introduced must
    // still expose the actual catalog, rather than failing with artifact 404.
    const snapshotPath = join(directory, "workspace", "builds", "resource-app", String(built.builtRevision), "resources.json");
    const snapshotBytes = readFileSync(snapshotPath);
    rmSync(snapshotPath);
    try {
      const legacyResponse = await fetch(`${base}/resources`);
      expect(legacyResponse.status).toBe(200);
      const legacy = await legacyResponse.json() as any;
      expect(legacy.packages).toEqual(initial.packages);
      expect(legacy.builtRevision).toBeUndefined();
    } finally {
      writeFileSync(snapshotPath, snapshotBytes);
    }

    const selected = await fetch(`${base}/resources`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: inventory.revision, packageId: "resource-app", placements: [
        { key: "pak:ui:img.hero", placement: "network" },
        { key: "asset:assets/poster.bin", placement: "network" },
      ] }),
    });
    expect(selected.status).toBe(200);
    const changed = await selected.json() as any;
    expect(changed.revision).toBe(2);
    expect(changed.packages[0].resources.find((item: any) => item.key === "pak:ui:img.hero").placement).toBe("network");
    expect(changed.packages[0].resources.find((item: any) => item.key === "asset:assets/poster.bin").placement).toBe("network");
    expect(JSON.parse(readFileSync(join(project, "pocket.resources.json"), "utf8")).packages["resource-app"].network).toEqual([
      "asset:assets/poster.bin",
      "pak:ui:img.hero",
    ]);

    const locked = await fetch(`${base}/resources`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ revision: changed.revision, packageId: "resource-app", placements: [{ key: "pak:ui:font.body", placement: "network" }] }),
    });
    expect(locked.status).toBe(400);
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
