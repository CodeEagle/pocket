import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, createPublicKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";
import { PREVIEW_APP_ID } from "../preview_publish.ts";
import { verifySignedManifest } from "../../scripts/package_update.ts";

// Real service, real pinned compiler, real signing. Nothing here executes the
// bytecode; the Flutter FFI test (studio_preview_ffi_test.dart) does.
type Server = Awaited<ReturnType<typeof startEditor>>;
let workspace = "";
let server: Server;
let base = "";
let csrf = "";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

async function api(path: string, init: { method?: string; json?: unknown; auth?: boolean } = {}): Promise<{ status: number; body: any }> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET" && init.auth !== false) headers["x-pocket-csrf"] = csrf;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body };
}

async function waitIdle(id: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = (await api(`/api/projects/${id}/status`)).body;
    if (!status.busy) return status;
    if (Date.now() > deadline) throw new Error("build did not finish");
    await Bun.sleep(50);
  }
}

async function build(id: string): Promise<any> {
  expect((await api(`/api/projects/${id}/build`, { method: "POST", json: {} })).status).toBe(202);
  const status = await waitIdle(id);
  expect(status.error).toBeUndefined();
  expect(status.builtRevision).toBe(status.revision);
  return status;
}

async function edit(id: string, marker: string): Promise<void> {
  const source = (await api(`/api/projects/${id}/files/app.tsx`)).body;
  const content = String(source.content ?? source).replace(/PREVIEW_MARKER_[A-Za-z0-9]+|(?=<\/Screen>)/, (match) => match.startsWith("PREVIEW_MARKER") ? marker : `<Text>${marker}</Text>`);
  expect((await api(`/api/projects/${id}/files/app.tsx`, { method: "PUT", json: { content } })).status).toBe(200);
}

/** Rebuild a verifier key from the raw public key that host.json publishes. */
function publicKeyOf(hostJson: any): string {
  const raw = Buffer.from(hostJson.POCKET_UPDATE_PUBLIC_KEY, "base64");
  expect(raw.length).toBe(32);
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" })
    .export({ type: "spki", format: "pem" }).toString();
}

async function startServer(): Promise<void> {
  server = await startEditor({ port: 0, workspace, updateHostVersion: "studio-test" });
  base = `http://127.0.0.1:${server.port}`;
  csrf = (await (await fetch(`${base}/health`)).json()).csrfToken;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "pocket-preview-publish-"));
  await startServer();
  const created = await api("/api/projects", { method: "POST", json: { id: "pv-app", name: "Preview App", version: "0.1.0", tickHz: 60 } });
  expect(created.status).toBe(201);
});

afterAll(async () => {
  await server.stop(true);
  rmSync(workspace, { recursive: true, force: true });
});

test("the preview signing key exists right after startup, before any publish, and is never rotated", async () => {
  // A trusted host reads the public key at its own startup to configure the signed preview child.
  const keyPath = join(workspace, "keys", "editor-preview-key.json");
  expect(existsSync(keyPath)).toBe(true);
  const first = JSON.parse(readFileSync(keyPath, "utf8"));
  expect(first.keyId).toBe("editor-preview");
  expect(typeof first.publicKeyBase64).toBe("string");
  expect(existsSync(join(workspace, "updates", ".preview"))).toBe(false); // nothing was published
  await server.stop(true);
  await startServer();
  expect(JSON.parse(readFileSync(keyPath, "utf8")).publicKeyBase64).toBe(first.publicKeyBase64);
});

test("preview-publish requires a successful current build (409)", async () => {
  const early = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} });
  expect(early.status).toBe(409);
  expect(String(early.body.error)).toContain("build");
});

test("guards: missing write credential is 403, unknown project 404", async () => {
  const noCredential = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {}, auth: false });
  expect(noCredential.status).toBe(403);
  const wrong = await fetch(`${base}/api/projects/pv-app/preview-publish`, { method: "POST", headers: { "x-pocket-csrf": "wrong", "content-type": "application/json" }, body: "{}" });
  expect(wrong.status).toBe(403);
  expect((await api("/api/projects/nope/preview-publish", { method: "POST", json: {} })).status).toBe(404);
  expect((await api("/api/projects/pv-app/preview-publish")).status).not.toBe(200);
});

