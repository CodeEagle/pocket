import { expect, test } from "bun:test";
import { createNovelEngine, type NovelEngine } from "@pocket/vn";
import localeDocument from "./novel.locales.json";
import assets from "./novel.assets.json";
import { diagnoseStoryLocale, localizeStory, type StoryLocaleCatalog } from "../../../../sdk/packages/pocket_vn/src/localization.ts";
import { lanternStory } from "./story.ts";

const english = localeDocument.catalogs.en as StoryLocaleCatalog;
const chinese = localeDocument.catalogs.zh as StoryLocaleCatalog;
const hiyoriAttribution = "This content uses sample data owned and copyrighted by Live2D Inc. The sample data are utilized in accordance with terms and conditions set by Live2D Inc. This content itself is created at the author’s sole discretion.";

type Engine = NovelEngine;
type FlowPoint = {
  phase: string;
  active: unknown;
  stage: unknown;
  variables: unknown;
  callStack: unknown;
  audioIntents: unknown;
  meta: unknown;
  eventCues: string[];
};

function settle(engine: Engine): void {
  for (let step = 0; step < 2_000; step++) {
    const snapshot = engine.getSnapshot();
    const active = snapshot.active;
    if (snapshot.phase === "choice" || snapshot.phase === "ending") return;
    if (snapshot.phase === "say" && active?.kind === "say") engine.advance();
    else if (snapshot.phase === "wait" && active?.kind === "wait") engine.tick(active.remainingMs);
    else if (snapshot.phase === "ready") engine.advance();
    else throw new Error(`Cannot progress localized story from ${snapshot.phase}`);
  }
  throw new Error("Localized story did not settle within the step limit");
}

function choose(engine: Engine, optionId: string): void {
  settle(engine);
  const active = engine.getSnapshot().active;
  if (active?.kind !== "choice") throw new Error(`Expected a choice before ${optionId}`);
  expect(active.options.map((option) => option.id)).toContain(optionId);
  engine.selectChoice(optionId);
  settle(engine);
}

function projectActive(active: ReturnType<Engine["getSnapshot"]>["active"]): unknown {
  if (!active) return null;
  if (active.kind === "say") return { kind: active.kind, id: active.id, location: active.location };
  if (active.kind === "choice") return {
    kind: active.kind,
    id: active.id,
    location: active.location,
    options: active.options.map(({ id, target, when }) => ({ id, target, when })),
    timeRemainingMs: active.timeRemainingMs,
  };
  if (active.kind === "ending") return { kind: active.kind, id: active.id, cg: active.cg, location: active.location };
  return { kind: active.kind, location: active.location };
}

function runEnding(story: typeof lanternStory, endingId: string): FlowPoint[] {
  const engine = createNovelEngine(story, { maxBacklogEntries: 128, maxRollbackEntries: 48 });
  const flow: FlowPoint[] = [];
  engine.subscribe((update) => {
    flow.push({
      phase: update.snapshot.phase,
      active: projectActive(update.snapshot.active),
      stage: update.snapshot.stage,
      variables: update.snapshot.variables,
      callStack: update.snapshot.callStack,
      audioIntents: update.snapshot.audioIntents,
      meta: update.snapshot.meta,
      eventCues: update.events.flatMap((event) => event.type === "audioCue" ? [event.cue] : []),
    });
  });

  try {
    engine.start();
    if (endingId === "truth_letter") {
      choose(engine, "listen_mira");
      choose(engine, "trust_mira");
      choose(engine, "archive");
      choose(engine, "ask_mira_archive");
      choose(engine, "affirm_mira");
      choose(engine, "clock");
      choose(engine, "single_pulse");
      choose(engine, "roof");
      choose(engine, "read_log");
      choose(engine, "relay");
      choose(engine, "open_dial");
      choose(engine, "route_7");
      choose(engine, "pulse_1");
      choose(engine, "minute_4");
      choose(engine, "affirm_mira");
      choose(engine, "send_truth");
    } else {
      choose(engine, "ask_ren");
      choose(engine, "last_train");
      choose(engine, endingId === "last_train" ? "send_train" : "keep_light");
    }
    expect(engine.getSnapshot()).toMatchObject({ phase: "ending", active: { kind: "ending", id: endingId } });
    return flow;
  } finally {
    engine.dispose();
  }
}

