import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { handleNovelRoute } from "../novel.ts";
import { extractZipArchive } from "../../scripts/package_update.ts";

test("Word export cancels an oversized chunked body before reading the remaining input", async () => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 32) { controller.close(); return; }
      pulled++;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
    },
    cancel() { cancelled = true; },
  });
  const response = await handleNovelRoute(new Request("http://127.0.0.1/api/projects/word-route/novel/export?format=docx", {
    method: "POST", body,
  }), { projectRoot: tmpdir(), projectId: "word-route" });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(pulled < 32, `Expected early cancellation, read ${pulled} MiB instead`);
});

test("Word export reads the submitted draft without saving and retains legacy JSON export", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pocket-word-route-"));
  const saved = { id: "word-route", version: 1, start: "start", script: { start: [{ type: "say", id: "opening", text: "Saved line" }] } };
  const source = JSON.stringify(saved);
  writeFileSync(join(projectRoot, "story.json"), source);
  const options = { projectRoot, projectId: "word-route" };
  const path = "http://127.0.0.1/api/projects/word-route/novel/export";
  const post = (body: BodyInit, query = "docx", headers: Record<string, string> = {}) => handleNovelRoute(new Request(`${path}?format=${query}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body,
  }), options);
  try {
    const draft = structuredClone(saved);
    draft.script.start[0]!.text = "Unsaved <hello> 你好 & goodbye";
    const response = await post(JSON.stringify(draft));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="word-route-story.docx"');
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const parts = extractZipArchive(new Uint8Array(await response.arrayBuffer()));
    const document = new TextDecoder().decode(parts.get("word/document.xml")!);
    assert.match(document, /Unsaved/);
    assert.match(document, /你好/);
    assert.doesNotMatch(document, /Saved line/);
    assert.equal(readFileSync(join(projectRoot, "story.json"), "utf8"), source);

    const legacy = await handleNovelRoute(new Request(path), options);
    assert.match(legacy.headers.get("content-type")!, /application\/json/);
    assert.deepEqual(await legacy.json(), saved);
    assert.equal((await post(JSON.stringify(draft), "html")).status, 400);
    assert.equal((await post("{broken")).status, 400);
    assert.equal((await post("{}")).status, 422);
    assert.equal((await post(new Uint8Array([0xff]))).status, 400);
    assert.equal((await post("{}", "docx", { "content-length": String(8 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await post(" ".repeat(8 * 1024 * 1024 + 1))).status, 413);
    draft.script.start[0]!.text = "Invalid\u0000XML";
    const invalidXml = await post(JSON.stringify(draft));
    assert.ok(invalidXml.status >= 400 && invalidXml.status < 500);
    assert.equal(readFileSync(join(projectRoot, "story.json"), "utf8"), source);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
