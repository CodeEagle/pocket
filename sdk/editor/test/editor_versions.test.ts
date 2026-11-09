import { expect, test } from "bun:test";
import { createHash, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { startEditor } from "../server.ts";
import { RESOURCE_SNAPSHOT_FILE } from "../resources.ts";
import { verifySignedManifest } from "../../scripts/package_update.ts";

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-versions-"));
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const headers = new Headers(init?.headers);
  if (["POST", "PUT", "PATCH", "DELETE"].includes((init?.method ?? "GET").toUpperCase())) headers.set("x-pocket-editor", "1");
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, { ...init, headers });
  const type = response.headers.get("content-type") ?? "";
  return { response, value: type.includes("application/json") ? await response.json() : await response.arrayBuffer() };
}

async function waitForBuild(server: ReturnType<typeof Bun.serve>, id: string): Promise<any> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await request(server, `/api/projects/${id}/status`);
    if (!status.value.busy) return status.value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`build timed out for ${id}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeSystemProject(workspace: string, id: string, rootAppId: string): void {
  const project = join(workspace, "projects", id);
  const child = join(project, "child");
  mkdirSync(child, { recursive: true });
  const rootPocketPath = join(project, "pocket.json");
  const rootPocket = JSON.parse(readFileSync(rootPocketPath, "utf8")) as Record<string, any>;
  rootPocket.app = { ...(rootPocket.app ?? {}), viewport: { fixed: { logical: [360, 640], presentation: "native" } } };
  writeFileSync(rootPocketPath, JSON.stringify(rootPocket, null, 2) + "\n");
  writeFileSync(join(child, "pocket.json"), JSON.stringify({
    "$schema": "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "child.app",
    name: "child-app",
    title: "Child App",
    version: "0.1.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
    app: { entry: "app.tsx", output: "child", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
  }, null, 2) + "\n");
  writeFileSync(join(child, "manifest.json"), JSON.stringify({
    "$schema": "https://pocketjs.dev/schema/pocket-guest-manifest.json",
    protocolVersion: 1,
    capabilities: { requires: ["text.glyphs.baked"], optional: [] },
    permissions: { optional: [] },
  }, null, 2) + "\n");
  writeFileSync(join(child, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";\nimport { Text } from "@pocketjs/framework/solid/components";\nmount(() => <Text>Child ${rootAppId}</Text>);\n`);
  writeFileSync(join(project, "pocket.system.json"), JSON.stringify({
    "$schema": "https://pocketjs.dev/schema/pocket-system-1.json",
    pocketSystem: 1,
    id: "fixture.system",
    name: "fixture-system",
    title: "Fixture system",
    version: "0.1.0",
    roles: { systemUI: rootAppId },
    applications: {
      installPolicy: { model: "managed", mutable: false },
      backgroundExecution: "suspend",
      catalog: [
        { package: rootAppId, manifest: "pocket.json", required: true, memory: { heapLimitBytes: 134217728 } },
        { package: "child.app", manifest: "child/pocket.json", required: true, memoryPolicy: "UI_MINI" },
      ],
    },
    installation: { installedPackages: [rootAppId, "child.app"] },
  }, null, 2) + "\n");
}

