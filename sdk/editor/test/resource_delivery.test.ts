import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packPak, extractBundleArchive, sha256Hex, verifySignedManifest } from "../../scripts/package_update.ts";
import { startEditor } from "../server.ts";

type EditorServer = ReturnType<typeof Bun.serve>;

function temporaryDirectory(prefix = "pocket-resource-delivery-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function request(server: EditorServer, path: string, init: RequestInit = {}): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
    headers.set("x-pocket-editor", "1");
  }
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { ...init, headers });
  const contentType = response.headers.get("content-type") || "";
  const value = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
  return { response, value };
}

async function waitForBuild(server: EditorServer, projectId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await request(server, `/api/projects/${encodeURIComponent(projectId)}/status`);
    const value = status.value?.status ?? status.value;
    if (!value.busy) return value;
    await Bun.sleep(80);
  }
  throw new Error(`resource build did not finish for ${projectId}`);
}

async function buildAndWait(server: EditorServer, projectId: string): Promise<any> {
  const started = await request(server, `/api/projects/${encodeURIComponent(projectId)}/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(started.response.status).toBe(202);
  return waitForBuild(server, projectId);
}

async function bumpSourceRevision(server: EditorServer, projectId: string, marker: string): Promise<void> {
  const source = await request(server, `/api/projects/${encodeURIComponent(projectId)}/source`);
  expect(source.response.status).toBe(200);
  const updated = await request(server, `/api/projects/${encodeURIComponent(projectId)}/source`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: `${source.value.source}\n// ${marker}\n` }),
  });
  expect(updated.response.status).toBe(200);
}

function publicKeyPem(publicKeyBase64: string): string {
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(publicKeyBase64, "base64"),
  ]);
  return createPublicKey({ key: der, format: "der", type: "spki" }).export({ format: "pem", type: "spki" }).toString();
}

function verifiedPayload(envelope: any, host: any): any {
  const keyId = host.config?.updates?.keyId ?? host.POCKET_UPDATE_KEY_ID;
  const publicKey = host.config?.updates?.publicKey ?? host.POCKET_UPDATE_PUBLIC_KEY;
  expect(envelope.keyId).toBe(keyId);
  expect(host.POCKET_UPDATE_PRIVATE_KEY).toBeUndefined();
  const payload = verifySignedManifest(envelope, publicKeyPem(publicKey));
  return JSON.parse(new TextDecoder().decode(payload));
}

function writePackageManifest(directory: string, id: string, name: string, output: string): void {
  writeFileSync(join(directory, "pocket.json"), JSON.stringify({
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id,
    name,
    title: name,
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
    app: {
      entry: "app.tsx",
      output,
      framework: "solid",
      viewport: { fixed: { logical: [360, 640], presentation: "native" } },
    },
  }, null, 2));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    protocolVersion: 1,
    capabilities: { requires: [], optional: [] },
  }, null, 2));
}