test("happy path: fixed preview id, signed manifest verifies with the host.json key, no absolute paths", async () => {
  await build("pv-app");
  const configBefore = readFileSync(join(workspace, "projects/pv-app/pocket.json"), "utf8");
  const publish = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} });
  expect(publish.status).toBe(200);
  const result = publish.body;
  expect(Object.keys(result).sort()).toEqual([
    "build", "buildId", "generation", "hostConfigUrl", "keyId", "manifestUrl", "packageId", "payloadSha256",
    "revision", "runtimeAbi", "timingsMs", "version",
  ]);
  expect(result.packageId).toBe(PREVIEW_APP_ID);
  expect(result.buildId).toBe("pv-app@" + result.revision);
  expect(result.version).toBe(`0.1.0-preview.${result.build}`);
  expect(result.timingsMs.total).toBeGreaterThanOrEqual(result.timingsMs.package);
  expect(result.timingsMs.sign).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(result)).not.toContain(workspace);
  expect(result.manifestUrl).toBe(`${base}/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/latest.json`);
  // The project's own identity is untouched.
  expect(readFileSync(join(workspace, "projects/pv-app/pocket.json"), "utf8")).toBe(configBefore);

  const host = (await api(`/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/host.json`)).body;
  expect(host.POCKET_UPDATE_URL).toBe(result.manifestUrl);
  expect(host.POCKET_UPDATE_KEY_ID).toBe(result.keyId);
  expect(JSON.stringify(host)).not.toContain("PRIVATE");
  const manifestResponse = await fetch(result.manifestUrl);
  expect(manifestResponse.status).toBe(200);
  const envelope = await manifestResponse.json() as { keyId: string; payload: string; signature: string };
  expect(envelope.keyId).toBe(host.POCKET_UPDATE_KEY_ID);
  const payloadBytes = verifySignedManifest(envelope, publicKeyOf(host));
  expect(sha(payloadBytes)).toBe(result.payloadSha256);
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  expect(payload.appId).toBe(PREVIEW_APP_ID);
  expect(payload.build).toBe(result.build);
  expect(payload.entryFormat).toBe("quickjs-bytecode");
  expect(payload.runtimeAbi).toBe(result.runtimeAbi);
  // Every blob served by the slot matches the signed hash.
  for (const file of payload.files as Array<{ url: string; sha256: string; size: number }>) {
    const blob = new Uint8Array(await (await fetch(`${base}/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/${file.url}`)).arrayBuffer());
    expect(blob.length).toBe(file.size);
    expect(sha(blob)).toBe(file.sha256);
  }
  // Public bootstrap metadata is served; unrelated paths are not.
  expect((await api(`/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/bootstrap/app.bytecode.json`)).status).toBe(200);
  expect((await fetch(`${base}/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/../../x`)).status).toBeGreaterThanOrEqual(400);
  expect((await fetch(`${base}/preview/pocket/studio-test/${PREVIEW_APP_ID}/stable/latest.json`)).status).toBe(404);
  expect((await fetch(`${base}/preview/pocket/studio-test/other.app/preview/latest.json`)).status).toBe(404);
});

test("a stale build (source edited after build) is rejected", async () => {
  await edit("pv-app", "PREVIEW_MARKER_stale");
  const stale = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} });
  expect(stale.status).toBe(409);
  await build("pv-app");
});

test("tampered manifest or blob is rejected by signature and hash checks", async () => {
  const publish = (await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} })).body;
  const host = (await api(`/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/host.json`)).body;
  const key = publicKeyOf(host);
  const envelope = await (await fetch(publish.manifestUrl)).json() as { keyId: string; payload: string; signature: string };
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
  payload.build += 1;
  const forged = { ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64") };
  expect(() => verifySignedManifest(forged, key)).toThrow(/signature/);
  const original = JSON.parse(Buffer.from(envelope.payload, "base64").toString());
  const entry = original.files.find((file: any) => file.sha256 === original.entry.sha256);
  const blob = new Uint8Array(await (await fetch(`${base}/preview/pocket/studio-test/${PREVIEW_APP_ID}/preview/${entry.url}`)).arrayBuffer());
  const tampered = blob.slice();
  tampered[tampered.length - 1] ^= 0xff;
  expect(sha(tampered)).not.toBe(entry.sha256);
  // A different key (the editor's test key is not the preview key) cannot verify it either.
  const testKeyPath = join(workspace, "keys/editor-dev-key.json");
  if (existsSync(testKeyPath)) {
    const other = JSON.parse(readFileSync(testKeyPath, "utf8"));
    expect(() => verifySignedManifest(envelope, other.publicKeyPem)).toThrow(/signature/);
  }
});

