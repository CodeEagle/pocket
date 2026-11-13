import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEditor } from "../server.ts";

let workspace = "";
let server: Awaited<ReturnType<typeof startEditor>>;
let base = "";
let csrf = "";
let projectDir = "";
const outside = mkdtempSync(join(tmpdir(), "pocket-fs-outside-"));

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function call(path: string, init: RequestInit & { json?: unknown; auth?: "csrf" | "none" | string } = {}): Promise<{ status: number; body: any }> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && init.auth !== "none") headers.set("x-pocket-csrf", init.auth && init.auth !== "csrf" ? init.auth : csrf);
  let body = init.body;
  if (init.json !== undefined) { headers.set("content-type", "application/json"); body = JSON.stringify(init.json); }
  const response = await fetch(`${base}/api/projects/fs-app${path}`, { method, headers, body });
  const text = await response.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, body: parsed };
}

function rawGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port!, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`));
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "pocket-fs-routes-"));
  server = await startEditor({
    port: 0,
    workspace,
    buildRunner: async () => { throw new Error("not used"); },
  });
  base = `http://127.0.0.1:${server.port}`;
  csrf = (await (await fetch(`${base}/health`)).json()).csrfToken;
  const created = await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pocket-csrf": csrf },
    body: JSON.stringify({ id: "fs-app", name: "FS App", version: "0.1.0", tickHz: 60 }),
  });
  expect(created.status).toBe(201);
  projectDir = join(workspace, "projects/fs-app");
});