test("editor version journal covers immutable child releases and offline archives", async () => {
  const workspace = temporaryWorkspace();
  const fixture = temporaryWorkspace();
  let generation = 1;
  const rootFiles = (n: number) => {
    const appJs = join(fixture, `root-${n}.js`);
    const bytecode = join(fixture, `root-${n}.qjbc`);
    const metadata = join(fixture, `root-${n}.bytecode.json`);
    const pak = join(fixture, `root-${n}.pak`);
    writeFileSync(appJs, `globalThis.__root_generation = ${n};\n`);
    writeFileSync(bytecode, Buffer.from([0x50, 0x4a, 0x42, 0x43, n, 7, 9]));
    writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "fixture-root-abi", bytecodeBytes: 7 }));
    writeFileSync(pak, pack([{ key: "fixture:text", dtype: 0, data: new Uint8Array([n, 2, 3, 4]) }]));
    return { appJs, bytecode, metadata, pak };
  };
  const server = await startEditor({
    port: 0,
    updateHost: "127.0.0.1",
    updatePort: 0,
    updateHostVersion: "4.0.0",
    workspace,
    buildRunner: async () => {
      const files = rootFiles(generation);
      return { ...files, runtimeAbi: "fixture-root-abi", bytecodeMetadata: JSON.parse(readFileSync(files.metadata, "utf8")) };
    },
  });
  try {
    const created = await request(server, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "root-app", name: "Root", appId: "root.app", version: "1.0.0", build: 1 }) });
    expect(created.response.status).toBe(201);
    writeSystemProject(workspace, "root-app", "root.app");
    const firstBuild = await request(server, "/api/projects/root-app/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(firstBuild.response.status).toBe(202);
    const firstStatus = await waitForBuild(server, "root-app");
    expect(firstStatus.error, firstStatus.logs.join("\n")).toBeUndefined();
    expect(firstStatus.builtRevision).toBe(firstStatus.revision);
    const firstPublish = await request(server, "/api/projects/root-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(firstPublish.response.status).toBe(200);
    const childBytecodePath = join(workspace, "builds/root-app", String(firstStatus.builtRevision), "subpackages/child.app/app.qjbc");
    const childBytecode = readFileSync(childBytecodePath);
    const historyBeforeChildFailure = readFileSync(join(workspace, "states/root-app.versions.json"));
    rmSync(childBytecodePath);
    const failedChildPublish = await request(server, "/api/projects/root-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(failedChildPublish.response.status).toBe(400);
    expect(readFileSync(join(workspace, "states/root-app.versions.json"))).toEqual(historyBeforeChildFailure);
    writeFileSync(childBytecodePath, childBytecode);
    const firstVersions = await request(server, "/api/projects/root-app/versions");
    expect(firstVersions.value.history).toHaveLength(1);
    expect(firstVersions.value.history[0].packages.map((pkg: any) => pkg.id).sort()).toEqual(["child.app", "root.app"]);
    const firstEntry = firstVersions.value.history[0];
    expect(firstVersions.value.appConfigUrl).toContain("/stable/pocket/4.0.0/root.app/latest.json");
    const aggregateResponse = await request(server, new URL(firstVersions.value.appConfigUrl).pathname);
    expect(aggregateResponse.response.status).toBe(200);
    expect(aggregateResponse.value.kind).toBe("pocket-editor-package-index");
    expect(aggregateResponse.value.latest.compatVersion).toBe(firstEntry.compatVersion);
    expect(aggregateResponse.value.latest.manifestUrl).toContain(`/pocket/4.0.0/root.app/${firstEntry.releaseId}/latest.json`);
    expect(aggregateResponse.value.versions[0].payloadSha256).toBeTruthy();
    const aggregateHostResponse = await request(server, new URL(aggregateResponse.value.latest.hostConfigUrl, firstVersions.value.appConfigUrl).pathname);
    expect(aggregateHostResponse.value.kind).toBe("pocket-editor-app-host");
    expect(aggregateResponse.value.systemUI).toBe("root.app");
    expect(aggregateResponse.value.rootAppId).toBe(aggregateHostResponse.value.systemUI);
    expect(Object.keys(aggregateHostResponse.value.applications).sort()).toEqual(["child.app", "root.app"]);
    expect(aggregateHostResponse.value.compositorSurfaces).toEqual({ "child.app": 2 });
    const firstRoot = firstEntry.packages.find((pkg: any) => pkg.id === "root.app");
    const firstChild = firstEntry.packages.find((pkg: any) => pkg.id === "child.app");
    expect((await fetch(firstRoot.manifestUrl)).status).toBe(200);
    expect((await fetch(firstChild.hostConfigUrl)).status).toBe(200);
    const verifyArchive = (archiveBytes: Uint8Array, entry: any, label: string): void => {
      const archivePath = join(fixture, `${label}.tar.gz`);
      const extractedPath = join(fixture, `${label}-extracted`);
      writeFileSync(archivePath, archiveBytes);
      mkdirSync(extractedPath, { recursive: true });
      expect(spawnSync("tar", ["-xzf", archivePath, "-C", extractedPath]).status).toBe(0);
      for (const pkg of entry.packages) {
        const packageRoot = join(extractedPath, "pocket", "4.0.0", pkg.id, entry.packageVersion);
        const envelope = JSON.parse(readFileSync(join(packageRoot, "latest.json"), "utf8"));
        const host = JSON.parse(readFileSync(join(packageRoot, "host.json"), "utf8"));
        const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
        expect(payload.version).toBe(pkg.version);
        expect(payload.build).toBe(pkg.build);
        const publicKey = Buffer.from((pkg.id === "root.app" ? host.POCKET_UPDATE_PUBLIC_KEY : host.config.updates.publicKey), "base64");
        const publicPem = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" }).export({ format: "pem", type: "spki" });
        expect(JSON.parse(new TextDecoder().decode(verifySignedManifest(envelope, publicPem))).appId).toBe(pkg.id);
        for (const file of payload.files) {
          const bytes = readFileSync(join(packageRoot, file.url));
          expect(bytes.byteLength).toBe(file.size);
          expect(sha256(bytes)).toBe(file.sha256);
        }
      }
      const aggregateHostPath = join(extractedPath, "pocket", "4.0.0", "root.app", entry.routeVersion ?? entry.version, "host.json");
      expect(existsSync(aggregateHostPath)).toBe(true);
      const aggregateHost = JSON.parse(readFileSync(aggregateHostPath, "utf8"));
      expect(aggregateHost.kind).toBe("pocket-editor-app-host");
      expect(aggregateHost.systemUI).toBe("root.app");
      expect(Object.keys(aggregateHost.applications).sort()).toEqual(["child.app", "root.app"]);
      expect(Object.keys(aggregateHost.applications["root.app"].bootstrapAssets).length).toBeGreaterThan(0);
    };
    const firstArchive = new Uint8Array((await request(server, firstEntry.archiveUrl)).value);
    verifyArchive(firstArchive, firstEntry, "first-history");

    const firstRootEnvelope = (await request(server, new URL(firstRoot.manifestUrl).pathname)).value;
    const firstRootPayload = JSON.parse(Buffer.from(firstRootEnvelope.payload, "base64").toString("utf8"));
    const firstCurrentManifestPath = `/stable/pocket/4.0.0/root.app/${firstEntry.compatVersion}/latest.json`;
    const firstRootBlobPath = new URL(`blobs/${firstRootPayload.entry.sha256}`, `http://localhost${firstCurrentManifestPath}`).pathname;
    const firstRootBlobResponse = await request(server, firstRootBlobPath);
    expect(firstRootBlobResponse.response.status).toBe(200);
    const firstRootBlob = new Uint8Array(firstRootBlobResponse.value);

    generation = 2;
    const config2 = await request(server, "/api/projects/root-app/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: "root.app", name: "Root", version: "2.0.0", build: 2, tickHz: 60 }) });
    expect(config2.response.status).toBe(200);
    await request(server, "/api/projects/root-app/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const secondStatus = await waitForBuild(server, "root-app");
    expect(secondStatus.error).toBeUndefined();
    const secondPublish = await request(server, "/api/projects/root-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(secondPublish.response.status).toBe(200);
    const secondVersions = await request(server, "/api/projects/root-app/versions");
    expect(secondVersions.value.history).toHaveLength(2);
    expect(secondVersions.value.history[0].packages.map((pkg: any) => pkg.id).sort()).toEqual(["child.app", "root.app"]);
    const secondEntry = secondVersions.value.history[0];
    const secondArchive = new Uint8Array((await request(server, secondEntry.archiveUrl)).value);
    verifyArchive(secondArchive, secondEntry, "second-history");
    expect(new Uint8Array((await request(server, firstEntry.archiveUrl)).value)).toEqual(firstArchive);
    const historyAfterSecond = readFileSync(join(workspace, "states/root-app.versions.json"));
    const downgrade = await request(server, "/api/projects/root-app/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: "root.app", name: "Root", version: "1.5.0", build: 1, tickHz: 60 }) });
    expect(downgrade.response.status).toBe(200);
    await request(server, "/api/projects/root-app/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await waitForBuild(server, "root-app");
    const rejectedDowngrade = await request(server, "/api/projects/root-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(rejectedDowngrade.response.status).toBe(400);
    expect(readFileSync(join(workspace, "states/root-app.versions.json"))).toEqual(historyAfterSecond);
    generation = 3;
    const sameBuildChanged = await request(server, "/api/projects/root-app/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: "root.app", name: "Root", version: "2.0.0", build: 2, tickHz: 60 }) });
    expect(sameBuildChanged.response.status).toBe(200);
    await request(server, "/api/projects/root-app/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await waitForBuild(server, "root-app");
    const rejectedSameBuildChange = await request(server, "/api/projects/root-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(rejectedSameBuildChange.response.status).toBe(400);
    expect(readFileSync(join(workspace, "states/root-app.versions.json"))).toEqual(historyAfterSecond);
    const oldBlobAfterRotation = await request(server, firstRootBlobPath);
    expect(oldBlobAfterRotation.response.status).toBe(200);
    expect(new Uint8Array(oldBlobAfterRotation.value)).toEqual(firstRootBlob);

    const statePath = join(workspace, "states/root-app.json");
    const historyPath = join(workspace, "states/root-app.versions.json");
    const stateBeforeOffline = readFileSync(statePath);
    const historyBeforeOffline = readFileSync(historyPath);
    const offline = await request(server, "/api/projects/root-app/package-offline", { method: "POST" });
    expect(offline.response.status).toBe(200);
    const offlineArchive = await request(server, offline.value.archiveUrl);
    expect(offlineArchive.response.status).toBe(200);
    expect(offlineArchive.response.headers.get("content-disposition")).toContain(offline.value.filename);
    expect(readFileSync(statePath)).toEqual(stateBeforeOffline);
    expect(readFileSync(historyPath)).toEqual(historyBeforeOffline);
    expect(new Uint8Array((await request(server, firstEntry.archiveUrl)).value)).toEqual(firstArchive);
    expect(new Uint8Array((await request(server, secondEntry.archiveUrl)).value)).toEqual(secondArchive);
    const archivePath = join(fixture, offline.value.filename);
    writeFileSync(archivePath, new Uint8Array(offlineArchive.value));
    const extracted = join(fixture, "offline-extracted");
    mkdirSync(extracted, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", archivePath, "-C", extracted]);
    expect(tar.status).toBe(0);
    for (const packageId of ["root.app", "child.app"]) {
      const packageRoot = join(extracted, "pocket", "4.0.0", packageId, offline.value.filename.replace(/^offline-/, "").replace(/\.tar\.gz$/, ""));
      const envelope = JSON.parse(readFileSync(join(packageRoot, "latest.json"), "utf8"));
      const host = JSON.parse(readFileSync(join(packageRoot, "host.json"), "utf8"));
      const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
      const publicKey = Buffer.from((packageId === "root.app" ? host.POCKET_UPDATE_PUBLIC_KEY : host.config.updates.publicKey), "base64");
      const publicPem = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" }).export({ format: "pem", type: "spki" });
      expect(JSON.parse(new TextDecoder().decode(verifySignedManifest(envelope, publicPem))).appId).toBe(packageId);
      for (const file of payload.files) {
        const bytes = readFileSync(join(packageRoot, file.url));
        expect(bytes.byteLength).toBe(file.size);
        expect(sha256(bytes)).toBe(file.sha256);
      }
      if (packageId === "child.app") {
        expect(existsSync(join(packageRoot, "bootstrap/app.bytecode.json"))).toBe(true);
      }
    }
    const rootCollision = await request(server, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "root-collision", name: "Root collision", appId: "root.app", version: "9.0.0", build: 1 }) });
    expect(rootCollision.response.status).toBe(201);
    writeSystemProject(workspace, "root-collision", "root.app");
    const rootCollisionPublish = await request(server, "/api/projects/root-collision/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(rootCollisionPublish.response.status).toBe(409);
    const childCollision = await request(server, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "child-collision", name: "Child collision", appId: "root.two", version: "9.0.0", build: 1 }) });
    expect(childCollision.response.status).toBe(201);
    writeSystemProject(workspace, "child-collision", "root.two");
    const childBuild = await request(server, "/api/projects/child-collision/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(childBuild.response.status).toBe(202);
    const childStatus = await waitForBuild(server, "child-collision");
    expect(childStatus.error).toBeUndefined();
    const childCollisionPublish = await request(server, "/api/projects/child-collision/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(childCollisionPublish.response.status).toBe(409);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
}, 180_000);

test("legacy stable publish migrates signed bytes into the first journal entry", async () => {
  const workspace = temporaryWorkspace();
  const fixture = temporaryWorkspace();
  const appJs = join(fixture, "app.js");
  const bytecode = join(fixture, "app.qjbc");
  const metadata = join(fixture, "app.bytecode.json");
  const pak = join(fixture, "app.pak");
  writeFileSync(appJs, "globalThis.__legacy = true;\n");
  writeFileSync(bytecode, Buffer.from([0x50, 0x4a, 0x42, 0x43, 1, 2, 3]));
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "legacy-abi", bytecodeBytes: 7 }));
  writeFileSync(pak, pack([{ key: "legacy:text", dtype: 0, data: new Uint8Array([1, 2, 3]) }]));
  const options = {
    port: 0,
    updateHost: "127.0.0.1",
    updatePort: 0,
    updateHostVersion: "4.0.0",
    workspace,
    buildRunner: async () => ({ appJs, bytecode, metadata, pak, runtimeAbi: "legacy-abi", bytecodeMetadata: JSON.parse(readFileSync(metadata, "utf8")) }),
  } as const;
  const firstServer = await startEditor(options);
  try {
    // A shared updates directory must not be claimed by the first project in
    // the scan when the requested package has no journal sidecar.
    const unrelated = await request(firstServer, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "aaa-unrelated", name: "Unrelated", appId: "wrong.root", version: "1.0.0", build: 1 }) });
    expect(unrelated.response.status).toBe(201);
    const created = await request(firstServer, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "legacy-app", name: "Legacy", appId: "legacy.app", version: "1.0.0", build: 1 }) });
    expect(created.response.status).toBe(201);
    await request(firstServer, "/api/projects/legacy-app/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const status = await waitForBuild(firstServer, "legacy-app");
    expect(status.error).toBeUndefined();
    expect((await request(firstServer, "/api/projects/legacy-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).response.status).toBe(200);
    const versions = await request(firstServer, "/api/projects/legacy-app/versions");
    const entry = versions.value.history[0];
    const journal = JSON.parse(readFileSync(join(workspace, "states/legacy-app.versions.json"), "utf8"));
    const oldRoot = journal.entries[0].packages.find((pkg: any) => pkg.id === "legacy.app");
    // An unavailable historical child may precede the root in a journal.
    // The root's signed payload digest still identifies the actual SystemUI.
    journal.entries[0].packages.unshift({ id: "child.before.root", version: "1.0.0", build: 1, artifactRoot: ".history/missing-child" });
    writeFileSync(join(workspace, "states/legacy-app.versions.json"), JSON.stringify(journal));
    const reorderedIndex = await request(firstServer, "/stable/pocket/4.0.0/legacy.app/latest.json");
    expect(reorderedIndex.response.status).toBe(200);
    expect(reorderedIndex.value.systemUI).toBe("legacy.app");
    const reorderedHost = await request(firstServer, reorderedIndex.value.latest.hostConfigUrl);
    expect(reorderedHost.response.status).toBe(200);
    expect(reorderedHost.value.systemUI).toBe(reorderedIndex.value.systemUI);
    const oldArtifactRoot = join(workspace, "updates", oldRoot.artifactRoot);
    const canonical = join(workspace, "updates/pocket/4.0.0/legacy.app/stable");
    cpSync(oldArtifactRoot, canonical, { recursive: true });
    const canonicalHost = JSON.parse(readFileSync(join(canonical, "host.json"), "utf8"));
    canonicalHost.POCKET_PACKAGE_VERSION = "stable";
    writeFileSync(join(canonical, "host.json"), JSON.stringify(canonicalHost, null, 2) + "\n");
    const legacyChild = join(workspace, "updates/pocket/4.0.0/legacy.child/stable");
    cpSync(canonical, legacyChild, { recursive: true });
    writeFileSync(join(legacyChild, "host.json"), JSON.stringify({ kind: "pocket-mini-app-host-template", config: { appId: "legacy.child" } }));
    const legacySnapshotPath = join(workspace, "builds/legacy-app", String(status.builtRevision), RESOURCE_SNAPSHOT_FILE);
    const legacySnapshot = JSON.parse(readFileSync(legacySnapshotPath, "utf8"));
    legacySnapshot.packages.push({
      id: "legacy.child",
      title: "Legacy child",
      manifest: "child/pocket.json",
      version: "1.0.0",
      build: 1,
      runtimeAbi: "legacy-abi",
      artifactDirectory: ".",
      resources: [],
    });
    writeFileSync(legacySnapshotPath, JSON.stringify(legacySnapshot, null, 2) + "\n");
    writeFileSync(join(workspace, "builds/legacy-app", String(status.builtRevision), "pocket.system.json"), JSON.stringify({
      "$schema": "https://pocketjs.dev/schema/pocket-system-1.json",
      pocketSystem: 1,
      id: "legacy.system",
      name: "legacy-system",
      title: "Legacy system",
      version: "1.0.0",
      roles: { systemUI: "legacy.app" },
      applications: {
        installPolicy: { model: "managed", mutable: false },
        backgroundExecution: "suspend",
        catalog: [
          { package: "legacy.app", manifest: "pocket.json", required: true },
          { package: "unpublished.before", manifest: "before/pocket.json", required: false },
          { package: "legacy.child", manifest: "child/pocket.json", required: true },
          { package: "pocket.demo.lantern", manifest: "lantern/pocket.json", required: false },
        ],
      },
      installation: { installedPackages: ["legacy.app", "unpublished.before", "legacy.child", "pocket.demo.lantern"] },
    }, null, 2) + "\n");
    const legacyStatePath = join(workspace, "states/legacy-app.json");
    const legacyState = JSON.parse(readFileSync(legacyStatePath, "utf8"));
    legacyState.publish.packages = [{ id: "legacy.child" }];
    writeFileSync(legacyStatePath, JSON.stringify(legacyState));
    rmSync(join(workspace, "states/legacy-app.versions.json"));
    const oldState = readFileSync(join(workspace, "states/legacy-app.json"));
    expect(oldState.byteLength).toBeGreaterThan(0);
  } finally {
    firstServer.stop(true);
  }
  const externalProject = temporaryWorkspace();
  cpSync(join(workspace, "projects/legacy-app"), externalProject, { recursive: true });
  rmSync(join(workspace, "projects/legacy-app"), { recursive: true, force: true });
  const aliasServer = await startEditor({ ...options, updateHostVersion: "5.0.0", projectRoot: externalProject });
  try {
    const legacyVersions = await request(aliasServer, "/api/projects/legacy-app/versions");
    expect(legacyVersions.value.hostVersion).toBe("5.0.0");
    expect(legacyVersions.value.appConfigUrl).toContain("/stable/pocket/5.0.0/legacy.app/latest.json");
    const legacyAggregate = await request(aliasServer, new URL(legacyVersions.value.appConfigUrl).pathname);
    expect(legacyAggregate.response.status).toBe(200);
    expect(legacyAggregate.value.kind).toBe("pocket-editor-package-index");
    expect(legacyAggregate.value.projectId).toBe("legacy-app");
    expect(legacyAggregate.value.systemUI).toBe("legacy.app");
    const selectedHost = await request(aliasServer, legacyAggregate.value.latest.hostConfigUrl);
    expect(selectedHost.response.status).toBe(200);
    expect(legacyAggregate.value.rootAppId).toBe(selectedHost.value.systemUI);
    expect(Object.keys(selectedHost.value.applications).sort()).toEqual(["legacy.app", "legacy.child"]);
    expect(selectedHost.value.compositorSurfaces).toEqual({ "legacy.child": 3 });
    const childIndex = await request(aliasServer, "/stable/pocket/5.0.0/legacy.child/latest.json");
    expect(childIndex.response.status).toBe(200);
    expect(childIndex.value.systemUI).toBe("legacy.app");
    expect(childIndex.value.projectId).toBe("legacy-app");
    expect(legacyAggregate.value.latest.hostConfigUrl).toContain("/pocket/5.0.0/legacy.app/1.0.0-build.1/host.json");
    expect(legacyAggregate.value.latest.archiveUrl).toContain("/releases/legacy-app/legacy-");
    const legacyArchive = await request(aliasServer, legacyAggregate.value.latest.archiveUrl);
    expect(legacyArchive.response.status).toBe(200);
    expect(legacyArchive.response.headers.get("content-disposition")).toContain("legacy-app-legacy-");
    const legacyArchivePath = join(fixture, "legacy-complete.tar.gz");
    writeFileSync(legacyArchivePath, new Uint8Array(legacyArchive.value));
    const legacyExtracted = join(fixture, "legacy-complete-extracted");
    mkdirSync(legacyExtracted, { recursive: true });
    expect(spawnSync("tar", ["-xzf", legacyArchivePath, "-C", legacyExtracted]).status).toBe(0);
    expect(existsSync(join(legacyExtracted, "pocket", "5.0.0", "legacy.app", "1.0.0-build.1", "latest.json"))).toBe(true);
    expect(existsSync(join(legacyExtracted, "pocket", "5.0.0", "legacy.app", "1.0.0-build.1", "host.json"))).toBe(true);
    expect((await request(aliasServer, "/pocket/5.0.0/legacy.app/1.0.0-build.1/host.json")).response.status).toBe(200);
    const semanticLegacyManifest = await request(aliasServer, "/pocket/5.0.0/legacy.app/1.0.0-build.1/latest.json");
    expect(semanticLegacyManifest.response.status).toBe(200);
    expect(JSON.parse(Buffer.from(semanticLegacyManifest.value.payload, "base64")).build).toBe(1);
    expect((await request(aliasServer, "/stable/pocket/5.0.0/legacy.app/1.0.0/latest.json")).response.status).toBe(200);
  } finally {
    aliasServer.stop(true);
    cpSync(externalProject, join(workspace, "projects/legacy-app"), { recursive: true });
    rmSync(externalProject, { recursive: true, force: true });
  }
  // The next publish contains the original root only. Keep the newer system
  // surface declarations, so migration must also clear all unpublished handles.
  const migrationState = JSON.parse(readFileSync(join(workspace, "states/legacy-app.json"), "utf8"));
  const migrationSnapshotPath = join(workspace, "builds/legacy-app", String(migrationState.builtRevision), RESOURCE_SNAPSHOT_FILE);
  const migrationSnapshot = JSON.parse(readFileSync(migrationSnapshotPath, "utf8"));
  migrationSnapshot.packages = migrationSnapshot.packages.filter((pkg: any) => pkg.id === "legacy.app");
  writeFileSync(migrationSnapshotPath, JSON.stringify(migrationSnapshot));
  const secondServer = await startEditor(options);
  try {
    const migrated = await request(secondServer, "/api/projects/legacy-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(migrated.response.status, JSON.stringify(migrated.value)).toBe(200);
    const history = await request(secondServer, "/api/projects/legacy-app/versions");
    expect(history.value.history).toHaveLength(1);
    const migratedJournal = JSON.parse(readFileSync(join(workspace, "states/legacy-app.versions.json"), "utf8"));
    const migratedRoot = migratedJournal.entries[0].packages.find((pkg: any) => pkg.id === "legacy.app");
    const migratedRootPath = join(workspace, "updates", migratedRoot.artifactRoot);
    expect(readFileSync(join(migratedRootPath, "latest.json"))).toEqual(readFileSync(join(workspace, "updates/pocket/4.0.0/legacy.app/stable/latest.json")));
    expect(readFileSync(join(migratedRootPath, "payload.json"))).toEqual(readFileSync(join(workspace, "updates/pocket/4.0.0/legacy.app/stable/payload.json")));
    const migratedHost = JSON.parse(readFileSync(join(migratedRootPath, "host.json"), "utf8"));
    expect(migratedHost.compositorSurfaces).toEqual({});
  } finally {
    secondServer.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("compatibility branches stay isolated across restart and host versions", async () => {
  const workspace = temporaryWorkspace();
  const fixture = temporaryWorkspace();
  const appJs = join(fixture, "app.js");
  const bytecode = join(fixture, "app.qjbc");
  const metadata = join(fixture, "app.bytecode.json");
  const pak = join(fixture, "app.pak");
  writeFileSync(appJs, "globalThis.__branch_fixture = true;\n");
  writeFileSync(bytecode, Buffer.from([0x50, 0x4a, 0x42, 0x43, 8, 9, 10]));
  writeFileSync(metadata, JSON.stringify({ entryFormat: "quickjs-bytecode", runtimeAbi: "branch-abi", bytecodeBytes: 7 }));
  writeFileSync(pak, pack([{ key: "branch:text", dtype: 0, data: new Uint8Array([8, 9, 10]) }]));
  const options = (hostVersion: string) => ({
    port: 0,
    updateHost: "127.0.0.1",
    updatePort: 0,
    updateHostVersion: hostVersion,
    updatePackageVersion: "0.1.0",
    workspace,
    buildRunner: async () => ({ appJs, bytecode, metadata, pak, runtimeAbi: "branch-abi", bytecodeMetadata: JSON.parse(readFileSync(metadata, "utf8")) }),
  } as const);
  const createAndBuild = async (server: ReturnType<typeof Bun.serve>): Promise<void> => {
    const created = await request(server, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "branch-app", name: "Branch", appId: "branch.app", version: "0.1.0", build: 1 }) });
    expect(created.response.status).toBe(201);
    await request(server, "/api/projects/branch-app/build", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const status = await waitForBuild(server, "branch-app");
    expect(status.error).toBeUndefined();
  };
  let server = await startEditor(options("4.0.0"));
  try {
    await createAndBuild(server);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const published = await request(server, "/api/projects/branch-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "test" }) });
      expect(published.response.status).toBe(200);
      expect(published.value.manifestUrl).toContain("/test/pocket/4.0.0/branch.app/0.1.0/latest.json");
    }
    const firstSnapshot = await request(server, "/api/projects/branch-app/versions");
    expect(firstSnapshot.value.history).toHaveLength(2);
    expect(firstSnapshot.value.current["branch:test:4.0.0:0.1.0"]).toBe(firstSnapshot.value.history[0].releaseId);
    const host4Url = firstSnapshot.value.appConfigUrl;
    expect(host4Url).toContain("/test/pocket/4.0.0/branch.app/latest.json");
    expect((await request(server, new URL(host4Url).pathname)).response.status).toBe(200);
  } finally {
    server.stop(true);
  }

  server = await startEditor(options("5.0.0"));
  try {
    const host5Publish = await request(server, "/api/projects/branch-app/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "test" }) });
    expect(host5Publish.response.status).toBe(200);
    expect(host5Publish.value.manifestUrl).toContain("/test/pocket/5.0.0/branch.app/0.1.0/latest.json");
    const host5Snapshot = await request(server, "/api/projects/branch-app/versions");
    expect(host5Snapshot.value.history).toHaveLength(1);
    expect(host5Snapshot.value.appConfigUrl).toContain("/test/pocket/5.0.0/branch.app/latest.json");
    expect((await request(server, new URL(host5Snapshot.value.appConfigUrl).pathname)).response.status).toBe(200);
    const host4Manifest = await request(server, "/test/pocket/4.0.0/branch.app/0.1.0/latest.json");
    expect(host4Manifest.response.status).toBe(200);
  } finally {
    server.stop(true);
  }

  server = await startEditor(options("4.0.0"));
  try {
    const restarted = await request(server, "/api/projects/branch-app/versions");
    expect(restarted.value.appConfigUrl).toContain("/test/pocket/4.0.0/branch.app/latest.json");
    const aggregate = await request(server, new URL(restarted.value.appConfigUrl).pathname);
    expect(aggregate.response.status).toBe(200);
    expect(aggregate.value.kind).toBe("pocket-editor-package-index");
    const descriptor = await request(server, new URL(aggregate.value.latest.hostConfigUrl, restarted.value.appConfigUrl).pathname);
    expect(descriptor.value.kind).toBe("pocket-editor-app-host");
    expect(descriptor.value.applications["branch.app"].manifestUrl).toContain("/pocket/4.0.0/branch.app/");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
