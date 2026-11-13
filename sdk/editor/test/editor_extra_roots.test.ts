import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

// Host-configured extra project roots (Studio self-hosting): listed, editable and buildable like the primary
// project, never addable through HTTP, and rejected at startup when unsafe. Real service, real pinned compiler.
type Server = Awaited<ReturnType<typeof startEditor>>;
let temp = "";
let primary = "";
let extra = "";
let server: Server;
let base = "";
let csrf = "";
const servers: Server[] = [];

function makeProject(root: string, id: string, appId: string, marker: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" }, version: "1.0.0", build: 1 }));
  writeFileSync(join(root, "editor.json"), JSON.stringify({ id, appId, name: id, title: id, version: "1.0.0", build: 1, tickHz: 60, entry: "app.tsx", output: "app", framework: "solid" }));
  writeFileSync(join(root, "manifest.json"), '{"capabilities":{"requires":[]}}');
  writeFileSync(join(root, "app.tsx"), `import { mount } from "@pocketjs/framework/solid";\nimport { Screen, Text } from "@pocketjs/framework/solid/components";\nmount(() => <Screen class="w-full h-full"><Text class="text-base text-black">${marker}</Text></Screen>);\n`);
}

async function api(path: string, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: any }> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-pocket-csrf"] = csrf;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  const text = await response.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body };
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "pocket-extra-roots-"));
  primary = join(temp, "primary");
  extra = join(temp, "self");
  makeProject(primary, "main-app", "pocket.main", "MAIN_MARKER");
  makeProject(extra, "self-app", "dev.pocket.self", "SELF_V0");
  server = await startEditor({ port: 0, workspace: join(temp, "ws"), projectRoot: primary, extraProjectRoots: [extra], provisionUpdateKey: true, updateHostVersion: "extra-test" });
  servers.push(server);
  base = `http://127.0.0.1:${server.port}`;
  csrf = (await (await fetch(`${base}/health`)).json()).csrfToken;
});

afterAll(async () => {
  for (const item of servers) await item.stop(true);
  rmSync(temp, { recursive: true, force: true });
});

test("an extra root is listed next to the primary project and is editable", async () => {
  const list = (await api("/api/projects")).body as Array<{ id: string; appId: string }>;
  expect(list.map((project) => project.id).sort()).toEqual(["main-app", "self-app"]);
  expect(list.find((project) => project.id === "self-app")?.appId).toBe("dev.pocket.self");
  const read = await api("/api/projects/self-app/files/app.tsx");
  expect(read.status).toBe(200);
  expect(String(read.body.content)).toContain("SELF_V0");
  const content = String(read.body.content).replace("SELF_V0", "SELF_V1");
  expect((await api("/api/projects/self-app/files/app.tsx", { method: "PUT", json: { content } })).status).toBe(200);
  expect(readFileSync(join(extra, "app.tsx"), "utf8")).toContain("SELF_V1");
  expect(readFileSync(join(primary, "app.tsx"), "utf8")).toContain("MAIN_MARKER");
});

test("an extra root cannot be created over HTTP and the project body cannot name a root", async () => {
  expect((await api("/api/projects", { method: "POST", json: { id: "self-app", name: "x" } })).status).toBe(409);
  // Unknown body keys are ignored: the project is created from the SDK starter inside the workspace only.
  const created = await api("/api/projects", { method: "POST", json: { id: "intruder", extraProjectRoots: [temp], projectRoot: temp } });
  expect(created.status).toBe(201);
  expect(existsSync(join(temp, "ws/projects/intruder/pocket.json"))).toBe(true);
  expect(readFileSync(join(extra, "app.tsx"), "utf8")).toContain("SELF_V1");
  expect(JSON.stringify((await api("/health")).body)).not.toContain(extra);
});

test("an extra root builds and publishes with its own app id through the normal signed path", async () => {
  expect((await api("/api/projects/self-app/build", { method: "POST", json: {} })).status).toBe(202);
  let status: any;
  for (let i = 0; i < 2400; i += 1) {
    status = (await api("/api/projects/self-app/status")).body;
    if (!status.busy) break;
    await Bun.sleep(50);
  }
  expect(status.error).toBeUndefined();
  expect(status.builtRevision).toBe(status.revision);
  const published = await api("/api/projects/self-app/publish", { method: "POST", json: { channel: "test" } });
  expect(published.status).toBe(200);
  expect(published.body.updateUrl).toContain("/test/pocket/extra-test/dev.pocket.self/");
  const key = JSON.parse(readFileSync(join(temp, "ws/keys/editor-dev-key.json"), "utf8"));
  expect(published.body.status.publish.keyId).toBe(key.keyId);
});

test("the update signing key exists right after startup when provisioned, and a restart keeps it", async () => {
  const keyPath = join(temp, "ws/keys/editor-dev-key.json");
  expect(existsSync(keyPath)).toBe(true);
  const first = JSON.parse(readFileSync(keyPath, "utf8"));
  expect(first.keyId).toBe("editor-main-app");
  await server.stop(true);
  server = await startEditor({ port: 0, workspace: join(temp, "ws"), projectRoot: primary, extraProjectRoots: [extra], provisionUpdateKey: true, updateHostVersion: "extra-test" });
  servers.push(server);
  expect(JSON.parse(readFileSync(keyPath, "utf8")).publicKeyBase64).toBe(first.publicKeyBase64);
  // Without the option no key is created at startup.
  const bare = mkdtempSync(join(tmpdir(), "pocket-extra-nokey-"));
  const plain = await startEditor({ port: 0, workspace: bare });
  servers.push(plain);
  expect(existsSync(join(bare, "keys/editor-dev-key.json"))).toBe(false);
  await plain.stop(true);
  rmSync(bare, { recursive: true, force: true });
});

test("unsafe extra roots fail startup: missing, symlink, no pocket.json, duplicate id, primary collision", async () => {
  const workspace = join(temp, "ws-bad");
  const start = (roots: string[], projectRoot: string | undefined = primary) => startEditor({ port: 0, workspace, projectRoot, extraProjectRoots: roots });
  await expect(start([join(temp, "missing")])).rejects.toThrow(/not a directory/);
  const link = join(temp, "link");
  symlinkSync(extra, link);
  await expect(start([link])).rejects.toThrow(/symlink/);
  const empty = join(temp, "empty");
  mkdirSync(empty);
  await expect(start([empty])).rejects.toThrow(/pocket\.json/);
  const twin = join(temp, "twin");
  makeProject(twin, "self-app", "dev.pocket.twin", "TWIN");
  await expect(start([extra, twin])).rejects.toThrow(/collides/);
  const clash = join(temp, "clash");
  makeProject(clash, "main-app", "pocket.clash", "CLASH");
  await expect(start([clash])).rejects.toThrow(/collides/);
});