function createProjectFixture({ withSystem = true }: { withSystem?: boolean } = {}): {
  root: string;
  child: string;
  rootAppId: string;
  childAppId: string;
  projectId: string;
  rootAssets: string;
  rootAssetBytes: Uint8Array;
  rootPak: Uint8Array;
  runner: () => Promise<any>;
} {
  const root = temporaryDirectory("pocket-resource-project-");
  const child = join(root, "apps/child");
  const rootAppId = "pocket.delivery.root";
  const childAppId = "pocket.delivery.child";
  const projectId = "delivery-app";
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(child, { recursive: true });
  writePackageManifest(root, rootAppId, "delivery-root", "root-app");
  writePackageManifest(child, childAppId, "delivery-child", "child-app");
  writeFileSync(join(root, "app.tsx"), "export default function App(){ return <text value='root'/>; }\n");
  writeFileSync(join(child, "app.tsx"), "export default function App(){ return <text value='child'/>; }\n");
  const rootAssetBytes = Uint8Array.from([1, 2, 3, 4, 5]);
  writeFileSync(join(root, "assets/foo.bin"), rootAssetBytes);
  writeFileSync(join(root, "editor.json"), JSON.stringify({
    id: projectId,
    appId: rootAppId,
    name: "Delivery App",
    title: "Delivery App",
    version: "0.1.0",
    build: 1,
    tickHz: 60,
    entry: "app.tsx",
    output: "root-app",
    framework: "solid",
  }, null, 2));
  if (withSystem) {
    writeFileSync(join(root, "pocket.system.json"), JSON.stringify({
      $schema: "https://pocketjs.dev/schema/pocket-system-1.json",
      pocketSystem: 1,
      id: "pocket.delivery.system",
      name: "delivery-system",
      title: "Delivery System",
      version: "0.1.0",
      roles: { systemUI: rootAppId },
      applications: {
        installPolicy: { model: "managed", mutable: false },
        backgroundExecution: "suspend",
        catalog: [
          { package: rootAppId, manifest: "pocket.json", required: true },
          { package: childAppId, manifest: "apps/child/pocket.json", required: true },
        ],
      },
      installation: { installedPackages: [rootAppId, childAppId] },
    }, null, 2));
  }
  const fixture = join(root, ".pocket-build", "runner");
  mkdirSync(fixture, { recursive: true });
  const appJs = join(fixture, "app.js");
  const bytecode = join(fixture, "app.qjbc");
  const metadata = join(fixture, "app.bytecode.json");
  const pak = join(fixture, "app.pak");
  writeFileSync(appJs, "globalThis.__delivery_root = true;\n");
  writeFileSync(bytecode, Buffer.from("root-fixture-qjbc"));
  const rootPak = packPak([
    { key: "ui:font.required", dtype: 0, data: Uint8Array.from([1, 2, 3]) },
    { key: "ui:img.hero", dtype: 0, data: Uint8Array.from([4, 5, 6, 7]) },
    { key: "runtime.styles", dtype: 0, data: Uint8Array.from([8, 9]) },
  ]);
  writeFileSync(pak, rootPak);
  const bytecodeMetadata = {
    entryFormat: "quickjs-bytecode",
    runtimeAbi: "delivery-fixture-abi",
    bytecodeBytes: readFileSync(bytecode).byteLength,
    version: "0.1.0",
    build: 1,
  };
  writeFileSync(metadata, JSON.stringify(bytecodeMetadata));
  return {
    root,
    child,
    rootAppId,
    childAppId,
    projectId,
    rootAssets: join(root, "assets"),
    rootAssetBytes,
    rootPak,
    runner: async () => ({
      appJs,
      bytecode,
      metadata,
      pak,
      runtimeAbi: "delivery-fixture-abi",
      bytecodeMetadata,
    }),
  };
}