test("English catalog covers every line, choice and ending with matching placeholders", () => {
  const diagnostics = diagnoseStoryLocale(lanternStory, english, { assetRegistry: assets });
  expect(diagnostics).toEqual([]);
  const instructions = Object.values(lanternStory.script).flat();
  const sourceLines = instructions.filter((instruction) => instruction.type === "say");
  const sourceChoices = instructions.filter((instruction) => instruction.type === "choice");
  expect(sourceLines.length).toBeGreaterThanOrEqual(200);
  expect(Object.keys(english.lines ?? {})).toHaveLength(sourceLines.length);
  expect(Object.keys(english.choices ?? {})).toHaveLength(sourceChoices.length);
  expect(Object.keys(english.inputs ?? {})).toHaveLength(4);
  expect(Object.keys(english.endings ?? {}).sort()).toEqual(instructions.filter(instruction => instruction.type === "ending").map(instruction => instruction.id).sort());
  expect(english.replays?.model_showcase).toBe("Model theater");
  expect(english.replays?.feature_tour).toBe("5-Minute Feature Tour");
  expect(english.replays?.parallax_showcase).toBe("Lantern, Fog, and Distance");
  expect(english.replays?.score_handoff_showcase).toBe("When Dawn Takes the Score");
  expect(chinese.replays?.score_handoff_showcase).toBe("风暴交给晨光");
  expect(english.endings?.score_handoff_complete).toContain("Some farewells are quiet");
  expect(chinese.endings?.score_handoff_complete).toContain("雾港开始投递新一天的信");
  expect(english.lines?.score_handoff_02).toContain("My mother has waited long enough");
  expect(chinese.lines?.score_handoff_02).toContain("请等我回来");
  expect(english.lines?.model_showcase_hiyori_attribution).toBe(hiyoriAttribution);
  expect(chinese.lines?.model_showcase_hiyori_attribution).toBe(hiyoriAttribution);
  const intro = lanternStory.script.start?.find((instruction) => instruction.type === "say" && instruction.id === "arrival_01");
  const translatedIntro = localizeStory(lanternStory, { en: english }, "en", { assetRegistry: assets }).story.script.start?.find((instruction) => instruction.type === "say" && instruction.id === "arrival_01");
  expect(intro?.type === "say" ? intro.text : undefined).toContain("雾港灯塔站");
  expect(translatedIntro).toMatchObject({ id: "arrival_01", text: expect.stringContaining("Mist Harbor Lighthouse Station") });
  const translatedRecipient = localizeStory(lanternStory, { en: english }, "en", { assetRegistry: assets }).story.script.registry_open?.find((instruction) => instruction.type === "input" && instruction.id === "registry_recipient");
  expect(translatedRecipient).toMatchObject({
    type: "input",
    prompt: "Recipient name (1–16 characters)",
    placeholder: "For example: Lan🙂",
  });
  const translatedParallax = localizeStory(lanternStory, { en: english }, "en", { assetRegistry: assets }).story;
  expect(translatedParallax.script.parallax_showcase?.find(instruction => instruction.type === "say")).toMatchObject({
    id: "parallax_01",
    text: expect.stringContaining("The lighthouse lamp and sea mist"),
  });
  expect(translatedParallax.script.parallax_showcase_exit?.[0]).toMatchObject({
    type: "ending",
    id: "parallax_showcase_exit",
    text: expect.stringContaining("Return to journey"),
  });
});

test("the translated story executes the same clues, timer, cues and three endings", () => {
  const localized = localizeStory(lanternStory, { en: english }, "en", { assetRegistry: assets });
  const endingIds = ["truth_letter", "last_train", "keep_the_light"];
  for (const endingId of endingIds) {
    expect(runEnding(localized.story, endingId)).toEqual(runEnding(lanternStory, endingId));
  }
});
