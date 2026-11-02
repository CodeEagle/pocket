import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../../.cache/pocketjs/framework/compiler/pak.ts";
import { startEditor } from "../server.ts";

function temporaryWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "pocket-editor-service-"));
}

async function request(server: ReturnType<typeof Bun.serve>, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const response = await fetch(`http://${server.hostname}:${server.port}${path}`, init);
  const contentType = response.headers.get("content-type") || "";
  const value = contentType.includes("application/json") ? await response.json() : await response.arrayBuffer();
  return { response, value };
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
    workspace,
    buildRunner: async ({ log }) => {
      log("fixture compiler: real runner is injected only by this service test");
      return { appJs, bytecode, metadata, pak, runtimeAbi: "fixture-abi-v1", bytecodeMetadata: JSON.parse(await Bun.file(metadata).text()) };
    },
  });
  try {
    const index = await request(server, "/");
    expect(index.response.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(index.value))).toContain("Pocket Studio");
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
    expect(source.value.source).toContain("Hello PocketJS");

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

    const build = await request(server, "/api/projects/fixture-app/build", { method: "POST", body: "{}" });
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

    const artifact = await request(server, "/api/projects/fixture-app/artifacts/app.qjbc");
    expect(artifact.response.status).toBe(200);
    expect(new Uint8Array(artifact.value)).toEqual(new Uint8Array([0x51, 0x4a, 0x42, 0x43, 1, 2, 3]));

    const published = await request(server, "/api/projects/fixture-app/publish", { method: "POST", body: "{}" });
    expect(published.response.status).toBe(200);
    expect(published.value.status.publish.runtimeAbi).toBe("fixture-abi-v1");
    expect(published.value.manifestUrl).toContain("/updates/fixture-app/latest.json");
    expect(published.value.hostConfigUrl).toContain("/updates/fixture-app/host.json");
    const latest = await request(server, "/updates/fixture-app/latest.json");
    expect(latest.response.status).toBe(200);
    const envelope = latest.value;
    const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    expect(payload.entryFormat).toBe("quickjs-bytecode");
    expect(payload.appId).toBe("pocket.host.demo");
    expect(payload.runtimeAbi).toBe("fixture-abi-v1");
    const hostConfig = await request(server, "/updates/fixture-app/host.json");
    expect(hostConfig.response.status).toBe(200);
    expect(hostConfig.value.POCKET_UPDATE_URL).toContain("/updates/fixture-app/latest.json");
    expect(hostConfig.value.POCKET_UPDATE_KEY_ID).toBe(envelope.keyId);
    expect(Buffer.from(hostConfig.value.POCKET_UPDATE_PUBLIC_KEY, "base64")).toHaveLength(32);
    const archive = await request(server, "/releases/fixture-app.tar.gz");
    expect(archive.response.status).toBe(200);
    expect(new Uint8Array(archive.value).byteLength).toBeGreaterThan(100);
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
    const build = await request(server, "/api/projects/external-app/build", { method: "POST", body: "{}" });
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

test("editor enforces security boundaries against CSRF, Host header poisoning, and symlinks", async () => {
  const workspace = temporaryWorkspace();
  const externalDir = temporaryWorkspace();
  const secretFile = join(externalDir, "secret.json");
  writeFileSync(secretFile, JSON.stringify({ secret: "classified" }));

  const server = await startEditor({ port: 0, workspace });
  try {
    // 1. Cross-origin Origin: https://evil.example POST is rejected with 403
    const crossOrigin = await request(server, "/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ id: "evil-app" }),
    });
    expect(crossOrigin.response.status).toBe(403);

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
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});