afterAll(async () => {
  await server.stop(true);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("stat reports files and directories and 404s for missing paths", async () => {
  mkdirSync(join(projectDir, "ui"), { recursive: true });
  writeFileSync(join(projectDir, "ui/a.tsx"), "export const a = 1;\n");
  writeFileSync(join(projectDir, "ui/pic.png"), "x");
  const file = await call("/stat/ui/a.tsx");
  expect(file.status).toBe(200);
  expect(file.body).toMatchObject({ path: "ui/a.tsx", kind: "file", bytes: 20, editable: true });
  expect(typeof file.body.mtimeMs).toBe("number");
  const dir = await call("/stat/ui");
  expect(dir.body).toMatchObject({ path: "ui", kind: "directory", editable: true });
  // Non-editable files outside assets/ are indistinguishable from missing ones.
  expect((await call("/stat/ui/pic.png")).status).toBe(404);
  mkdirSync(join(projectDir, "assets"), { recursive: true });
  writeFileSync(join(projectDir, "assets/pic.png"), "x");
  expect((await call("/stat/assets/pic.png")).body).toMatchObject({ path: "assets/pic.png", kind: "file", editable: false, bytes: 1 });
  expect((await call("/stat/assets/missing.png")).status).toBe(404);
  expect((await call("/stat/assets/node_modules/x.png")).status).toBe(404);
  expect((await call("/stat/ui/missing.tsx")).status).toBe(404);
  // Protected files/dirs stay hidden even from stat.
  for (const path of ["/stat/editor.json", "/stat/node_modules", "/stat/assets", "/stat/builds", "/stat/keys/a.json", "/stat/.git"]) {
    expect((await call(path)).status).toBe(400);
  }
  expect((await call("/stat/")).status).toBe(404); // project root itself is not addressable
});

test("path traversal, absolute and backslash paths are refused on every route", async () => {
  expect((await call("/stat/..%2Feditor.json")).status).toBe(400);
  expect((await call("/chunks/..%2F..%2Fetc%2Fpasswd")).status).toBe(400);
  expect((await call("/stat/%2Fetc%2Fpasswd")).status).toBe(400);
  expect((await call("/stat/..%5Cx.tsx")).status).toBe(400);
  expect((await call("/files/..%2Fx.tsx", { method: "DELETE" })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "app.tsx", to: "../x.tsx" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "app.tsx", to: "/tmp/x.tsx" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "app.tsx", to: "..\\x.tsx" } })).status).toBe(400);
  expect((await call("/folders", { method: "POST", json: { path: "../evil" } })).status).toBe(400);
  expect((await call("/folders", { method: "POST", json: { path: "/abs" } })).status).toBe(400);
  expect((await call("/folders/..%2Fx", { method: "DELETE" })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { path: "../x.tsx", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);
  // A literal %2e%2e segment (not collapsed by a client URL parser).
  const raw = await rawGet("/api/projects/fs-app/stat/%2e%2e/editor.json");
  // The server's URL parser collapses the dot segment, so it never reaches a project file route.
  expect(raw).toMatch(/^HTTP\/1\.1 40[04]/);
  expect(raw).not.toContain("pocket-editor");
  expect(existsSync(join(workspace, "projects/x.tsx"))).toBe(false);
});

test("write routes need the credential and reject a wrong CSRF token", async () => {
  const cases: Array<[string, string, unknown]> = [
    ["/files/ui/a.tsx", "DELETE", undefined],
    ["/files-move", "POST", { from: "ui/a.tsx", to: "ui/b.tsx" }],
    ["/folders", "POST", { path: "newdir" }],
    ["/folders/ui", "DELETE", undefined],
    ["/uploads", "POST", { path: "ui/a.tsx", totalBytes: 1, sha256: sha("a") }],
    ["/build/cancel", "POST", {}],
  ];
  for (const [path, method, json] of cases) {
    expect((await call(path, { method, json, auth: "none" })).status).toBe(403);
    expect((await call(path, { method, json, auth: "wrong-token" })).status).toBe(403);
  }
  expect(existsSync(join(projectDir, "ui/a.tsx"))).toBe(true);
  expect(existsSync(join(projectDir, "newdir"))).toBe(false);
});

test("delete removes one editable file, bumps revision, and refuses protected/missing/symlinked targets", async () => {
  writeFileSync(join(projectDir, "ui/del.tsx"), "x");
  const before = (await call("/files")).body.revision;
  const deleted = await call("/files/ui/del.tsx", { method: "DELETE" });
  expect(deleted.status).toBe(200);
  expect(deleted.body.revision).toBe(before + 1);
  expect(existsSync(join(projectDir, "ui/del.tsx"))).toBe(false);
  const status = (await call("/status")).body;
  expect(status.revision).toBe(before + 1);
  expect(status.logs.at(-1)).toContain("file deleted: ui/del.tsx");
  expect((await call("/files/ui/del.tsx", { method: "DELETE" })).status).toBe(404);
  expect((await call("/files/editor.json", { method: "DELETE" })).status).toBe(400);
  expect((await call("/files/keys/private.json", { method: "DELETE" })).status).toBe(400);
  expect((await call("/files/ui", { method: "DELETE" })).status).toBe(400);
  // A symlink leaf is never followed or removed through the API.
  writeFileSync(join(outside, "target.tsx"), "keep");
  symlinkSync(join(outside, "target.tsx"), join(projectDir, "ui/link.tsx"));
  expect((await call("/files/ui/link.tsx", { method: "DELETE" })).status).toBe(400);
  expect(readFileSync(join(outside, "target.tsx"), "utf8")).toBe("keep");
  rmSync(join(projectDir, "ui/link.tsx"));
});

test("symlinked parent directories cannot be used to reach outside the project", async () => {
  mkdirSync(join(outside, "dir"), { recursive: true });
  writeFileSync(join(outside, "dir/secret.tsx"), "outside");
  symlinkSync(join(outside, "dir"), join(projectDir, "linkdir"));
  expect((await call("/stat/linkdir/secret.tsx")).status).toBe(400);
  expect((await call("/chunks/linkdir/secret.tsx")).status).toBe(400);
  expect((await call("/files/linkdir/secret.tsx", { method: "DELETE" })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/a.tsx", to: "linkdir/moved.tsx" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "linkdir/secret.tsx", to: "ui/s.tsx" } })).status).toBe(400);
  expect((await call("/folders", { method: "POST", json: { path: "linkdir/sub" } })).status).toBe(400);
  expect((await call("/folders/linkdir", { method: "DELETE" })).status).toBe(400);
  const up = await call("/uploads", { method: "POST", json: { path: "linkdir/up.tsx", totalBytes: 1, sha256: sha("a") } });
  expect(up.status).toBe(400);
  expect(existsSync(join(outside, "dir/moved.tsx"))).toBe(false);
  expect(existsSync(join(outside, "dir/sub"))).toBe(false);
  expect(readFileSync(join(outside, "dir/secret.tsx"), "utf8")).toBe("outside");
  rmSync(join(projectDir, "linkdir"));
});

test("files-move renames within the project with overwrite and type guards", async () => {
  writeFileSync(join(projectDir, "ui/m1.tsx"), "one");
  writeFileSync(join(projectDir, "ui/m2.tsx"), "two");
  const moved = await call("/files-move", { method: "POST", json: { from: "ui/m1.tsx", to: "deep/er/m1.tsx" } });
  expect(moved.status).toBe(200);
  expect(readFileSync(join(projectDir, "deep/er/m1.tsx"), "utf8")).toBe("one");
  expect(existsSync(join(projectDir, "ui/m1.tsx"))).toBe(false);
  // Refuse overwrite by default; allow it explicitly.
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m2.tsx", to: "deep/er/m1.tsx" } })).status).toBe(409);
  expect(readFileSync(join(projectDir, "deep/er/m1.tsx"), "utf8")).toBe("one");
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m2.tsx", to: "deep/er/m1.tsx", overwrite: true } })).status).toBe(200);
  expect(readFileSync(join(projectDir, "deep/er/m1.tsx"), "utf8")).toBe("two");
  // Cross-type: target is a directory; or the target name is not an editable file; or source is protected.
  writeFileSync(join(projectDir, "ui/m3.tsx"), "three");
  mkdirSync(join(projectDir, "ui/dirtarget.tsx"));
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m3.tsx", to: "ui/dirtarget.tsx", overwrite: true } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m3.tsx", to: "ui/dirtarget.tsx" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m3.tsx", to: "ui/m3.png" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m3.tsx", to: "assets/m3.tsx" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "editor.json", to: "ui/e.json" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m3.tsx", to: "node_modules/x.tsx" } })).status).toBe(400);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/nope.tsx", to: "ui/x.tsx" } })).status).toBe(404);
  expect((await call("/files-move", { method: "POST", json: { from: "ui/m3.tsx", to: "ui/m3.tsx" } })).status).toBe(400);
  expect(readFileSync(join(projectDir, "ui/m3.tsx"), "utf8")).toBe("three");
});

