import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleNovelRoute, validateStoryDefinition } from "../novel.ts";
import { createNovelEngine } from "../../packages/pocket_vn/src/engine.ts";
import type { StoryDefinition } from "../../packages/pocket_vn/src/types.ts";

const story: StoryDefinition = {
  id: "test.graph-layout", version: 1, start: "start",
  script: { start: [{ type: "say", id: "opening", text: "A graph remains the same story." }, { type: "ending", id: "done" }] },
};

test("graph layout accepts optional sparse positions and preserves unrelated metadata", () => {
  assert.equal(validateStoryDefinition(story).valid, true);
  const withLayout = { ...story, editor: { theme: "night", graph: { version: 1 as const, positions: {
    start: { x: -100000, y: 100000 }, removedLabel: { x: 0, y: 0 },
  } } } };
  assert.equal(validateStoryDefinition(withLayout).valid, true);
  assert.equal(withLayout.editor.theme, "night");
});

test("invalid imported graph metadata produces a field diagnostic", () => {
  for (const editor of [null, [], { graph: null }, { graph: { version: 2, positions: {} } },
    { graph: { version: 1, positions: [] } },
    ...[NaN, Infinity, -Infinity, 100001, -100001, "12", null].map(x => ({ graph: { version: 1, positions: { start: { x, y: 0 } } } })),
  ]) {
    const result = validateStoryDefinition({ ...story, editor });
    assert.equal(result.valid, false, JSON.stringify(editor));
    assert.ok(result.diagnostics.some(issue => issue.code === "story.editor.graph" && issue.location?.field?.startsWith("editor")));
  }
});

test("moving graph nodes leaves execution and cross-layout save loading unchanged", () => {
  const layout: StoryDefinition = { ...story, editor: { graph: { version: 1, positions: { start: { x: 900, y: -240 } } } } };
  const plain = createNovelEngine(story);
  const arranged = createNovelEngine(layout);
  plain.start(); arranged.start();
  assert.deepEqual(arranged.getSnapshot(), plain.getSnapshot());
  plain.tick(1000); arranged.tick(1000);
  assert.deepEqual(arranged.save(), plain.save());
  const restored = createNovelEngine({ ...layout, editor: { graph: { version: 1, positions: { start: { x: -42, y: 80 } } } } });
  const plainRestored = createNovelEngine(story);
  restored.load(plain.save()); plainRestored.load(plain.save());
  assert.deepEqual(restored.getSnapshot(), plainRestored.getSnapshot());
});

test("the story save endpoint rejects invalid layout without overwriting the project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pocket-graph-layout-"));
  try {
    const before = JSON.stringify(story);
    await writeFile(join(projectRoot, "story.json"), before);
    const response = await handleNovelRoute(new Request("http://localhost/api/projects/graph/novel/story", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...story, editor: { graph: { version: 1, positions: { start: { x: 100001, y: 0 } } } } }),
    }), { projectRoot, projectId: "graph" });
    assert.equal(response.status, 422);
    const body = await response.json() as { validation: { diagnostics: { location?: { field?: string } }[] } };
    assert.ok(body.validation.diagnostics.some(issue => issue.location?.field === "editor.graph.positions.start"));
    assert.equal(await readFile(join(projectRoot, "story.json"), "utf8"), before);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});