test("build numbers are monotonic across publishes and across a server restart", async () => {
  const builds: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const response = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} });
    expect(response.status).toBe(200);
    builds.push(response.body.build);
  }
  expect(builds[1]).toBeGreaterThan(builds[0]!);
  await server.stop(true);
  await startServer();
  await build("pv-app");
  const afterRestart = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} });
  expect(afterRestart.status).toBe(200);
  expect(afterRestart.body.build).toBeGreaterThan(builds[1]!);
  const counters = JSON.parse(readFileSync(join(workspace, "states/preview-slots.json"), "utf8"));
  expect(counters.slots[`studio-test/${PREVIEW_APP_ID}`].build).toBe(afterRestart.body.build);
});

test("preview publish never touches test/stable slots, state.publish or the version history", async () => {
  const testPublish = await api("/api/projects/pv-app/publish", { method: "POST", json: { channel: "test" } });
  expect(testPublish.status).toBe(200);
  const historyPath = join(workspace, "states/pv-app.versions.json");
  const historyBefore = readFileSync(historyPath, "utf8");
  const publishBefore = JSON.stringify((await api("/api/projects/pv-app/status")).body.publish);
  const versionsBefore = JSON.stringify((await api("/api/projects/pv-app/versions")).body);
  const testManifestBefore = await (await fetch(testPublish.body.manifestUrl)).text();
  const updatesBefore = readdirSync(join(workspace, "updates"), { recursive: true }).map(String).filter((name) => !name.startsWith(".preview")).sort();

  const preview = await api("/api/projects/pv-app/preview-publish", { method: "POST", json: {} });
  expect(preview.status).toBe(200);

  expect(readFileSync(historyPath, "utf8")).toBe(historyBefore);
  expect(JSON.stringify((await api("/api/projects/pv-app/status")).body.publish)).toBe(publishBefore);
  expect(JSON.stringify((await api("/api/projects/pv-app/versions")).body)).toBe(versionsBefore);
  expect(await (await fetch(testPublish.body.manifestUrl)).text()).toBe(testManifestBefore);
  const updatesAfter = readdirSync(join(workspace, "updates"), { recursive: true }).map(String).filter((name) => !name.startsWith(".preview")).sort();
  expect(updatesAfter).toEqual(updatesBefore);
  // The test slot keeps its own app id and is not the preview package.
  const testPayload = JSON.parse(Buffer.from((JSON.parse(testManifestBefore) as any).payload, "base64").toString());
  expect(testPayload.appId).not.toBe(PREVIEW_APP_ID);
  // A stable publish still works afterward, with its own ownership checks.
  const stable = await api("/api/projects/pv-app/publish", { method: "POST", json: { channel: "release" } });
  expect(stable.status).toBe(200);
});

test("busy project is rejected while a build runs", async () => {
  // The first real compile in a fresh workspace can be slow on a cold machine.
  const slowWorkspace = mkdtempSync(join(tmpdir(), "pocket-preview-busy-"));
  const slow = await startEditor({
    port: 0, workspace: slowWorkspace,
    buildRunner: async ({ signal }) => {
      await new Promise<void>((_, reject) => { signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
      throw new Error("unreachable");
    },
  });
  try {
    const slowBase = `http://127.0.0.1:${slow.port}`;
    const token = (await (await fetch(`${slowBase}/health`)).json()).csrfToken;
    const headers = { "x-pocket-csrf": token, "content-type": "application/json" };
    await fetch(`${slowBase}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: "slow-app", name: "Slow", version: "0.1.0", tickHz: 60 }) });
    await fetch(`${slowBase}/api/projects/slow-app/build`, { method: "POST", headers, body: "{}" });
    const busy = await fetch(`${slowBase}/api/projects/slow-app/preview-publish`, { method: "POST", headers, body: "{}" });
    expect(busy.status).toBe(409);
    await fetch(`${slowBase}/api/projects/slow-app/build/cancel`, { method: "POST", headers, body: "{}" });
  } finally {
    await slow.stop(true);
    rmSync(slowWorkspace, { recursive: true, force: true });
  }
}, 60_000);