test("folders: create is recursive and idempotent; delete only removes empty folders; protected names are refused", async () => {
  const revision = (await call("/files")).body.revision;
  const created = await call("/folders", { method: "POST", json: { path: "feat/nested/dir" } });
  expect(created.status).toBe(201);
  expect(created.body.created).toBe(true);
  expect(existsSync(join(projectDir, "feat/nested/dir"))).toBe(true);
  expect((await call("/files")).body.revision).toBe(revision + 1);
  const again = await call("/folders", { method: "POST", json: { path: "feat/nested/dir" } });
  expect(again.status).toBe(200);
  expect(again.body.created).toBe(false);
  for (const path of ["assets", "builds", "keys", "node_modules", ".git", "updates", ".pocket-build", "a/node_modules", "dist", "app.tsx"]) {
    expect((await call("/folders", { method: "POST", json: { path } })).status).toBe(400);
  }
  for (const path of ["assets", "node_modules", ".git", "keys", "builds"]) {
    expect((await call(`/folders/${path}`, { method: "DELETE" })).status).toBe(400);
  }
  expect((await call("/folders/", { method: "DELETE" })).status).toBe(404);
  writeFileSync(join(projectDir, "feat/nested/dir/x.tsx"), "x");
  const nonEmpty = await call("/folders/feat/nested/dir", { method: "DELETE" });
  expect(nonEmpty.status).toBe(409);
  expect(existsSync(join(projectDir, "feat/nested/dir/x.tsx"))).toBe(true);
  rmSync(join(projectDir, "feat/nested/dir/x.tsx"));
  expect((await call("/folders/feat/nested/dir", { method: "DELETE" })).status).toBe(200);
  expect(existsSync(join(projectDir, "feat/nested/dir"))).toBe(false);
  expect((await call("/folders/feat/nested/dir", { method: "DELETE" })).status).toBe(404);
});