test("resource delivery catalogs a real child, signs selected network resources, and preserves the full PAK", async () => {
  const fixture = createProjectFixture();
  const workspace = temporaryDirectory("pocket-resource-workspace-");
  const server = await startEditor({ port: 0, workspace, projectRoot: fixture.root, buildRunner: fixture.runner });
  try {
    const base = `/api/projects/${fixture.projectId}`;
    const initial = await request(server, `${base}/resources`);
    expect(initial.response.status, JSON.stringify(initial.value)).toBe(200);
    expect(initial.value.packages.map((pkg: any) => pkg.id)).toEqual([fixture.rootAppId, fixture.childAppId]);
    expect(initial.value.packages.every((pkg: any) => pkg.resources.length === 0)).toBe(true);

    const firstStatus = await buildAndWait(server, fixture.projectId);
    expect(firstStatus.error).toBeUndefined();
    expect(firstStatus.builtRevision).toBe(firstStatus.revision);
    const inventory = await request(server, `${base}/resources`);
    expect(inventory.response.status).toBe(200);
    const rootPackage = inventory.value.packages.find((pkg: any) => pkg.id === fixture.rootAppId);
    const childPackage = inventory.value.packages.find((pkg: any) => pkg.id === fixture.childAppId);
    expect(rootPackage.resources.length).toBeGreaterThanOrEqual(3);
    expect(childPackage.resources.length).toBeGreaterThan(0);
    const image = rootPackage.resources.find((resource: any) => resource.key === "pak:ui:img.hero");
    const asset = rootPackage.resources.find((resource: any) => resource.key === "asset:assets/foo.bin");
    const locked = rootPackage.resources.find((resource: any) => resource.key === "pak:ui:font.required");
    expect(image).toMatchObject({ kind: "pak", placement: "pak" });
    expect(asset).toMatchObject({ kind: "asset", placement: "pak" });
    expect(locked).toMatchObject({ key: "pak:ui:font.required", placement: "pak", locked: true });

    const selected = await request(server, `${base}/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        revision: inventory.value.revision,
        packageId: fixture.rootAppId,
        placements: [
          { key: "pak:ui:img.hero", placement: "network" },
          { key: "asset:assets/foo.bin", placement: "network" },
        ],
      }),
    });
    expect(selected.response.status).toBe(200);
    expect(selected.value.revision).toBe(inventory.value.revision + 1);
    expect(selected.value.packages.find((pkg: any) => pkg.id === fixture.rootAppId).resources.find((resource: any) => resource.key === "pak:ui:img.hero").placement).toBe("network");
    expect(selected.value.packages.find((pkg: any) => pkg.id === fixture.rootAppId).resources.find((resource: any) => resource.key === "asset:assets/foo.bin").placement).toBe("network");

    const stale = await request(server, `${base}/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: inventory.value.revision, packageId: fixture.rootAppId, placements: [] }),
    });
    expect(stale.response.status).toBe(409);
    const lockedPut = await request(server, `${base}/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: selected.value.revision, packageId: fixture.rootAppId, placements: [{ key: locked.key, placement: "network" }] }),
    });
    expect(lockedPut.response.status).toBe(400);
    const unknownPut = await request(server, `${base}/resources`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: selected.value.revision, packageId: fixture.rootAppId, placements: [{ key: "asset:assets/missing.bin", placement: "network" }] }),
    });
    expect(unknownPut.response.status).toBe(400);

    const rebuilt = await buildAndWait(server, fixture.projectId);
    expect(rebuilt.error).toBeUndefined();
    expect(rebuilt.builtRevision).toBe(rebuilt.revision);
    const pakResponse = await request(server, `${base}/artifacts/app.pak`);
    expect(pakResponse.response.status).toBe(200);
    const finalPak = new Uint8Array(pakResponse.value);
    writeFileSync(join(fixture.rootAssets, "foo.bin"), Uint8Array.from([99, 98, 97]));

    const published = await request(server, `${base}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(published.response.status).toBe(200);
    expect(published.value.packages).toHaveLength(1);
    const rootHost = await request(server, `/updates/${fixture.projectId}/host.json`);
    const rootLatest = await request(server, `/updates/${fixture.projectId}/latest.json`);
    expect(rootHost.response.status).toBe(200);
    expect(rootLatest.response.status).toBe(200);
    const rootPayload = verifiedPayload(rootLatest.value, rootHost.value);
    expect(rootPayload.appId).toBe(fixture.rootAppId);
    expect(rootPayload.pak.sha256).toBe(sha256Hex(finalPak));
    expect(rootPayload.assets["assets/foo.bin"].sha256).toBe(sha256Hex(fixture.rootAssetBytes));
    const selectedImageHash = rootPayload.pak.parts.find((part: any) => part.key === "ui:img.hero").sha256;
    const selectedAssetHash = rootPayload.assets["assets/foo.bin"].sha256;
    expect(rootPayload.bundle.blobs).not.toContain(selectedImageHash);
    expect(rootPayload.bundle.blobs).not.toContain(selectedAssetHash);
    const bundlePath = rootPayload.bundle.url.startsWith("/") ? rootPayload.bundle.url : `/updates/${fixture.projectId}/${rootPayload.bundle.url}`;
    const bundle = await request(server, bundlePath);
    expect(bundle.response.status).toBe(200);
    const bundleEntries = extractBundleArchive(new Uint8Array(bundle.value), 768 * 1024 * 1024, rootPayload.bundle.format);
    expect(bundleEntries.has(`blobs/${selectedImageHash}`)).toBe(false);
    expect(bundleEntries.has(`blobs/${selectedAssetHash}`)).toBe(false);

    const childLink = published.value.packages[0];
    const childHost = await request(server, childLink.hostConfigUrl);
    const childLatest = await request(server, childLink.updateUrl);
    expect(childHost.response.status).toBe(200);
    expect(childLatest.response.status).toBe(200);
    const childPayload = verifiedPayload(childLatest.value, childHost.value);
    expect(childPayload.appId).toBe(fixture.childAppId);
    expect(childHost.value.kind).toBe("pocket-mini-app-host-template");
    expect(childHost.value.requiresLocalBootstrap).toBe(true);
    expect(childHost.value.config.downloadOnOpen).toBe(true);
    expect(childHost.value.config.appId).toBe(fixture.childAppId);
    expect(childHost.value.config.updates.namespace).toMatch(/^[A-Za-z0-9_-]+$/);
    const bootstrap = childHost.value.bootstrapAssets[childHost.value.config.metadataAsset];
    const bootstrapResponse = await fetch(bootstrap.url);
    expect(bootstrapResponse.status).toBe(200);
    const bootstrapBytes = new Uint8Array(await bootstrapResponse.arrayBuffer());
    expect(bootstrapBytes.length).toBe(bootstrap.size);
    expect(sha256Hex(bootstrapBytes)).toBe(bootstrap.sha256);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 180_000);

