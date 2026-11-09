import { expect, test } from "bun:test";
import { createNovelEngine, createNovelReplayEngine, localizeStory, diagnoseStoryLocale, encodeNovelSaveData, type NovelEngine, type StoryLocaleCatalogCollection } from "@pocket/vn";
import { lanternStory } from "./story.ts";
import localeDocument from "./novel.locales.json";

function reach(engine: NovelEngine, id: string): void {
  for (let step = 0; step < 100; step++) {
    const active = engine.getSnapshot().active;
    if (active && "id" in active && active.id === id) return;
    if (active?.kind === "say") engine.advance();
    else if (active?.kind === "wait") engine.tick(active.remainingMs);
    else throw new Error(`Cannot reach ${id} from ${active?.kind}`);
  }
  throw new Error(`Did not reach ${id}`);
}

test("the reader's margin note preserves its pause, survives a real save and informs two isolated endings", () => {
  const main = createNovelEngine(lanternStory);
  main.start();
  const parked = main.save();
  const replay = createNovelReplayEngine(lanternStory, main.getSnapshot(), "rich_letter_showcase");
  try {
    reach(replay, "rich_letter_02");
    const hidden = replay.activateSayLink("return-note");
    expect(hidden.events.filter(event => event.type === "sayLink")).toEqual([]);
    replay.advance();
    expect(replay.getSnapshot().active).toMatchObject({ id: "rich_letter_02", pause: { id: "listen-to-paper", remainingMs: 700 } });
    replay.tick(700);
    replay.advance();
    expect(replay.getSnapshot().active).toMatchObject({ id: "rich_letter_02", pause: { id: "read-margin", remainingMs: null } });
    const beforeNote = replay.save();
    const update = replay.activateSayLink("return-note");
    expect(update.events.filter(event => event.type === "sayLink")).toEqual([
      expect.objectContaining({ type: "sayLink", lineId: "rich_letter_02", spanId: "return-note", title: "铅笔补写的注记" }),
    ]);
    expect(replay.save()).toEqual({ ...beforeNote, state: { ...beforeNote.state, eventSequence: beforeNote.state.eventSequence + 1 } });
    replay.pause();
    replay.tick(30_000);
    replay.resume();
    expect(replay.getSnapshot().active).toMatchObject({ pause: { id: "read-margin", remainingMs: null } });
    const wireSave = JSON.parse(JSON.stringify(encodeNovelSaveData(replay.save())));
    expect(wireSave.formatVersion).toBe(4);
    replay.advance();
    replay.load(wireSave);
    expect(replay.getSnapshot().active).toMatchObject({ pause: { id: "read-margin", remainingMs: null } });
    reach(replay, "rich_letter_answer");
    const decision = replay.save();
    replay.selectChoice("wait_for_reply");
    reach(replay, "rich_letter_reply");
    replay.load(JSON.parse(JSON.stringify(decision)));
    replay.selectChoice("send_second_beam");
    reach(replay, "rich_letter_silence");
    expect(main.save()).toEqual(parked);
  } finally { replay.dispose(); main.dispose(); }
});

test("the English reader gets translated ranges, pauses and notes rather than Chinese offsets", () => {
  const catalogs = localeDocument.catalogs as StoryLocaleCatalogCollection;
  const localized = localizeStory(lanternStory, catalogs, "en");
  expect(diagnoseStoryLocale(lanternStory, catalogs.en).filter(issue => issue.path.includes("rich_letter"))).toEqual([]);
  const line = localized.story.script.rich_letter_entry?.find(op => op.type === "say" && op.id === "rich_letter_02");
  expect(line?.type).toBe("say");
  if (line?.type !== "say") throw new Error("Missing localized rich letter");
  const link = line.rich?.spans.find(span => span.id === "return-note");
  expect(Array.from(line.text).slice(link?.start, link?.end).join("")).toBe("RETURN");
  expect(link?.link?.title).toBe("The pencilled correction");
  expect(line.rich?.pauses.find(pause => pause.id === "read-margin")?.at).toBe(link?.end);
  expect(localized.story.replayEntries?.find(entry => entry.id === "rich_letter_showcase")?.title).toBe("A Second Sea inside the Letter");
});