test("chunked read returns bounded base64 slices plus whole-file sha256", async () => {
  const content = "héllo\n".repeat(60000); // ~420 KB of UTF-8
  const bytes = Buffer.from(content);
  writeFileSync(join(projectDir, "ui/big.json"), bytes);
  const first = await call("/chunks/ui/big.json?offset=0&length=999999");
  expect(first.status).toBe(200);
  expect(first.body.length).toBe(131072); // clamped
  expect(first.body.totalBytes).toBe(bytes.length);
  expect(first.body.sha256).toBe(sha(bytes));
  const parts: Buffer[] = [Buffer.from(first.body.data, "base64")];
  let offset = first.body.length;
  while (offset < bytes.length) {
    const next = await call(`/chunks/ui/big.json?offset=${offset}&length=100000`);
    expect(next.status).toBe(200);
    expect(next.body.sha256).toBe(first.body.sha256);
    parts.push(Buffer.from(next.body.data, "base64"));
    offset += next.body.length;
  }
  expect(Buffer.concat(parts).equals(bytes)).toBe(true);
  const eof = await call(`/chunks/ui/big.json?offset=${bytes.length}`);
  expect(eof.body).toMatchObject({ length: 0, data: "" });
  expect((await call(`/chunks/ui/big.json?offset=${bytes.length + 1}`)).status).toBe(400);
  expect((await call("/chunks/ui/big.json?offset=-1")).status).toBe(400);
  expect((await call("/chunks/ui/big.json?offset=abc")).status).toBe(400);
  expect((await call("/chunks/ui/big.json?length=0")).status).toBe(400);
  expect((await call("/chunks/ui/nope.json")).status).toBe(404);
  expect((await call("/chunks/editor.json")).status).toBe(400);
});

async function upload(path: string, bytes: Buffer, chunk = 131072): Promise<{ uploadId: string }> {
  const opened = await call("/uploads", { method: "POST", json: { path, totalBytes: bytes.length, sha256: sha(bytes) } });
  expect(opened.status).toBe(201);
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const put = await call(`/uploads/${opened.body.uploadId}`, { method: "PUT", json: { offset, data: bytes.subarray(offset, offset + chunk).toString("base64") } });
    expect(put.status).toBe(200);
  }
  return opened.body;
}

