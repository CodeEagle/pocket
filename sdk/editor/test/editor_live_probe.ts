/**
 * Production editor smoke probe.
 *
 * Unlike editor_server.test.ts this intentionally uses the default runner:
 * pinned PocketJS compiler -> native pocketjs_bytecode -> package_update.ts.
 * It leaves the temporary workspace in place so the artifact paths printed at
 * the end can be inspected or fed to another verifier.
 */

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifySignedManifest } from "../../scripts/package_update.ts";
import { startEditor } from "../server.ts";

const root = resolve(import.meta.dir, "../..");
const id = `live-probe-${Date.now().toString(36)}`;
const workspace = mkdtempSync(join(tmpdir(), "pocket-editor-live-"));
const serverBase = (server: ReturnType<typeof Bun.serve>): string => `http://${server.hostname}:${server.port}`;

type JsonRecord = Record<string, any>;

async function responseValue(response: Response): Promise<any> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

async function request(base: string, path: string, init?: RequestInit): Promise<{ response: Response; value: any }> {
  const response = await fetch(path.startsWith("http") ? path : `${base}${path}`, init);
  const value = await responseValue(response);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> HTTP ${response.status}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return { response, value };
}

async function bytesAt(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function textAt(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return response.text();
}

async function waitForIdle(base: string): Promise<JsonRecord> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const status = (await request(base, `/api/projects/${id}/status`)).value as JsonRecord;
    if (!status.busy) return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("editor build did not finish within 180 seconds");
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function main(): Promise<void> {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let failure: Error | undefined;
  let report: JsonRecord = { ok: false, workspace };
  try {
    server = await startEditor({ port: 0, workspace });
    const base = serverBase(server);
    const created = (await request(base, "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, name: "Pocket Editor Live Probe", version: "0.1.0", tickHz: 60 }),
    })).value as JsonRecord;
    assert.equal(created.appId, "pocket.host.demo");

    const buildResponse = await request(base, `/api/projects/${id}/build`, { method: "POST", body: "{}" });
    assert.equal(buildResponse.response.status, 202);
    const built = await waitForIdle(base);
    assert.equal(built.error, undefined, built.error);
    assert.equal(built.builtRevision, built.revision);
    assert.equal(built.artifacts.revision, built.revision);

    const metadata = (await request(base, built.artifacts.metadata)).value as JsonRecord;
    const qjbc = await bytesAt(`${base}${built.artifacts.bytecode}`);
    const pak = await bytesAt(`${base}${built.artifacts.pak}`);
    assert.equal(metadata.entryFormat, "quickjs-bytecode");
    assert.equal(typeof metadata.runtimeAbi, "string");
    assert.equal(metadata.bytecodeBytes, qjbc.byteLength);

    const published = (await request(base, `/api/projects/${id}/publish`, { method: "POST", body: "{}" })).value as JsonRecord;
    const manifestUrl = String(published.manifestUrl);
    const hostConfigUrl = String(published.hostConfigUrl);
    const hostConfig = (await request(base, hostConfigUrl)).value as JsonRecord;
    const latestText = await textAt(manifestUrl);
    const envelope = JSON.parse(latestText) as JsonRecord;
    const key = JSON.parse(readFileSync(join(workspace, "keys/editor-dev-key.json"), "utf8")) as JsonRecord;
    assert.equal(hostConfig.POCKET_UPDATE_URL, manifestUrl);
    assert.equal(hostConfig.POCKET_UPDATE_KEY_ID, envelope.keyId);
    assert.equal(hostConfig.POCKET_UPDATE_PUBLIC_KEY, key.publicKeyBase64);
    assert.equal(Buffer.from(hostConfig.POCKET_UPDATE_PUBLIC_KEY, "base64").byteLength, 32);
    const signedPayloadBytes = verifySignedManifest(envelope as any, key.publicKeyPem);
    const payload = JSON.parse(new TextDecoder().decode(signedPayloadBytes)) as JsonRecord;
    assert.equal(payload.appId, "pocket.host.demo");
    assert.equal(payload.entryFormat, "quickjs-bytecode");
    assert.equal(payload.runtimeAbi, metadata.runtimeAbi);
    assert.equal(payload.entry.size, qjbc.byteLength);
    assert.equal(payload.entry.sha256, hash(qjbc));
    assert.equal(payload.pak.size, pak.byteLength);
    assert.equal(payload.pak.sha256, hash(pak));

    const blobs = new Map<string, Uint8Array>();
    for (const file of payload.files as Array<{ sha256: string; size: number; url: string }>) {
      const blob = await bytesAt(new URL(file.url, manifestUrl).toString());
      assert.equal(blob.byteLength, file.size, `blob size ${file.sha256}`);
      assert.equal(hash(blob), file.sha256, `blob hash ${file.sha256}`);
      blobs.set(file.sha256, blob);
    }
    const reconstructedPak = new Uint8Array(payload.pak.size);
    for (const part of payload.pak.parts as Array<{ offset: number; sha256: string; size: number }>) {
      const blob = blobs.get(part.sha256);
      assert.ok(blob, `missing PAK blob ${part.sha256}`);
      assert.equal(blob!.byteLength, part.size);
      reconstructedPak.set(blob!, part.offset);
    }
    assert.equal(hash(reconstructedPak), payload.pak.sha256);

    // A failed build must not make the previous good qjbc publishable. The
    // signed latest.json must remain byte-for-byte unchanged as well.
    const sourcePath = `/api/projects/${id}/files/app.tsx`;
    const badSource = await request(base, sourcePath);
    const badRevision = (await request(base, sourcePath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "export const broken = (\n" }),
    })).value.revision as number;
    assert.equal(badRevision, built.revision + 1);
    await request(base, `/api/projects/${id}/build`, { method: "POST", body: "{}" });
    const failed = await waitForIdle(base);
    assert.equal(failed.builtRevision, built.revision);
    assert.equal(failed.artifacts.revision, built.revision);
    assert.ok(typeof failed.error === "string" && failed.error.length > 0, "invalid source must report a compiler error");
    const rejectedPublish = await fetch(`${base}/api/projects/${id}/publish`, { method: "POST", body: "{}" });
    assert.equal(rejectedPublish.status, 400);
    assert.equal(await textAt(manifestUrl), latestText);
    // Keep the unused value explicit: the probe also proves the original
    // source endpoint remains available for backwards-compatible clients.
    assert.ok(String(badSource.value.content).includes("Hello PocketJS"));

    report = {
      ok: true,
      workspace,
      projectId: id,
      buildRevision: built.revision,
      runtimeAbi: metadata.runtimeAbi,
      qjbcBytes: qjbc.byteLength,
      pakBytes: pak.byteLength,
      manifestUrl,
      hostConfigUrl,
      buildArtifactDir: join(workspace, "builds", id, String(built.revision)),
      releaseDir: join(workspace, "updates", id),
      rejectedBadBuild: { revision: failed.revision, error: failed.error },
    };
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    report = { ok: false, workspace, projectId: id, error: failure.message };
  } finally {
    server?.stop(true);
  }
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}

if (import.meta.main) await main();