test("failed resource rebuilds reject symlink and unknown policy inputs without replacing the last snapshot", async () => {
  const fixture = createProjectFixture({ withSystem: false });
  const workspace = temporaryDirectory("pocket-resource-failure-workspace-");
  const server = await startEditor({ port: 0, workspace, projectRoot: fixture.root, buildRunner: fixture.runner });
  try {
    const base = `/api/projects/${fixture.projectId}`;
    const firstStatus = await buildAndWait(server, fixture.projectId);
    expect(firstStatus.error).toBeUndefined();
    const previous = await request(server, `${base}/resources`);
    const previousPackages = JSON.stringify(previous.value.packages);
    const outside = join(workspace, "outside.bin");
    writeFileSync(outside, Buffer.from([7, 7, 7]));
    symlinkSync(outside, join(fixture.rootAssets, "link.bin"));
    await bumpSourceRevision(server, fixture.projectId, "symlink rebuild");
    const failedSymlink = await buildAndWait(server, fixture.projectId);
    expect(failedSymlink.error).toMatch(/asset symlink|symbolic links are not allowed/);
    expect(failedSymlink.builtRevision).toBe(firstStatus.builtRevision);
    const afterSymlink = await request(server, `${base}/resources`);
    expect(JSON.stringify(afterSymlink.value.packages)).toBe(previousPackages);
    rmSync(join(fixture.rootAssets, "link.bin"), { force: true });

    writeFileSync(join(fixture.root, "pocket.resources.json"), JSON.stringify({
      version: 1,
      packages: { [fixture.rootAppId]: { network: ["asset:assets/missing.bin"] } },
    }, null, 2));
    await bumpSourceRevision(server, fixture.projectId, "unknown policy rebuild");
    const failedPolicy = await buildAndWait(server, fixture.projectId);
    expect(failedPolicy.error).toMatch(/unknown resource|references unknown/);
    expect(failedPolicy.builtRevision).toBe(firstStatus.builtRevision);
    // Clear the invalid source policy before reading the inventory. The
    // failed build must not have replaced the immutable successful snapshot;
    // a malformed current policy is independently rejected by GET.
    rmSync(join(fixture.root, "pocket.resources.json"), { force: true });
    const afterPolicy = await request(server, `${base}/resources`);
    expect(JSON.stringify(afterPolicy.value.packages), JSON.stringify(afterPolicy.value)).toBe(previousPackages);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, 120_000);