test("chunked upload commits verified UTF-8 text through the write policy and bumps revision", async () => {
  const bytes = Buffer.from("// 你好\n".repeat(50000));
  const before = (await call("/files")).body.revision;
  const { uploadId } = await upload("uploaded/big.ts", bytes);
  const committed = await call(`/uploads/${uploadId}/commit`, { method: "POST", json: {} });
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({ path: "uploaded/big.ts", bytes: bytes.length, sha256: sha(bytes), revision: before + 1 });
  expect(readFileSync(join(projectDir, "uploaded/big.ts")).equals(bytes)).toBe(true);
  // Round trip through the chunk reader.
  expect((await call("/chunks/uploaded/big.ts?offset=0")).body.sha256).toBe(sha(bytes));
  // The session is single-use.
  expect((await call(`/uploads/${uploadId}/commit`, { method: "POST", json: {} })).status).toBe(404);
  expect((await call("/status")).body.logs.at(-1)).toContain("file uploaded: uploaded/big.ts");
  // Empty file is allowed.
  const empty = await call("/uploads", { method: "POST", json: { path: "uploaded/empty.ts", totalBytes: 0, sha256: sha("") } });
  expect((await call(`/uploads/${empty.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(200);
});

test("upload guards: oversize, bad sha, non-contiguous, incomplete, NUL, invalid UTF-8, protected path, project binding, abort", async () => {
  // Declared size over the 16 MiB source limit.
  expect((await call("/uploads", { method: "POST", json: { path: "u/a.ts", totalBytes: 16 * 1024 * 1024 + 1, sha256: sha("a") } })).status).toBe(413);
  expect((await call("/uploads", { method: "POST", json: { path: "u/a.ts", totalBytes: 1, sha256: "zz" } })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { path: "editor.json", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { path: "assets/a.ts", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { path: "u/a.png", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);

  // Oversize chunk (> 131072 raw bytes) and chunk past declared size.
  const big = Buffer.alloc(131073, 97);
  const oversize = await call("/uploads", { method: "POST", json: { path: "u/o.ts", totalBytes: big.length, sha256: sha(big) } });
  const tooBig = await call(`/uploads/${oversize.body.uploadId}`, { method: "PUT", json: { offset: 0, data: big.toString("base64") } });
  expect(tooBig.status).toBe(413);
  const small = await call("/uploads", { method: "POST", json: { path: "u/s.ts", totalBytes: 4, sha256: sha("abcd") } });
  expect((await call(`/uploads/${small.body.uploadId}`, { method: "PUT", json: { offset: 0, data: Buffer.from("abcdef").toString("base64") } })).status).toBe(413);

  // Non-contiguous / replayed offsets, bad base64, incomplete commit.
  expect((await call(`/uploads/${small.body.uploadId}`, { method: "PUT", json: { offset: 2, data: Buffer.from("cd").toString("base64") } })).status).toBe(409);
  expect((await call(`/uploads/${small.body.uploadId}`, { method: "PUT", json: { offset: 0, data: "not base64!" } })).status).toBe(400);
  expect((await call(`/uploads/${small.body.uploadId}`, { method: "PUT", json: { offset: 0, data: Buffer.from("ab").toString("base64") } })).status).toBe(200);
  expect((await call(`/uploads/${small.body.uploadId}`, { method: "PUT", json: { offset: 0, data: Buffer.from("ab").toString("base64") } })).status).toBe(409);
  expect((await call(`/uploads/${small.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(409);
  expect((await call(`/uploads/${small.body.uploadId}`, { method: "PUT", json: { offset: 2, data: Buffer.from("cd").toString("base64") } })).status).toBe(200);
  expect((await call(`/uploads/${small.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(200);

  // sha mismatch leaves the target untouched.
  writeFileSync(join(projectDir, "u-keep.ts"), "keep");
  const bad = await call("/uploads", { method: "POST", json: { path: "u-keep.ts", totalBytes: 3, sha256: sha("zzz") } });
  await call(`/uploads/${bad.body.uploadId}`, { method: "PUT", json: { offset: 0, data: Buffer.from("abc").toString("base64") } });
  expect((await call(`/uploads/${bad.body.uploadId}/commit`, { method: "POST", json: {} })).status).toBe(422);
  expect(readFileSync(join(projectDir, "u-keep.ts"), "utf8")).toBe("keep");

  // NUL byte and invalid UTF-8 (sha is correct, content policy still rejects).
  for (const content of [Buffer.from([0x61, 0x00, 0x62]), Buffer.from([0xff, 0xfe, 0x41, 0xc3])]) {
    const up = await upload("u-bad.ts", content);
    const result = await call(`/uploads/${up.uploadId}/commit`, { method: "POST", json: {} });
    expect(result.status).toBe(400);
    await call(`/uploads/${up.uploadId}`, { method: "DELETE" });
    expect(existsSync(join(projectDir, "u-bad.ts"))).toBe(false);
  }

  // A failed commit keeps the session open for a retry; release those slots.
  for (const id of [oversize.body.uploadId, bad.body.uploadId]) await call(`/uploads/${id}`, { method: "DELETE" });

  // Unknown id, abort.
  expect((await call("/uploads/00000000-0000-4000-8000-000000000000", { method: "PUT", json: { offset: 0, data: "AA==" } })).status).toBe(404);
  const abortable = await call("/uploads", { method: "POST", json: { path: "u/ab.ts", totalBytes: 1, sha256: sha("a") } });
  expect((await call(`/uploads/${abortable.body.uploadId}`, { method: "DELETE" })).status).toBe(200);
  expect((await call(`/uploads/${abortable.body.uploadId}`, { method: "PUT", json: { offset: 0, data: "YQ==" } })).status).toBe(404);
  expect((await call(`/uploads/${abortable.body.uploadId}`, { method: "DELETE" })).status).toBe(404);
});

async function createProject(id: string): Promise<void> {
  const created = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json", "x-pocket-csrf": csrf }, body: JSON.stringify({ id, name: id, version: "0.1.0", tickHz: 60 }) });
  expect(created.status).toBe(201);
}

async function openIn(project: string, index: number): Promise<{ status: number; uploadId?: string }> {
  const response = await fetch(`${base}/api/projects/${project}/uploads`, { method: "POST", headers: { "content-type": "application/json", "x-pocket-csrf": csrf }, body: JSON.stringify({ path: `bound/${index}.ts`, totalBytes: 1, sha256: sha("a") }) });
  const body: any = await response.json();
  return { status: response.status, uploadId: body.uploadId };
}

test("upload ids are unguessable and sessions are bound to a project; caps are 4 per project and 8 server-wide", async () => {
  const ids = new Set<string>();
  const opened: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await call("/uploads", { method: "POST", json: { path: `bound/${index}.ts`, totalBytes: 1, sha256: sha("a") } });
    expect(result.status).toBe(201);
    expect(result.body.uploadId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    ids.add(result.body.uploadId);
    opened.push(result.body.uploadId);
  }
  expect(ids.size).toBe(4);
  const capped = await call("/uploads", { method: "POST", json: { path: "bound/9.ts", totalBytes: 1, sha256: sha("a") } });
  expect(capped.status).toBe(429);
  expect(capped.body.error).toContain("this project");
  // Per-project isolation: another project still has its own four slots.
  await createProject("other-app");
  const others: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const result = await openIn("other-app", index);
    expect(result.status).toBe(201);
    others.push(result.uploadId!);
  }
  expect((await openIn("other-app", 9)).status).toBe(429);
  // The global cap of 8 applies across projects.
  await createProject("third-app");
  const global = await fetch(`${base}/api/projects/third-app/uploads`, { method: "POST", headers: { "content-type": "application/json", "x-pocket-csrf": csrf }, body: JSON.stringify({ path: "bound/g.ts", totalBytes: 1, sha256: sha("a") }) });
  expect(global.status).toBe(429);
  expect((await global.json() as any).error).toContain("too many open uploads");
  // Another project cannot see or drive this session.
  const cross = await fetch(`${base}/api/projects/other-app/uploads/${opened[0]}`, { method: "PUT", headers: { "content-type": "application/json", "x-pocket-csrf": csrf }, body: JSON.stringify({ offset: 0, data: "YQ==" }) });
  expect(cross.status).toBe(404);
  const crossDelete = await fetch(`${base}/api/projects/other-app/uploads/${opened[0]}`, { method: "DELETE", headers: { "x-pocket-csrf": csrf } });
  expect(crossDelete.status).toBe(404);
  for (const id of opened) expect((await call(`/uploads/${id}`, { method: "DELETE" })).status).toBe(200);
  for (const id of others) expect((await fetch(`${base}/api/projects/other-app/uploads/${id}`, { method: "DELETE", headers: { "x-pocket-csrf": csrf } })).status).toBe(200);
});

test("buffered upload bytes are budgeted across uploads and released on abort", async () => {
  const budgetServer = await startEditor({ port: 0, workspace: mkdtempSync(join(tmpdir(), "pocket-fs-budget-")), maxBufferedUploadBytes: 300, buildRunner: async () => { throw new Error("not used"); } });
  try {
    const b = `http://127.0.0.1:${budgetServer.port}`;
    const token = (await (await fetch(`${b}/health`)).json()).csrfToken;
    const headers = { "content-type": "application/json", "x-pocket-csrf": token };
    await fetch(`${b}/api/projects`, { method: "POST", headers, body: JSON.stringify({ id: "bud", name: "bud", version: "0.1.0", tickHz: 60 }) });
    const open = async (path: string) => (await (await fetch(`${b}/api/projects/bud/uploads`, { method: "POST", headers, body: JSON.stringify({ path, totalBytes: 200, sha256: sha("a") }) })).json() as any).uploadId as string;
    const put = (id: string, offset: number) => fetch(`${b}/api/projects/bud/uploads/${id}`, { method: "PUT", headers, body: JSON.stringify({ offset, data: Buffer.alloc(200, 97).toString("base64") }) });
    const first = await open("a.ts");
    const second = await open("b.ts");
    expect((await put(first, 0)).status).toBe(200);
    const refused = await put(second, 0);
    expect(refused.status).toBe(429);
    expect((await refused.json() as any).error).toContain("budget");
    // Aborting the first upload frees its bytes.
    await fetch(`${b}/api/projects/bud/uploads/${first}`, { method: "DELETE", headers });
    expect((await put(second, 0)).status).toBe(200);
  } finally {
    await budgetServer.stop(true);
  }
});

test("new mutating routes reject dot-prefixed path segments", async () => {
  writeFileSync(join(projectDir, "ui/dot.tsx"), "x");
  for (const to of [".ssh/a.json", "ui/.hidden/a.json", ".a.json"]) {
    expect((await call("/files-move", { method: "POST", json: { from: "ui/dot.tsx", to } })).status).toBe(400);
  }
  expect((await call("/files-move", { method: "POST", json: { from: ".ssh/a.json", to: "ui/x.tsx" } })).status).toBe(400);
  expect(existsSync(join(projectDir, ".ssh"))).toBe(false);
  expect((await call("/folders", { method: "POST", json: { path: ".ssh" } })).status).toBe(400);
  expect((await call("/folders", { method: "POST", json: { path: "ui/.cache/x" } })).status).toBe(400);
  expect((await call("/folders/.ssh", { method: "DELETE" })).status).toBe(400);
  expect((await call("/files/ui/.env.tsx", { method: "DELETE" })).status).toBe(400);
  expect((await call("/uploads", { method: "POST", json: { path: ".ssh/a.ts", totalBytes: 1, sha256: sha("a") } })).status).toBe(400);
  expect((await call("/stat/.env")).status).toBe(400);
  expect((await call("/stat/ui/.env")).status).toBe(400);
  expect(existsSync(join(projectDir, "ui/dot.tsx"))).toBe(true);
});

test("stat does not leak non-source files", async () => {
  writeFileSync(join(projectDir, ".env"), "SECRET=1");
  writeFileSync(join(projectDir, "secret.txt"), "x");
  expect((await call("/stat/.env")).status).toBe(400);
  expect((await call("/stat/secret.txt")).status).toBe(404);
});

test("new read routes refuse cross-origin and cross-site requests; same-origin and header-less clients still work", async () => {
  mkdirSync(join(projectDir, "ui"), { recursive: true });
  const paths = ["/watch", "/build/events", "/chunks/ui/a.tsx", "/stat/ui/a.tsx"];
  for (const path of paths) {
    const url = `${base}/api/projects/fs-app${path}`;
    expect((await fetch(url, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(url, { headers: { origin: "null" } })).status).toBe(403);
    expect((await fetch(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(url, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
  }
  // Foreign watchers must not consume slots: the real Studio can still connect.
  const abort = new AbortController();
  const ok = await fetch(`${base}/api/projects/fs-app/watch`, { headers: { origin: base, "sec-fetch-site": "same-origin" }, signal: abort.signal });
  expect(ok.status).toBe(200);
  abort.abort();
  expect((await fetch(`${base}/api/projects/fs-app/stat/ui/a.tsx`, { headers: { origin: base } })).status).toBe(200);
});

async function openStream(path: string, abort: AbortController): Promise<{ next: (predicate: (event: any) => boolean, timeoutMs?: number) => Promise<any> }> {
  const response = await fetch(`${base}/api/projects/fs-app${path}`, { signal: abort.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: any[] = [];
  return {
    async next(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = seen.findIndex(predicate);
        if (index >= 0) return seen.splice(index, 1)[0];
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; unmatched events: ${JSON.stringify(seen)}`);
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out; unmatched events: ${JSON.stringify(seen)}`)), left))]);
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value);
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)));
        }
      }
    },
  };
}

test("watch streams debounced, filtered change events for external writes and revision events for Studio writes", async () => {
  const abort = new AbortController();
  const stream = await openStream("/watch", abort);
  const ready = await stream.next((event) => event.type === "ready");
  expect(typeof ready.revision).toBe("number");
  mkdirSync(join(projectDir, "watched"), { recursive: true });
  writeFileSync(join(projectDir, "watched/ext.tsx"), "one");
  const created = await stream.next((event) => event.type === "change" && event.path === "watched/ext.tsx");
  expect(created.kind).toBe("file");
  // Duplicate writes inside the debounce window coalesce into one event.
  for (let index = 0; index < 5; index += 1) writeFileSync(join(projectDir, "watched/ext.tsx"), `v${index}`);
  await stream.next((event) => event.type === "change" && event.path === "watched/ext.tsx");
  await Bun.sleep(300);
  // Ignored/protected/non-editable paths never surface; the editable one after them does.
  mkdirSync(join(projectDir, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(projectDir, "node_modules/pkg/index.js"), "x");
  writeFileSync(join(projectDir, "editor.json"), "{}");
  writeFileSync(join(projectDir, "watched/pic.png"), "x");
  mkdirSync(join(projectDir, "watched/sub"));
  writeFileSync(join(projectDir, "watched/sentinel.ts"), "x");
  const events: any[] = [];
  for (;;) {
    const event = await stream.next((candidate) => candidate.type === "change");
    events.push(event);
    if (event.path === "watched/sentinel.ts") break;
  }
  const paths = events.map((event) => event.path);
  expect(paths.some((path) => path.startsWith("node_modules") || path === "editor.json" || path.endsWith(".png"))).toBe(false);
  expect(events.find((event) => event.path === "watched/sub")).toMatchObject({ kind: "directory", event: "rename" });
  // Deleting a file reports a rename.
  rmSync(join(projectDir, "watched/sentinel.ts"));
  expect(await stream.next((event) => event.type === "change" && event.path === "watched/sentinel.ts")).toMatchObject({ kind: "file", event: "rename" });
  // A Studio write pushes a revision event.
  const put = await call("/files/watched/studio.ts", { method: "PUT", json: { content: "x" } });
  const revision = await stream.next((event) => event.type === "revision");
  expect(revision.revision).toBe(put.body.revision);
  abort.abort();
});

test("watch is bounded and releases slots when clients disconnect", async () => {
  const aborts: AbortController[] = [];
  for (let index = 0; index < 16; index += 1) {
    const abort = new AbortController();
    aborts.push(abort);
    const stream = await openStream("/watch", abort);
    await stream.next((event) => event.type === "ready");
  }
  expect((await fetch(`${base}/api/projects/fs-app/watch`)).status).toBe(429);
  aborts[0]!.abort();
  let reopened = false;
  for (let attempt = 0; attempt < 50 && !reopened; attempt += 1) {
    const probe = new AbortController();
    const response = await fetch(`${base}/api/projects/fs-app/watch`, { signal: probe.signal });
    if (response.status === 200) reopened = true;
    probe.abort();
    if (!reopened) await Bun.sleep(50);
  }
  expect(reopened).toBe(true);
  for (const abort of aborts) abort.abort();
});

test("SSE streams drop a slow consumer instead of buffering without bound", async () => {
  const { sseResponse } = await import("../server.ts");
  let detached = false;
  let sent = 0;
  let sender: (value: unknown) => void = () => undefined;
  const response = sseResponse(new Request("http://127.0.0.1/x"), (send) => { sender = send; return () => { detached = true; }; });
  // Nobody reads the body: the queue fills, then the subscriber is dropped.
  for (let index = 0; index < 1000 && !detached; index += 1) { sender({ index }); sent += 1; }
  expect(detached).toBe(true);
  expect(sent).toBeLessThanOrEqual(300);
  // A reader still receives the bounded backlog and then end-of-stream.
  const reader = response.body!.getReader();
  let frames = 0;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; frames += 1; }
  expect(frames).toBe(sent);
});
