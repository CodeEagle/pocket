import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { handleNovelRoute } from "../novel.ts";
import {
  getNovelHistory,
  NovelHistoryError,
  putNovelHistory,
  type NovelHistoryEntry,
  type NovelHistoryOptions,
  type NovelHistoryValidators,
} from "../novel-history.ts";

const projectId = "novel-history-store";
const story = {
  id: "store.story",
  version: 1,
  start: "start",
  script: { start: [{ type: "say", id: "line", text: "A line" }] },
};
const assets = { backgrounds: { room: "art/room.png" }, characters: {}, cgs: {}, audio: {} };

function validators(): NovelHistoryValidators {
  return {
    story(value) {
      return !!value && typeof value === "object" && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).id === "string" &&
        typeof (value as Record<string, unknown>).script === "object";
    },
    assets(value) {
      return !!value && typeof value === "object" && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).backgrounds === "object";
    },
  };
}

async function fixture(epoch = 3): Promise<{
  temporary: string;
  projectRoot: string;
  workspaceRoot: string;
  options: NovelHistoryOptions;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "pocket-novel-history-store-"));
  const projectRoot = join(temporary, "project");
  const workspaceRoot = join(temporary, "workspace");
  await mkdir(projectRoot);
  await mkdir(workspaceRoot);
  await writeFile(join(projectRoot, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
  await writeFile(join(projectRoot, "novel.assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  return {
    temporary,
    projectRoot,
    workspaceRoot,
    options: { workspaceRoot, projectRoot, projectId, restoreEpoch: epoch },
  };
}

function sampleEntries(): { undo: NovelHistoryEntry[]; redo: NovelHistoryEntry[] } {
  return {
    undo: [
      { scope: "story", key: "instruction:text:start:0", restore: story },
      { scope: "assets", key: "background:room", restore: assets },
      { scope: "project", key: "model:rename:hero", restore: { story, assets } },
    ],
    redo: [{ scope: "story", key: "story:import", restore: story }],
  };
}

test("history sidecar keeps the live draft and existing stacks, while head requests omit snapshots", async () => {
  const root = await fixture();
  try {
    const initial = await getNovelHistory(root.options, validators());
    assert.equal(initial.historyRevision, 0);
    assert.equal(initial.history, null);
    assert.match(initial.sourceToken, /^[0-9a-f]{64}$/);

    const draft = {
      story: { ...story, start: "missing", script: { start: [{ type: "jump", target: "missing" }] } },
      assets: { ...assets, backgrounds: { room: "" } },
      authoringDraft: { text: "{ unfinished", baseline: "{\"version\":1}" },
    };
    const stacks = sampleEntries();
    const written = await putNovelHistory(root.options, {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: initial.historyRevision,
      draft,
      ...stacks,
    }, validators());
    assert.equal(written.historyRevision, 1);
    assert.equal(written.sourceToken, initial.sourceToken);

    const head = await getNovelHistory(root.options, validators(), true);
    assert.deepEqual(head, { sourceToken: initial.sourceToken, historyRevision: 1 });
    assert.equal("history" in head, false);

    const reopened = await getNovelHistory(root.options, validators());
    assert.deepEqual(reopened.history, { draft, ...stacks });
    const journalPath = join(root.workspaceRoot, "novel-history", `${projectId}.json`);
    assert.equal(JSON.parse(await readFile(journalPath, "utf8")).historyRevision, 1);
    assert.equal(await readFile(join(root.projectRoot, "story.json"), "utf8"), `${JSON.stringify(story, null, 2)}\n`,
      "persisting a draft must not write consumer source");
  } finally {
    await rm(root.temporary, { recursive: true, force: true });
  }
});

test("external source changes and backup restore epochs refuse stale draft hydration and writes", async () => {
  const root = await fixture();
  try {
    const initial = await getNovelHistory(root.options, validators());
    const stacks = sampleEntries();
    await putNovelHistory(root.options, {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: 0,
      draft: { story, assets },
      ...stacks,
    }, validators());

    await writeFile(join(root.projectRoot, "story.json"), `${JSON.stringify({ ...story, version: 2 })}\n`);
    const stale = await getNovelHistory(root.options, validators());
    assert.equal(stale.status, "stale");
    assert.equal(stale.history, null);
    assert.equal(stale.historyRevision, 1);
    const staleHead = await getNovelHistory(root.options, validators(), true);
    assert.equal(staleHead.status, "stale");
    assert.equal("history" in staleHead, false);
    await assert.rejects(
      putNovelHistory(root.options, {
        expectedToken: initial.sourceToken,
        expectedHistoryRevision: 1,
        draft: { story, assets },
        ...stacks,
      }, validators()),
      (error: unknown) => error instanceof NovelHistoryError && error.status === 409 && error.code === "novel_history_conflict",
    );
  } finally {
    await rm(root.temporary, { recursive: true, force: true });
  }

  const restored = await fixture(10);
  try {
    const initial = await getNovelHistory(restored.options, validators());
    await putNovelHistory(restored.options, {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: 0,
      draft: { story, assets },
      ...sampleEntries(),
    }, validators());
    const afterRestore = { ...restored.options, restoreEpoch: 11 };
    const stale = await getNovelHistory(afterRestore, validators());
    assert.equal(stale.status, "stale", "an identical backup restore still invalidates the previous journal");
    assert.equal(stale.history, null);
  } finally {
    await rm(restored.temporary, { recursive: true, force: true });
  }
});

test("history revision CAS and payload validation leave the committed journal intact", async () => {
  const root = await fixture();
  try {
    const left = await getNovelHistory(root.options, validators());
    const right = await getNovelHistory(root.options, validators());
    const first = { ...sampleEntries(), draft: { story: { ...story, version: 2 }, assets } };
    await putNovelHistory(root.options, {
      expectedToken: left.sourceToken,
      expectedHistoryRevision: left.historyRevision,
      ...first,
    }, validators());

    await assert.rejects(
      putNovelHistory(root.options, {
        expectedToken: right.sourceToken,
        expectedHistoryRevision: right.historyRevision,
        draft: { story: { ...story, version: 3 }, assets },
        ...sampleEntries(),
      }, validators()),
      (error: unknown) => error instanceof NovelHistoryError && error.status === 409 && error.code === "novel_history_conflict",
    );
    await assert.rejects(
      putNovelHistory(root.options, {
        expectedToken: left.sourceToken,
        expectedHistoryRevision: 1,
        draft: { story, assets, authoringDraft: { text: "x".repeat(2 * 1024 * 1024 + 1), baseline: "" } },
        ...sampleEntries(),
      }, validators()),
      (error: unknown) => error instanceof NovelHistoryError && error.status === 422,
    );
    const largeStory = { ...story, custom: "x".repeat(300_000) };
    const oversizedStack = Array.from({ length: 32 }, (_, index) => ({
      scope: "story" as const,
      key: `large:${index}`,
      restore: largeStory,
    }));
    await assert.rejects(
      putNovelHistory(root.options, {
        expectedToken: left.sourceToken,
        expectedHistoryRevision: 1,
        draft: { story, assets },
        undo: oversizedStack,
        redo: oversizedStack,
      }, validators()),
      (error: unknown) => error instanceof NovelHistoryError && error.status === 413,
    );
    const intact = await getNovelHistory(root.options, validators());
    assert.equal(intact.historyRevision, 1);
    assert.deepEqual(intact.history?.draft, first.draft);

    const corruptPath = join(root.workspaceRoot, "novel-history", `${projectId}.json`);
    await writeFile(corruptPath, JSON.stringify({ historyRevision: 7, broken: true }));
    const corrupt = await getNovelHistory(root.options, validators());
    assert.equal(corrupt.status, "corrupt");
    assert.equal(corrupt.history, null);
    assert.equal(corrupt.historyRevision, 7, "a parseable revision still protects concurrent repair writes");
  } finally {
    await rm(root.temporary, { recursive: true, force: true });
  }
});

test("Novel history routes validate semantic drafts, expose head reads and mark source conflicts", async () => {
  const root = await fixture();
  const options = { projectRoot: root.projectRoot, workspaceRoot: root.workspaceRoot, projectId, novelRestoreEpoch: 5 };
  const route = (method: string, path = `/api/projects/${projectId}/novel/history`, body?: unknown) => handleNovelRoute(
    new Request(`http://127.0.0.1${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    options,
  );
  try {
    const initialResponse = await route("GET");
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as { sourceToken: string; historyRevision: number; history: unknown };
    const draftStory = {
      ...story,
      start: "missing-label",
      replayEntries: [{ id: "memory", title: "Memory", location: { label: "missing-label", index: 99 } }],
      script: {
        start: [{ type: "input", id: "answer", variable: "answer", inputType: "text", defaultValue: "", minLength: 10, maxLength: 2 }],
      },
    };
    const draftAssets = { ...assets, backgrounds: { room: "art/partial" } };
    const put = await route("PUT", undefined, {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: initial.historyRevision,
      draft: { story: draftStory, assets: draftAssets, authoringDraft: { text: "[", baseline: "baseline" } },
      undo: [{ scope: "story", key: "input:min", restore: story }],
      redo: [],
    });
    assert.equal(put.status, 200, await put.clone().text());

    const head = await (await route("GET", `/api/projects/${projectId}/novel/history?head=1`)).json() as Record<string, unknown>;
    assert.equal(typeof head.sourceToken, "string");
    assert.equal(head.historyRevision, 1);
    assert.equal("history" in head, false);
    const full = await (await route("GET")).json() as { history: { draft: { story: unknown; assets: unknown; authoringDraft: unknown } } };
    assert.deepEqual(full.history.draft.story, draftStory);
    assert.deepEqual(full.history.draft.assets, draftAssets);
    assert.deepEqual(full.history.draft.authoringDraft, { text: "[", baseline: "baseline" });

    await writeFile(join(root.projectRoot, "novel.assets.json"), `${JSON.stringify({ ...assets, backgrounds: { room: "changed.png" } })}\n`);
    const conflict = await route("PUT", undefined, {
      expectedToken: initial.sourceToken,
      expectedHistoryRevision: 1,
      draft: { story, assets },
      undo: [],
      redo: [],
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, "novel_history_conflict");
  } finally {
    await rm(root.temporary, { recursive: true, force: true });
  }
});

test("unsafe history symlink paths are refused without following the target", async () => {
  const root = await fixture();
  const outside = join(root.temporary, "outside.json");
  try {
    await writeFile(outside, "preserve");
    await mkdir(join(root.workspaceRoot, "novel-history"));
    await symlink(outside, join(root.workspaceRoot, "novel-history", `${projectId}.json`));
    await assert.rejects(
      getNovelHistory(root.options, validators()),
      (error: unknown) => error instanceof NovelHistoryError && error.status === 409,
    );
    assert.equal(await readFile(outside, "utf8"), "preserve");
  } finally {
    await rm(root.temporary, { recursive: true, force: true });
  }
});

test("source tokens refuse symlinked canonical documents", async () => {
  const root = await fixture();
  const outside = join(root.temporary, "outside-story.json");
  try {
    await writeFile(outside, JSON.stringify(story));
    await rm(join(root.projectRoot, "story.json"));
    await symlink(outside, join(root.projectRoot, "story.json"));
    await assert.rejects(
      getNovelHistory(root.options, validators()),
      (error: unknown) => error instanceof NovelHistoryError && error.status === 409,
    );
    assert.equal(await readFile(outside, "utf8"), JSON.stringify(story));
  } finally {
    await rm(root.temporary, { recursive: true, force: true });
  }
});
