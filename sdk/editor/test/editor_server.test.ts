import { expect, test } from "bun:test";
import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { startEditor } from "../server.ts";
import { verifySignedManifest } from "../../scripts/package_update.ts";

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-service-"));
}

async function unauthenticatedRequest(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, init);
  const contentType = response.headers.get("content-type") || "";
  const value = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
  return { response, value };
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const method = (init?.method ?? "GET").toUpperCase();
  const mutatingMethods = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  const headers = new Headers(init?.headers);
  if (mutatingMethods.has(method) && !headers.has("x-pocket-editor") && !headers.has("x-pocket-csrf")) {
    headers.set("x-pocket-editor", "1");
  }
  return unauthenticatedRequest(server, path, { ...init, headers });
}

test("editor service creates, edits, builds, and publishes a signed qjbc project", async () => {
  const workspace = temporaryWorkspace();
  const fixture = temporaryWorkspace();
  const appJs = join(fixture, "app.js");
  const bytecode = join(fixture, "app.qjbc");
  const metadata = join(fixture, "app.bytecode.json");
  const pak = join(fixture, "app.pak");
  writeFileSync(appJs, "globalThis.__pocket_editor_fixture = true;\n");
  writeFileSync(bytecode, Buffer.from([0x51, 0x4a, 0x42, 0x43, 1, 2, 3]));
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-abi-v1", bytecodeBytes: 7 }));
  writeFileSync(pak, pack([{ key: "fixture:text", dtype: 0, data: new Uint8Array([1, 2, 3, 4]) }]));
  const server = await startEditor({
    port: 0,
    updateHost: "127.0.0.1",
    updatePort: 0,
    updateHostVersion: "3.2.0",
    workspace,
    buildRunner: async ({ log }) => {
      log("fixture compiler: real runner is injected only by this service test");
      return { appJs, bytecode, metadata, pak, runtimeAbi: "fixture-abi-v1", bytecodeMetadata: JSON.parse(await Bun.file(metadata).text()) };
    },
  });
  try {
    const index = await request(server, "/");
    expect(index.response.status).toBe(200);
    expect(index.response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(new TextDecoder().decode(new Uint8Array(index.value))).toContain("Pocket");
    const editorScript = await request(server, "/editor.js");
    expect(editorScript.response.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(editorScript.value))).toContain("publishProject");
    const health = await request(server, "/health");
    expect(health.response.status).toBe(200);
    expect(health.value.ok).toBe(true);

    const created = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "fixture-app", name: "Fixture App", version: "0.1.0", tickHz: 60 }),
    });
    expect(created.response.status).toBe(201);
    expect(created.value.entry).toBe("app.tsx");
    expect(created.value.appId).toBe("pocket.host.demo");
    expect(created.value.status.revision).toBe(1);

    const source = await request(server, "/api/projects/fixture-app/source");
    expect(source.response.status).toBe(200);
    expect(source.value.source).toContain("PocketJS");

    // The editor starter deliberately contains only the shared page source;
    // projects may add an optional UI compatibility entry themselves.
    const projectDir = join(workspace, "projects/fixture-app");
    mkdirSync(join(projectDir, "ui"), { recursive: true });
    writeFileSync(join(projectDir, "ui/index.tsx"), 'export * from "@pocket/ui";\n');
    const files = await request(server, "/api/projects/fixture-app/files");
    expect(files.response.status).toBe(200);
    expect(files.value.files.map((file: { path: string }) => file.path)).toContain("ui/index.tsx");
    const uiFile = await request(server, "/api/projects/fixture-app/files/ui/index.tsx");
    expect(uiFile.response.status).toBe(200);
    expect(uiFile.value.content).toContain("@pocket/ui");
    const editedUi = await request(server, "/api/projects/fixture-app/files/ui/index.tsx", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${uiFile.value.content}\n// editor file API mutation\n` }),
    });
    expect(editedUi.response.status).toBe(200);
    expect(editedUi.value.revision).toBe(2);
    const traversal = await request(server, "/api/projects/fixture-app/files/%2E%2E%2Feditor.json", {
      method: "GET",
    });
    expect(traversal.response.status).toBe(400);
    mkdirSync(join(projectDir, "ui/link-target"), { recursive: true });
    symlinkSync(join(projectDir, "app.tsx"), join(projectDir, "ui/link.tsx"));
    const symlink = await request(server, "/api/projects/fixture-app/files/ui/link.tsx");
    expect(symlink.response.status).toBe(400);
    // The build input policy rejects source symlinks as well; remove this
    // read-boundary fixture before exercising the normal build flow below.
    rmSync(join(projectDir, "ui/link.tsx"), { force: true });
    const protectedFile = await request(server, "/api/projects/fixture-app/files/editor-state.json");
    expect(protectedFile.response.status).toBe(400);
    const privatePath = await request(server, "/api/projects/fixture-app/files/keys/private.json", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "do not write keys" }),
    });
    expect(privatePath.response.status).toBe(400);

    const edited = await request(server, "/api/projects/fixture-app/source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: `${source.value.source}\n// editor test mutation\n` }),
    });
    expect(edited.response.status).toBe(200);
    expect(edited.value.revision).toBe(3);

    const invalidSource = await request(server, "/api/projects/fixture-app/source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "bad\u0000source" }),
    });
    expect(invalidSource.response.status).toBe(400);

    const build = await request(server, "/api/projects/fixture-app/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(build.response.status).toBe(202);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await request(server, "/api/projects/fixture-app/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = await request(server, "/api/projects/fixture-app/status");
    expect(status.value.error).toBeUndefined();
    expect(status.value.builtRevision).toBe(status.value.revision);
    expect(status.value.artifacts.bytecode).toContain("app.qjbc");

    const firstManifest = await request(server, "/api/projects/fixture-app/artifacts/guest-manifest.json");
    expect(firstManifest.response.status).toBe(200);
    expect(firstManifest.value.version).toBe("0.1.0");
    expect(firstManifest.value.build).toBe(1);
    expect(firstManifest.value.capabilities.requires).toContain("text.glyphs.baked");

    const updatedConfig = await request(server, "/api/projects/fixture-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.host.demo", name: "Fixture App", version: "0.2.0", build: 2, tickHz: 60 }),
    });
    expect(updatedConfig.response.status).toBe(200);
    const secondBuild = await request(server, "/api/projects/fixture-app/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(secondBuild.response.status).toBe(202);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const nextStatus = await request(server, "/api/projects/fixture-app/status");
      if (!nextStatus.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const secondManifest = await request(server, "/api/projects/fixture-app/artifacts/guest-manifest.json");
    expect(secondManifest.response.status).toBe(200);
    expect(secondManifest.value.version).toBe("0.2.0");
    expect(secondManifest.value.build).toBe(2);
    expect(secondManifest.value.capabilities.requires).toContain("text.glyphs.baked");

    const artifact = await request(server, "/api/projects/fixture-app/artifacts/app.qjbc");
    expect(artifact.response.status).toBe(200);
    expect(new Uint8Array(artifact.value)).toEqual(new Uint8Array([0x51, 0x4a, 0x42, 0x43, 1, 2, 3]));

    const finalStatus = await request(server, "/api/projects/fixture-app/status");
    const buildRevDir = join(workspace, "builds/fixture-app", String(finalStatus.value.builtRevision));
    writeFileSync(join(buildRevDir, "app.worker.qjbc"), Buffer.from([0x51, 0x4a, 0x42, 0x43, 9, 9, 9]));
    writeFileSync(join(buildRevDir, "app.worker.bytecode.json"), JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-abi-v1", bytecodeBytes: 7 }));
    const workerQjbc = await request(server, "/api/projects/fixture-app/artifacts/app.worker.qjbc");
    expect(workerQjbc.response.status).toBe(200);
    expect(new Uint8Array(workerQjbc.value)).toEqual(new Uint8Array([0x51, 0x4a, 0x42, 0x43, 9, 9, 9]));
    const workerMeta = await request(server, "/api/projects/fixture-app/artifacts/app.worker.bytecode.json");
    expect(workerMeta.response.status).toBe(200);
    expect(workerMeta.value.runtimeAbi).toBe("fixture-abi-v1");
    const rejectedArtifact = await request(server, "/api/projects/fixture-app/artifacts/not-allowed.txt");
    expect(rejectedArtifact.response.status).toBe(404);
    rmSync(join(buildRevDir, "app.worker.qjbc"));
    rmSync(join(buildRevDir, "app.worker.bytecode.json"));

    const published = await request(server, "/api/projects/fixture-app/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(published.response.status).toBe(200);
    expect(published.value.status.publish.runtimeAbi).toBe("fixture-abi-v1");
    expect(published.value.manifestUrl).toContain("/stable/pocket/3.2.0/pocket.host.demo/0.2.0/latest.json");
    expect(published.value.hostConfigUrl).toContain("/pocket/3.2.0/pocket.host.demo/0.2.0/host.json");
    expect((await fetch(published.value.manifestUrl)).status).toBe(200);
    const canonicalLatest = await request(server, "/pocket/3.2.0/pocket.host.demo/stable/latest.json");
    expect(canonicalLatest.response.status).toBe(200);
    const latest = await request(server, "/updates/fixture-app/latest.json");
    expect(latest.response.status).toBe(200);
    const envelope = latest.value;
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(payload.entryFormat).toBe("quickjs-bytecode");
    expect(payload.appId).toBe("pocket.host.demo");
    expect(payload.runtimeAbi).toBe("fixture-abi-v1");
    const hostConfig = await request(server, "/updates/fixture-app/host.json");
    expect(hostConfig.response.status).toBe(200);
    expect(hostConfig.value.POCKET_UPDATE_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stable$/);
    expect(hostConfig.value.POCKET_HOST_VERSION).toBe("3.2.0");
    expect(hostConfig.value.POCKET_PACKAGE_VERSION).toBe("0.2.0");
    expect(hostConfig.value.POCKET_UPDATE_KEY_ID).toBe(envelope.keyId);
    expect(Buffer.from(hostConfig.value.POCKET_UPDATE_PUBLIC_KEY, "base64")).toHaveLength(32);
    const releaseVersions = await request(server, "/api/projects/fixture-app/versions");
    expect(releaseVersions.response.status).toBe(200);
    expect(releaseVersions.value.hostVersion).toBe("3.2.0");
    expect(releaseVersions.value.slots.find((slot: any) => slot.name === "stable").packages[0]).toMatchObject({
      id: "pocket.host.demo", version: "0.2.0", build: 2,
    });
    expect(releaseVersions.value.history).toHaveLength(1);
    expect(releaseVersions.value.history[0]).toMatchObject({ channel: "release", slot: "stable", version: "0.2.0", build: 2 });
    expect(releaseVersions.value.appConfigUrl).toContain("/stable/pocket/3.2.0/pocket.host.demo/latest.json");
    const packageIndex = await request(server, new URL(releaseVersions.value.appConfigUrl).pathname);
    expect(packageIndex.response.status).toBe(200);
    expect(packageIndex.value.kind).toBe("pocket-editor-package-index");
    expect(packageIndex.value.latest.releaseId).toBe(releaseVersions.value.history[0].releaseId);
    expect(packageIndex.value.versions[0].payloadSha256).toBe(releaseVersions.value.history[0].payloadSha256);
    const stableHistoryPackage = releaseVersions.value.history[0].packages.find((pkg: any) => pkg.id === "pocket.host.demo");
    expect(stableHistoryPackage.manifestUrl).toContain(`/pocket/3.2.0/pocket.host.demo/${releaseVersions.value.history[0].releaseId}/latest.json`);
    expect((await fetch(stableHistoryPackage.manifestUrl)).status).toBe(200);
    const immutableHistoryHost = await (await fetch(stableHistoryPackage.hostConfigUrl)).json();
    expect(immutableHistoryHost.POCKET_PACKAGE_VERSION).toBe(releaseVersions.value.history[0].releaseId);
    expect(immutableHistoryHost.POCKET_UPDATE_BASE_URL).toMatch(/\/stable$/);
    const immutableHostPath = new URL(stableHistoryPackage.hostConfigUrl).pathname;
    const loopbackHost = await (await fetch(`http://127.0.0.1:${server.port}${immutableHostPath}`)).json();
    const aliasHost = await (await fetch(`http://localhost:${server.port}${immutableHostPath}`)).json();
    expect(new URL(loopbackHost.applications["pocket.host.demo"].manifestUrl).origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(new URL(aliasHost.applications["pocket.host.demo"].manifestUrl).origin).toBe(`http://localhost:${server.port}`);
    expect(loopbackHost.release.releaseId).toBe(aliasHost.release.releaseId);
    const immutableArchive = await request(server, `/releases/fixture-app/${releaseVersions.value.history[0].releaseId}.tar.gz`);
    expect(immutableArchive.response.status).toBe(200);
    expect(new Uint8Array(immutableArchive.value).byteLength).toBeGreaterThan(100);
    const brokenBytecodePath = join(buildRevDir, "app.qjbc");
    const brokenBytecode = readFileSync(brokenBytecodePath);
    rmSync(brokenBytecodePath);
    const failedPublish = await request(server, "/api/projects/fixture-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(failedPublish.response.status).toBe(400);
    const preservedLatest = await request(server, "/pocket/3.2.0/pocket.host.demo/stable/latest.json");
    expect(JSON.parse(Buffer.from(preservedLatest.value.payload, "base64").toString("utf8")).build).toBe(2);
    writeFileSync(brokenBytecodePath, brokenBytecode);
    const archive = await request(server, "/releases/fixture-app.tar.gz");
    expect(archive.response.status).toBe(200);
    expect(new Uint8Array(archive.value).byteLength).toBeGreaterThan(100);
    // Test publishing must remain admissible after an embedded build or a
    // previous test package, while preserving the consumer's release config.
    let firstTestEntryUrl = "";
    for (const expectedBuild of [3, 4]) {
      const testing = await request(server, "/api/projects/fixture-app/publish", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "test" }),
      });
      expect(testing.response.status).toBe(200);
      expect(testing.value.status.publish.build).toBe(expectedBuild);
      expect(testing.value.manifestUrl).toContain("/test/pocket/3.2.0/pocket.host.demo/0.2.0/latest.json");
      expect((await fetch(testing.value.manifestUrl)).status).toBe(200);
      const signed = (await request(server, "/updates/fixture-app/latest.json")).value;
      const publicPem = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(hostConfig.value.POCKET_UPDATE_PUBLIC_KEY, "base64")]), format: "der", type: "spki" }).export({ format: "pem", type: "spki" });
      const verified = JSON.parse(new TextDecoder().decode(verifySignedManifest(signed, publicPem)));
      expect(verified.build).toBe(expectedBuild);
      expect(verified.version).toBe(`0.2.0-test.${expectedBuild}`);
      expect(verified.entry.sha256).toBe(payload.entry.sha256);
      if (expectedBuild === 3) firstTestEntryUrl = new URL(`/test/pocket/3.2.0/pocket.host.demo/0.2.0/blobs/${verified.entry.sha256}`, testing.value.manifestUrl).toString();
    }
    expect((await fetch(firstTestEntryUrl)).status).toBe(200);
    const testVersions = await request(server, "/api/projects/fixture-app/versions");
    expect(testVersions.value.slots.find((slot: any) => slot.name === "test").packages[0]).toMatchObject({
      id: "pocket.host.demo", version: "0.2.0-test.4", build: 4,
    });
    expect(testVersions.value.history).toHaveLength(3);
    const oldStableManifest = testVersions.value.history.find((entry: any) => entry.slot === "stable").packages[0].manifestUrl;
    expect((await fetch(oldStableManifest)).status).toBe(200);
    const statePath = join(workspace, "states/fixture-app.json");
    const counterPath = join(workspace, "states/fixture-app-test-release.json");
    const historyPath = join(workspace, "states/fixture-app.versions.json");
    const beforeOfflineState = readFileSync(statePath);
    const beforeOfflineCounter = readFileSync(counterPath);
    const beforeOfflineHistory = readFileSync(historyPath);
    const offlinePackage = await request(server, "/api/projects/fixture-app/package-offline", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(offlinePackage.response.status).toBe(200);
    expect(offlinePackage.value.filename).toMatch(/^offline-fixture-app-/);
    const offlineArchive = await request(server, offlinePackage.value.archiveUrl);
    expect(offlineArchive.response.status).toBe(200);
    expect(offlineArchive.response.headers.get("content-disposition")).toContain(offlinePackage.value.filename);
    expect(new Uint8Array(offlineArchive.value).byteLength).toBeGreaterThan(100);
    expect(readFileSync(statePath)).toEqual(beforeOfflineState);
    expect(readFileSync(counterPath)).toEqual(beforeOfflineCounter);
    expect(readFileSync(historyPath)).toEqual(beforeOfflineHistory);
    const downloadsDirectory = join(workspace, "updates/.downloads/fixture-app");
    const downloadsBeforeFailure = readdirSync(downloadsDirectory).sort();
    rmSync(brokenBytecodePath);
    const failedOffline = await request(server, "/api/projects/fixture-app/package-offline", { method: "POST" });
    expect(failedOffline.response.status).toBe(400);
    writeFileSync(brokenBytecodePath, brokenBytecode);
    expect(readdirSync(downloadsDirectory).sort()).toEqual(downloadsBeforeFailure);
    const unchangedConfig = await request(server, "/api/projects/fixture-app/config");
    expect(unchangedConfig.value.build).toBe(2);
    expect(unchangedConfig.value.version).toBe("0.2.0");
    const duplicateRelease = await request(server, "/api/projects/fixture-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(duplicateRelease.response.status).toBe(200);
    expect(duplicateRelease.value.status.publish.releaseId).toBe(testVersions.value.history.find((entry: any) => entry.slot === "stable").releaseId);
    const afterRelease = await request(server, "/api/projects/fixture-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "test" }) });
    expect(afterRelease.value.status.publish.build).toBe(5);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("editor rejects unsafe project identifiers before touching the workspace", async () => {
  const workspace = temporaryWorkspace();
  const server = await startEditor({ port: 0, workspace });
  try {
    const result = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "../escape", name: "Escape" }),
    });
    expect(result.response.status).toBe(400);
    expect(await Bun.file(join(workspace, "projects/escape/editor.json")).exists()).toBe(false);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("editor requires a positive release build", async () => {
  const workspace = temporaryWorkspace();
  const server = await startEditor({ port: 0, workspace });
  try {
    const result = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "zero-build", name: "Zero Build", build: 0 }),
    });
    expect(result.response.status).toBe(400);
    expect(result.value.error).toContain("positive safe integer");
    expect(existsSync(join(workspace, "projects/zero-build"))).toBe(false);

    const valid = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "valid-build", name: "Valid Build", build: 1 }),
    });
    expect(valid.response.status).toBe(201);

    const zeroPut = await request(server, "/api/projects/valid-build/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.host.demo", name: "Valid Build", build: 0 }),
    });
    expect(zeroPut.response.status).toBe(400);
    expect(zeroPut.value.error).toContain("positive safe integer");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("editor can attach to an external SDK project without copying guest source", async () => {
  const workspace = temporaryWorkspace();
  const project = temporaryWorkspace();
  const fixture = temporaryWorkspace();
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "external-app", appId: "dev.example.external", name: "External App", title: "External App", version: "0.1.0", build: 1, tickHz: 60, entry: "app.tsx", framework: "solid" }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.example.external", name: "external-app", version: "0.1.0", app: { entry: "app.tsx", output: "app", framework: "solid" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(project, "app.tsx"), "export const external = true;\n");
  const appJs = join(fixture, "app.js");
  const bytecode = join(fixture, "app.qjbc");
  const metadata = join(fixture, "app.bytecode.json");
  const pak = join(fixture, "app.pak");
  writeFileSync(appJs, "globalThis.__external = true;\n");
  writeFileSync(bytecode, Buffer.from([0x51, 0x4a, 0x42, 0x43, 9]));
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-external-v1", bytecodeBytes: 5 }));
  writeFileSync(pak, pack([{ key: "fixture:external", dtype: 0, data: new Uint8Array([9, 8, 7]) }]));
  const server = await startEditor({
    port: 0,
    workspace,
    projectRoot: project,
    buildRunner: async () => ({ appJs, bytecode, metadata, pak, runtimeAbi: "fixture-external-v1", bytecodeMetadata: JSON.parse(await Bun.file(metadata).text()) }),
  });
  try {
    const listed = await request(server, "/api/projects");
    expect(listed.response.status).toBe(200);
    expect(listed.value.map((item: { id: string }) => item.id)).toEqual(["external-app"]);
    const health = await request(server, "/health");
    expect(health.value.projectRoot).toBe(project);
    const source = await request(server, "/api/projects/external-app/files/app.tsx");
    expect(source.value.content).toContain("external");
    const create = await request(server, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "external-app" }) });
    expect(create.response.status).toBe(409);
    const edited = await request(server, "/api/projects/external-app/files/app.tsx", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "export const edited = true;\n" }) });
    expect(edited.response.status).toBe(200);
    expect(existsSync(join(project, "editor-state.json"))).toBe(false);
    const firstNestedWrite = await request(server, "/api/projects/external-app/files/new/first.tsx", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "export const first = true;\n" }),
    });
    expect(firstNestedWrite.response.status).toBe(200);
    expect(readFileSync(join(project, "new/first.tsx"), "utf8")).toContain("first = true");
    const firstAssetsList = await request(server, "/api/projects/external-app/assets");
    expect(firstAssetsList.response.status).toBe(200);
    expect(firstAssetsList.value.assets).toEqual([]);
    const build = await request(server, "/api/projects/external-app/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(build.response.status).toBe(202);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await request(server, "/api/projects/external-app/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = await request(server, "/api/projects/external-app/status");
    expect(status.value.error).toBeUndefined();
    expect(status.value.artifacts.bytecode).toContain("app.qjbc");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("editor preserves build from a pocket.json-only external project", async () => {
  const workspace = temporaryWorkspace();
  const project = temporaryWorkspace();
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    pocket: 2,
    id: "dev.example.pocket-only",
    name: "pocket-only-app",
    version: "0.4.0",
    build: 42,
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(project, "app.tsx"), "export const pocketOnly = true;\n");
  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  try {
    const listed = await request(server, "/api/projects");
    expect(listed.response.status).toBe(200);
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0].build).toBe(42);
    const loaded = await request(server, "/api/projects/pocket-only-app");
    expect(loaded.response.status).toBe(200);
    expect(loaded.value.build).toBe(42);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("editor validates both external config paths on read and write", async () => {
  const workspace = temporaryWorkspace();
  const project = temporaryWorkspace();
  const externalDir = temporaryWorkspace();
  const editorPath = join(project, "editor.json");
  const pocketPath = join(project, "pocket.json");
  writeFileSync(editorPath, JSON.stringify({ id: "guarded-app", appId: "dev.example.guarded", name: "Guarded", title: "Guarded", version: "0.1.0", build: 1, tickHz: 60, entry: "app.tsx", framework: "solid" }));
  writeFileSync(join(externalDir, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.example.guarded", name: "guarded-app", version: "0.1.0", build: 1, app: { entry: "app.tsx" } }));
  symlinkSync(join(externalDir, "pocket.json"), pocketPath);
  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  try {
    const readRes = await request(server, "/api/projects/guarded-app");
    expect(readRes.response.status).toBe(400);
    expect(readRes.value.error).toContain("symbolic links are not allowed");

    const writeRes = await request(server, "/api/projects/guarded-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "dev.example.guarded", name: "Guarded", build: 2 }),
    });
    expect(writeRes.response.status).toBe(400);
    expect(writeRes.value.error).toContain("symbolic links are not allowed");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("editor enforces security boundaries against CSRF, Host header poisoning, and symlinks", async () => {
  const workspace = temporaryWorkspace();
  const externalDir = temporaryWorkspace();
  const secretFile = join(externalDir, "secret.json");
  writeFileSync(secretFile, JSON.stringify({ secret: "classified" }));

  const server = await startEditor({ port: 0, workspace });
  try {
    // 1. Cross-origin Origin: https://evil.example POST is rejected with 403
    const crossOrigin = await unauthenticatedRequest(server, "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ id: "evil-app" }),
    });
    expect(crossOrigin.response.status).toBe(403);

    // 1b. Missing CSRF / editor credentials on mutating route is rejected with 403
    const unauthenticatedJson = await unauthenticatedRequest(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "unauth-app" }),
    });
    expect(unauthenticatedJson.response.status).toBe(403);
    expect(unauthenticatedJson.value.error).toContain("missing CSRF token or editor credential");

    // Studio process-launch/input routes inherit the same boundary; reject
    // before discovery, model requests or any native input can execute.
    for (const endpoint of ["deploy", "codex/turn", "preview/input"]) {
      const missingProof = await unauthenticatedRequest(server, `/api/projects/sec-app/${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      expect(missingProof.response.status).toBe(403);
      const foreignOrigin = await request(server, `/api/projects/sec-app/${endpoint}`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}",
      });
      expect(foreignOrigin.response.status).toBe(403);
    }

    // 2. Content-Type: text/plain POST to /api/projects is rejected with 415
    const plainText = await request(server, "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
      },
      body: JSON.stringify({ id: "plain-app" }),
    });
    expect(plainText.response.status).toBe(415);

    // 3. Host: attacker.example POST is rejected with 403
    const evilHost = await request(server, "/api/projects", {
      method: "POST",
      headers: {
        host: "attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "attacker-app" }),
    });
    expect(evilHost.response.status).toBe(403);

    // Create a valid project first
    const created = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "sec-app", name: "Security App" }),
    });
    expect(created.response.status).toBe(201);

    const projectDir = join(workspace, "projects/sec-app");

    // Even with a non-empty authoritative editor.json, loadConfig validates
    // the legacy pocket.json path before returning early.
    const pocketPath = join(projectDir, "pocket.json");
    const pocketContents = readFileSync(pocketPath, "utf8");
    rmSync(pocketPath, { force: true });
    symlinkSync(secretFile, pocketPath);
    const configWithPocketLink = await request(server, "/api/projects/sec-app/config");
    expect(configWithPocketLink.response.status).toBe(400);
    rmSync(pocketPath, { force: true });
    writeFileSync(pocketPath, pocketContents);

    // 4. Symlinked app.tsx pointing outside the project is rejected with 400
    const appTsx = join(projectDir, "app.tsx");
    rmSync(appTsx, { force: true });
    symlinkSync(secretFile, appTsx);
    const sourceGet = await request(server, "/api/projects/sec-app/source");
    expect(sourceGet.response.status).toBe(400);

    const sourcePut = await request(server, "/api/projects/sec-app/source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "pwned" }),
    });
    expect(sourcePut.response.status).toBe(400);

    // Restore real app.tsx, test symlinked manifest.json
    rmSync(appTsx, { force: true });
    writeFileSync(appTsx, "export const ok = true;\n");

    const manifestJson = join(projectDir, "manifest.json");
    rmSync(manifestJson, { force: true });
    symlinkSync(secretFile, manifestJson);

    const manifestGet = await request(server, "/api/projects/sec-app/manifest");
    expect(manifestGet.response.status).toBe(400);

    const manifestPut = await request(server, "/api/projects/sec-app/manifest", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hacked: true }),
    });
    expect(manifestPut.response.status).toBe(400);

    // Symlinked app.tsx or manifest.json during build is rejected
    const buildResp = await request(server, "/api/projects/sec-app/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(buildResp.response.status).toBe(202);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await request(server, "/api/projects/sec-app/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = await request(server, "/api/projects/sec-app/status");
    expect(status.value.error).toBeDefined();
    expect(status.value.error).toContain("symbolic links are not allowed");

    // 5. Host port mismatch is rejected with 403
    const hostMismatch = await request(server, "/api/projects", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${server.port + 1}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "host-mismatch" }),
    });
    expect(hostMismatch.response.status).toBe(403);

    // 6. Sec-Fetch-Site: cross-site is rejected with 403
    const crossSite = await request(server, "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ id: "cross-site-app" }),
    });
    expect(crossSite.response.status).toBe(403);

    // 7. Sec-Fetch-Mode: navigate / no-cors is rejected with 403
    const navMode = await request(server, "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-mode": "navigate",
      },
      body: JSON.stringify({ id: "nav-app" }),
    });
    expect(navMode.response.status).toBe(403);

    // 8. Build / publish reject non-JSON content-type with 415
    const plainBuild = await request(server, "/api/projects/sec-app/build", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(plainBuild.response.status).toBe(415);

    // 9. Cross-port Origin multipart form upload to /api/projects/sec-app/assets is rejected with 403 and does not write file
    const evilForm = new FormData();
    evilForm.append("file", new File([new TextEncoder().encode("bad-asset")], "evil.png", { type: "image/png" }));
    const crossPortAsset = await unauthenticatedRequest(server, "/api/projects/sec-app/assets", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:64890",
      },
      body: evilForm,
    });
    expect(crossPortAsset.response.status).toBe(403);
    expect(existsSync(join(projectDir, "assets/evil.png"))).toBe(false);

    // 10. Multipart form upload without x-pocket-csrf / csrfToken / x-pocket-editor is rejected with 403
    const noCsrfForm = new FormData();
    noCsrfForm.append("file", new File([new TextEncoder().encode("nocsrf")], "nocsrf.png", { type: "image/png" }));
    const noCsrfAsset = await unauthenticatedRequest(server, "/api/projects/sec-app/assets", {
      method: "POST",
      body: noCsrfForm,
    });
    expect(noCsrfAsset.response.status).toBe(403);
    expect(existsSync(join(projectDir, "assets/nocsrf.png"))).toBe(false);

    // 11. Multipart form upload with x-pocket-csrf: health.csrfToken (or x-pocket-editor: 1) and same-port Origin succeeds with 200
    const health = await request(server, "/health");
    expect(health.response.status).toBe(200);
    expect(typeof health.value.csrfToken).toBe("string");
    const serverCsrf = health.value.csrfToken;

    const validCsrfForm = new FormData();
    validCsrfForm.append("file", new File([new TextEncoder().encode("valid-csrf")], "valid-csrf.png", { type: "image/png" }));
    const validCsrfAsset = await request(server, "/api/projects/sec-app/assets", {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-pocket-csrf": serverCsrf,
      },
      body: validCsrfForm,
    });
    expect(validCsrfAsset.response.status).toBe(200);
    expect(existsSync(join(projectDir, "assets/valid-csrf.png"))).toBe(true);

    const validEditorHeaderForm = new FormData();
    validEditorHeaderForm.append("file", new File([new TextEncoder().encode("valid-editor")], "valid-editor.png", { type: "image/png" }));
    const validEditorAsset = await request(server, "/api/projects/sec-app/assets", {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
        "x-pocket-editor": "1",
      },
      body: validEditorHeaderForm,
    });
    expect(validEditorAsset.response.status).toBe(200);
    expect(existsSync(join(projectDir, "assets/valid-editor.png"))).toBe(true);

    const validFormBodyCsrf = new FormData();
    validFormBodyCsrf.append("csrfToken", serverCsrf);
    validFormBodyCsrf.append("file", new File([new TextEncoder().encode("valid-body")], "valid-body.png", { type: "image/png" }));
    const validBodyAsset = await unauthenticatedRequest(server, "/api/projects/sec-app/assets", {
      method: "POST",
      headers: {
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: validFormBodyCsrf,
    });
    expect(validBodyAsset.response.status).toBe(200);
    expect(existsSync(join(projectDir, "assets/valid-body.png"))).toBe(true);

    // 12. A canonical release symlink to an external directory returns 400
    // and never exposes the target contents.
    const victimDir = temporaryWorkspace();
    try {
      writeFileSync(join(victimDir, "latest.json"), JSON.stringify({ secret: "victim-secret-content" }));
      const victimParent = join(workspace, "updates/pocket/3.2.0/com.example.victim");
      mkdirSync(victimParent, { recursive: true });
      const victimSymlink = join(victimParent, "stable");
      symlinkSync(victimDir, victimSymlink);

      const victimResp = await request(server, "/pocket/3.2.0/com.example.victim/stable/latest.json");
      expect(victimResp.response.status).toBe(400);
      expect(victimResp.value).not.toEqual({ secret: "victim-secret-content" });
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("editor rejects dangling and parent symlinks across project write boundaries", async () => {
  const workspace = temporaryWorkspace();
  const externalDir = temporaryWorkspace();
  const server = await startEditor({ port: 0, workspace });
  try {
    const created = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "boundary-app", name: "Boundary App" }),
    });
    expect(created.response.status).toBe(201);
    const projectDir = join(workspace, "projects/boundary-app");

    const danglingSource = join(externalDir, "new-source.tsx");
    const appPath = join(projectDir, "app.tsx");
    rmSync(appPath, { force: true });
    symlinkSync(danglingSource, appPath);
    const sourceWrite = await request(server, "/api/projects/boundary-app/source", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "outside source" }),
    });
    expect(sourceWrite.response.status).toBe(400);
    expect(existsSync(danglingSource)).toBe(false);
    rmSync(appPath, { force: true });
    writeFileSync(appPath, "export const restored = true;\n");

    const danglingManifest = join(externalDir, "new-manifest.json");
    const manifestPath = join(projectDir, "manifest.json");
    rmSync(manifestPath, { force: true });
    symlinkSync(danglingManifest, manifestPath);
    const manifestWrite = await request(server, "/api/projects/boundary-app/manifest", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1 }),
    });
    expect(manifestWrite.response.status).toBe(400);
    expect(existsSync(danglingManifest)).toBe(false);
    rmSync(manifestPath, { force: true });
    writeFileSync(manifestPath, JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));

    const outsideParent = join(externalDir, "nested-target");
    mkdirSync(outsideParent, { recursive: true });
    const parentLink = join(projectDir, "nested-link");
    symlinkSync(outsideParent, parentLink);
    const nestedRejected = await request(server, "/api/projects/boundary-app/files/nested-link/blocked.tsx", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "outside parent" }),
    });
    expect(nestedRejected.response.status).toBe(400);
    expect(existsSync(join(outsideParent, "blocked.tsx"))).toBe(false);
    rmSync(parentLink, { force: true });

    const nestedAccepted = await request(server, "/api/projects/boundary-app/files/new/first.tsx", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "export const first = true;\n" }),
    });
    expect(nestedAccepted.response.status).toBe(200);
    expect(readFileSync(join(projectDir, "new/first.tsx"), "utf8")).toContain("first = true");

    const editorVictim = join(externalDir, "editor-victim.json");
    const editorContents = readFileSync(join(projectDir, "editor.json"), "utf8");
    writeFileSync(editorVictim, editorContents);
    const editorPath = join(projectDir, "editor.json");
    rmSync(editorPath, { force: true });
    symlinkSync(editorVictim, editorPath);
    const configRejected = await request(server, "/api/projects/boundary-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.host.demo", name: "Blocked", version: "0.2.0", build: 2, tickHz: 60 }),
    });
    expect(configRejected.response.status).toBe(400);
    expect(JSON.parse(readFileSync(editorVictim, "utf8")).name).toBe("Boundary App");
    rmSync(editorPath, { force: true });

    const danglingEditor = join(externalDir, "dangling-editor.json");
    symlinkSync(danglingEditor, editorPath);
    const danglingGet = await request(server, "/api/projects/boundary-app/config");
    expect(danglingGet.response.status).toBe(400);
    const danglingPut = await request(server, "/api/projects/boundary-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.host.demo", name: "Blocked", version: "0.2.0", build: 2, tickHz: 60 }),
    });
    expect(danglingPut.response.status).toBe(400);
    expect(existsSync(danglingEditor)).toBe(false);
    rmSync(editorPath, { force: true });
    writeFileSync(editorPath, editorContents);

    const pocketVictim = join(externalDir, "pocket-victim.json");
    const pocketContents = readFileSync(join(projectDir, "pocket.json"), "utf8");
    writeFileSync(pocketVictim, pocketContents);
    const pocketPath = join(projectDir, "pocket.json");
    rmSync(pocketPath, { force: true });
    symlinkSync(pocketVictim, pocketPath);
    const pocketRejected = await request(server, "/api/projects/boundary-app/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "pocket.host.demo", name: "Blocked", version: "0.2.0", build: 2, tickHz: 60 }),
    });
    expect(pocketRejected.response.status).toBe(400);
    expect(readFileSync(pocketVictim, "utf8")).toBe(pocketContents);
    rmSync(pocketPath, { force: true });
    writeFileSync(pocketPath, pocketContents);

    const danglingAsset = join(externalDir, "new-asset.png");
    const assetLink = join(projectDir, "assets/dangling.png");
    symlinkSync(danglingAsset, assetLink);
    const form = new FormData();
    form.append("file", new File([new TextEncoder().encode("asset")], "dangling.png", { type: "image/png" }));
    const assetRejected = await request(server, "/api/projects/boundary-app/assets", {
      method: "POST",
      headers: { "x-pocket-editor": "1" },
      body: form,
    });
    expect(assetRejected.response.status).toBe(400);
    expect(existsSync(danglingAsset)).toBe(false);
    rmSync(assetLink, { force: true });

    const assetDirectory = join(projectDir, "assets");
    const externalAssetDirectory = join(externalDir, "assets-out");
    mkdirSync(externalAssetDirectory, { recursive: true });
    writeFileSync(join(externalAssetDirectory, "secret.png"), "not-for-editor");
    rmSync(assetDirectory, { recursive: true, force: true });
    symlinkSync(externalAssetDirectory, assetDirectory);
    const assetsRejected = await request(server, "/api/projects/boundary-app/assets");
    expect(assetsRejected.response.status).toBe(400);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("editor rejects a legacy external editor-state symlink", async () => {
  const workspace = temporaryWorkspace();
  const project = temporaryWorkspace();
  const externalDir = temporaryWorkspace();
  const stateVictim = join(externalDir, "state.json");
  writeFileSync(join(project, "editor.json"), JSON.stringify({ id: "legacy-app", appId: "dev.example.legacy", name: "Legacy", title: "Legacy", version: "0.1.0", build: 1, tickHz: 60, entry: "app.tsx", framework: "solid" }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "dev.example.legacy", name: "legacy-app", version: "0.1.0", app: { entry: "app.tsx" } }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ protocolVersion: 1, capabilities: { requires: [], optional: [] } }));
  writeFileSync(join(project, "app.tsx"), "export const legacy = true;\n");
  writeFileSync(stateVictim, JSON.stringify({ revision: 99, builtRevision: null, busy: false, logs: ["outside"] }));
  symlinkSync(stateVictim, join(project, "editor-state.json"));
  const server = await startEditor({ port: 0, workspace, projectRoot: project });
  try {
    const status = await request(server, "/api/projects/legacy-app/status");
    expect(status.response.status).toBe(400);
    expect(JSON.parse(readFileSync(stateVictim, "utf8")).revision).toBe(99);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});

test("editor validates custom build entries and static source/assets links", async () => {
  const workspace = temporaryWorkspace();
  const externalDir = temporaryWorkspace();
  const server = await startEditor({ port: 0, workspace });
  try {
    const created = await request(server, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "custom-entry", name: "Custom Entry" }),
    });
    expect(created.response.status).toBe(201);
    const projectDir = join(workspace, "projects/custom-entry");
    const source = readFileSync(join(projectDir, "app.tsx"), "utf8");
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src/main.tsx"), source);
    const pocketPath = join(projectDir, "pocket.json");
    const pocket = JSON.parse(readFileSync(pocketPath, "utf8")) as Record<string, any>;
    pocket.app = { ...(pocket.app as Record<string, unknown>), entry: "src/main.tsx" };
    writeFileSync(pocketPath, `${JSON.stringify(pocket, null, 2)}\n`);

    // A package-manager SDK link is an allowed build dependency and is not
    // traversed as application source by the Editor scanner.
    mkdirSync(join(projectDir, "node_modules/@pocket"), { recursive: true });
    symlinkSync(join(import.meta.dir, "../../packages/pocket_ui"), join(projectDir, "node_modules/@pocket/ui"), "dir");
    const firstBuild = await request(server, "/api/projects/custom-entry/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(firstBuild.response.status).toBe(202);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const status = await request(server, "/api/projects/custom-entry/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const firstStatus = await request(server, "/api/projects/custom-entry/status");
    expect(firstStatus.value.error).toBeUndefined();
    expect(firstStatus.value.builtRevision).toBe(firstStatus.value.revision);

    // Cache contents are not traversed, but the cache boundary itself may not
    // be a symlink that hides arbitrary project input.
    symlinkSync(externalDir, join(projectDir, "build"), "dir");
    const cacheLinkBuild = await request(server, "/api/projects/custom-entry/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(cacheLinkBuild.response.status).toBe(202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await request(server, "/api/projects/custom-entry/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cacheLinkStatus = await request(server, "/api/projects/custom-entry/status");
    expect(cacheLinkStatus.value.error).toContain("unsupported source symlink: build");
    rmSync(join(projectDir, "build"), { force: true });

    // A relative import that is materialized as a project source symlink is
    // rejected before build_guest can read the external target.
    const linkedSource = join(externalDir, "linked.tsx");
    writeFileSync(linkedSource, "export default () => null;\n");
    writeFileSync(join(projectDir, "src/main.tsx"), `${source}\nimport Linked from './linked.tsx';\nvoid Linked;\n`);
    symlinkSync(linkedSource, join(projectDir, "src/linked.tsx"));
    const linkedBuild = await request(server, "/api/projects/custom-entry/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(linkedBuild.response.status).toBe(202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await request(server, "/api/projects/custom-entry/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const linkedStatus = await request(server, "/api/projects/custom-entry/status");
    expect(linkedStatus.value.error).toContain("unsupported source symlink: src/linked.tsx");
    rmSync(join(projectDir, "src/linked.tsx"), { force: true });

    // Assets are runtime inputs too; nested dangling links must not be
    // silently omitted by the top-level assets check.
    const nestedAsset = join(projectDir, "assets/nested");
    mkdirSync(nestedAsset, { recursive: true });
    symlinkSync(join(externalDir, "missing.png"), join(nestedAsset, "missing.png"));
    const assetBuild = await request(server, "/api/projects/custom-entry/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(assetBuild.response.status).toBe(202);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await request(server, "/api/projects/custom-entry/status");
      if (!status.value.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const assetStatus = await request(server, "/api/projects/custom-entry/status");
    expect(assetStatus.value.error).toContain("unsupported asset symlink: assets/nested/missing.png");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
}, 120_000);
