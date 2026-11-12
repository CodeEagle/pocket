import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNovelEngine, createNovelReplayEngine, localizeStory, type NovelEngine, type StoryLocaleCatalogCollection } from "@pocket/vn";
import { lanternStory } from "./story.ts";
import localeDocument from "./novel.locales.json";
import assets from "./novel.assets.json";
import miraSpine from "./models/mira.spine.json";
import revisionMapV1 from "./revision-map.json";
import revisionMapV2 from "./revision-map-v2.json";
import revisionMapV3 from "./revision-map-v3.json";
import revisionMapV4 from "./revision-map-v4.json";
import revisionMapV5 from "./revision-map-v5.json";

const catalogs = localeDocument.catalogs as StoryLocaleCatalogCollection;

const engines: NovelEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

function newGame(): NovelEngine {
  const engine = createNovelEngine(lanternStory, {
    maxBacklogEntries: 128,
    maxRollbackEntries: 48,
  });
  engines.push(engine);
  return engine;
}

/** Complete dialogue by input, and waits/choices by explicit engine time. */
function settleUntilChoiceOrEnding(
  engine: NovelEngine,
  observe?: (phase: string, id: string | null) => void,
): void {
  for (let step = 0; step < 2_000; step++) {
    const snapshot = engine.getSnapshot();
    const active = snapshot.active;
    observe?.(snapshot.phase, active && "id" in active ? active.id : null);
    if (snapshot.phase === "choice" || snapshot.phase === "input" || snapshot.phase === "ending") return;
    if (snapshot.phase === "say" && active?.kind === "say") {
      engine.advance();
      continue;
    }
    if (snapshot.phase === "wait" && active?.kind === "wait") {
      engine.tick(active.remainingMs);
      continue;
    }
    if (snapshot.phase === "ready") {
      engine.advance();
      continue;
    }
    throw new Error(`Cannot progress story from phase ${snapshot.phase}`);
  }
  throw new Error("Story did not reach a choice or ending within the test step limit");
}

function choose(engine: NovelEngine, optionId: string): void {
  settleUntilChoiceOrEnding(engine);
  const active = engine.getSnapshot().active;
  expect(active?.kind).toBe("choice");
  if (active?.kind !== "choice") throw new Error(`Expected a choice before selecting ${optionId}`);
  expect(active.options.map((option) => option.id)).toContain(optionId);
  engine.selectChoice(optionId);
  settleUntilChoiceOrEnding(engine);
}

function progressToLine(engine: NovelEngine, lineId: string): void {
  for (let step = 0; step < 2_000; step++) {
    const snapshot = engine.getSnapshot();
    if (snapshot.phase === "say" && snapshot.active?.kind === "say" && snapshot.active.id === lineId) return;
    if (snapshot.phase === "say" && snapshot.active?.kind === "say") engine.advance();
    else if (snapshot.phase === "wait" && snapshot.active?.kind === "wait") engine.tick(snapshot.active.remainingMs);
    else throw new Error(`Expected to reach ${lineId}, reached ${snapshot.phase}`);
  }
  throw new Error(`Story did not reach ${lineId} within the test step limit`);
}

function progressToInput(engine: NovelEngine, inputId: string): void {
  for (let step = 0; step < 2_000; step++) {
    const snapshot = engine.getSnapshot();
    if (snapshot.active?.kind === "input") {
      expect(snapshot.active.id).toBe(inputId);
      return;
    }
    if (snapshot.phase === "say" && snapshot.active?.kind === "say") engine.advance();
    else if (snapshot.phase === "wait" && snapshot.active?.kind === "wait") engine.tick(snapshot.active.remainingMs);
    else if (snapshot.phase === "ready") engine.advance();
    else throw new Error(`Expected input ${inputId}, reached ${snapshot.phase}`);
  }
  throw new Error(`Story did not reach input ${inputId} within the test step limit`);
}

function progressToChoice(engine: NovelEngine, choiceId: string): void {
  for (let step = 0; step < 2_000; step++) {
    const snapshot = engine.getSnapshot();
    if (snapshot.active?.kind === "choice") {
      expect(snapshot.active.id).toBe(choiceId);
      return;
    }
    if (snapshot.phase === "say" && snapshot.active?.kind === "say") engine.advance();
    else if (snapshot.phase === "wait" && snapshot.active?.kind === "wait") engine.tick(snapshot.active.remainingMs);
    else throw new Error(`Expected choice ${choiceId}, reached ${snapshot.phase}`);
  }
  throw new Error(`Story did not reach choice ${choiceId} within the test step limit`);
}

function chooseShowcaseAction(
  engine: NovelEngine,
  menuId: string,
  optionId: string,
  lineId: string,
  characterId: string,
  modelKey: string,
  animation: string,
  loop: boolean,
): void {
  const active = engine.getSnapshot().active;
  expect(active?.kind).toBe("choice");
  if (active?.kind !== "choice") throw new Error(`Expected showcase menu ${menuId}`);
  expect(active.id).toBe(menuId);
  expect(active.options.map(option => option.id)).toContain(optionId);
  engine.selectChoice(optionId);

  const display = engine.getSnapshot();
  expect(display).toMatchObject({ phase: "say", active: { kind: "say", id: lineId } });
  expect(display.stage.characters[characterId]).toMatchObject({
    visible: true,
    model: { key: modelKey, animation, loop },
  });
  expect(display.stage.video).toBeNull();

  engine.advance();
  progressToChoice(engine, menuId);
}

function previewHiyoriFraming(optionId: string, motion: string, animation: string, loop: boolean, engine: NovelEngine): void {
  const menu = engine.getSnapshot().active;
  expect(menu?.kind).toBe("choice");
  if (menu?.kind !== "choice") throw new Error("Expected the Hiyori action menu");
  expect(menu.id).toBe("model_showcase_hiyori_actions");
  expect(menu.options.map(option => option.id)).toContain(optionId);
  engine.selectChoice(optionId);

  const framingId = `model_showcase_hiyori_${motion}_framing`;
  const character = () => engine.getSnapshot().stage.characters.sample_hiyori;
  expect(engine.getSnapshot()).toMatchObject({
    phase: "wait",
    active: { kind: "wait", durationMs: 2600, remainingMs: 2600 },
    stage: {
      characters: {
        mira: { visible: false },
        ren: { visible: false },
        sample_hiyori: { visible: true, position: { x: 0, y: 80 }, scale: 1.5, model: { key: "hiyori_sample", animation, loop } },
      },
      video: null,
      camera: { x: 0, y: 0, scale: 1, motion: null },
    },
  });
  engine.tick(2600);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: framingId });

  engine.selectChoice(`hiyori_${motion}_face`);
  expect(engine.getSnapshot()).toMatchObject({
    phase: "wait",
    active: { kind: "wait", durationMs: 2600, remainingMs: 2600 },
    stage: {
      characters: {
        mira: { visible: false },
        ren: { visible: false },
        sample_hiyori: {
          visible: true,
          position: { x: -210, y: 35 },
          scale: 3.5,
          model: { key: "hiyori_sample", animation, loop },
        },
      },
      video: null,
      camera: { x: 0, y: 0, scale: 1, motion: null },
    },
  });
  engine.tick(2600);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: framingId });

  engine.selectChoice(`hiyori_${motion}_wide`);
  expect(character()).toMatchObject({ visible: true, position: { x: 0, y: 80 }, scale: 1.5, model: { animation } });
  expect(engine.getSnapshot().active).toMatchObject({ kind: "wait", durationMs: 2600 });
  engine.tick(2600);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: framingId });

  engine.selectChoice(`hiyori_${motion}_menu`);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "model_showcase_hiyori_actions" });
}

function openReplyAddress(engine: NovelEngine): void {
  engine.start();
  choose(engine, "ask_ren");
  choose(engine, "archive");
  choose(engine, "copy_route");
  expectChoiceOptions(engine, ["clock", "roof", "memory", "leave_reply_address", "last_train"]);
  choose(engine, "leave_reply_address");
  progressToChoice(engine, "platform_stall_menu");
  engine.selectChoice("leave_stall");
  progressToInput(engine, "registry_recipient");
}

function expectChoiceOptions(engine: NovelEngine, expected: string[]): void {
  const active = engine.getSnapshot().active;
  expect(active?.kind).toBe("choice");
  if (active?.kind !== "choice") throw new Error("Expected a choice state");
  expect(active.options.map((option) => option.id)).toEqual(expected);
}

function begin(engine: NovelEngine, trustMira: boolean): void {
  engine.start();
  choose(engine, trustMira ? "listen_mira" : "ask_ren");
  if (trustMira) choose(engine, "trust_mira");
}

function investigateAll(engine: NovelEngine, trustMira: boolean): void {
  begin(engine, trustMira);
  expectChoiceOptions(engine, ["archive", "clock", "roof", "memory", "last_train"]);

  choose(engine, "archive");
  if (trustMira) {
    choose(engine, "ask_mira_archive");
    choose(engine, "affirm_mira");
  } else {
    choose(engine, "copy_route");
  }
  expect(engine.getSnapshot().variables.found_route).toBe(true);
  expect(engine.getSnapshot().callStack).toHaveLength(0);

  choose(engine, "clock");
  choose(engine, "single_pulse");
  expect(engine.getSnapshot().variables.found_clock).toBe(true);

  choose(engine, "roof");
  choose(engine, "read_log");
  expect(engine.getSnapshot().variables.found_lens).toBe(true);
  expect(engine.getSnapshot().variables.roof_log_read).toBe(true);
  expect(engine.getSnapshot().callStack).toHaveLength(0);
  expect(engine.getSnapshot().variables.investigation_count).toBe(3);
}

function openRelay(engine: NovelEngine): void {
  choose(engine, "relay");
  choose(engine, "open_dial");
}

function dial(engine: NovelEngine, route: 1 | 4 | 7, pulse: 1 | 4 | 7, minute: 1 | 4 | 7): void {
  choose(engine, `route_${route}`);
  choose(engine, `pulse_${pulse}`);
  choose(engine, `minute_${minute}`);
}

function expectEnding(engine: NovelEngine, endingId: string, cgId: string): void {
  const snapshot = engine.getSnapshot();
  expect(snapshot.phase).toBe("ending");
  expect(snapshot.active?.kind).toBe("ending");
  if (snapshot.active?.kind !== "ending") throw new Error("Expected an ending state");
  expect(snapshot.active.id).toBe(endingId);
  expect(snapshot.active.cg).toBe(cgId);
  expect(snapshot.meta.endingIds).toContain(endingId);
  expect(snapshot.meta.cgIds).toContain(cgId);
}

test("canonical editor JSON is serializable and every scripted route resolves", () => {
  expect(JSON.parse(JSON.stringify(lanternStory))).toEqual(lanternStory);

  const labels = new Set(Object.keys(lanternStory.script));
  const lineIds = new Set<string>();
  const inputIds = new Set<string>();
  expect(lanternStory.script.start?.find(instruction => instruction.type === "say" && instruction.id === "arrival_01"))
    .toMatchObject({ type: "say", id: "arrival_01" });
  for (const [label, instructions] of Object.entries(lanternStory.script)) {
    for (const instruction of instructions) {
      if (instruction.type === "say") {
        expect(lineIds.has(instruction.id)).toBe(false);
        lineIds.add(instruction.id);
      }
      if (instruction.type === "jump" || instruction.type === "call") {
        expect(labels.has(instruction.target)).toBe(true);
      } else if (instruction.type === "branch") {
        expect(labels.has(instruction.then)).toBe(true);
        expect(labels.has(instruction.else)).toBe(true);
      } else if (instruction.type === "choice") {
        for (const option of instruction.options) expect(labels.has(option.target)).toBe(true);
        if (instruction.timeoutTarget) expect(labels.has(instruction.timeoutTarget)).toBe(true);
      } else if (instruction.type === "input") {
        expect(inputIds.has(instruction.id)).toBe(false);
        inputIds.add(instruction.id);
        if (instruction.cancelTarget) expect(labels.has(instruction.cancelTarget)).toBe(true);
      }
    }
    expect(label.length).toBeGreaterThan(0);
  }
  expect(lineIds.size).toBeGreaterThan(50);
  expect(inputIds).toEqual(new Set(["registry_recipient", "registry_mailbox", "registry_public_consent", "tour_note"]));
  expect(() => createNovelEngine(lanternStory)).not.toThrow();
});

test("the optional archive reel is a non-looping memory, not evidence or an automatic story advance", () => {
  const engine = newGame();
  engine.start();
  choose(engine, "ask_ren");
  choose(engine, "archive");
  expectChoiceOptions(engine, ["copy_route", "ask_mira_archive", "leave_archive", "watch_archive_reel"]);
  expect(engine.getSnapshot().variables.found_route).toBe(false);

  const started = engine.selectChoice("watch_archive_reel");
  expect(started.snapshot.active).toMatchObject({ kind: "say", id: "archive_reel_01" });
  expect(started.snapshot.variables.found_route).toBe(false);
  const intro = engine.advance();
  expect(intro.snapshot.active).toMatchObject({ kind: "say", id: "archive_reel_01", complete: true });
  const play = engine.advance();
  expect(play.events).toContainEqual(expect.objectContaining({
    type: "videoCue",
    action: "play",
    cue: "archive_route_reel",
  }));
  expect(play.snapshot.stage.video).toMatchObject({ cue: "archive_route_reel", loop: false, status: "playing" });
  expect(play.snapshot.active).toMatchObject({ kind: "say", id: "archive_reel_02" });
  expect(play.snapshot.variables.found_route).toBe(false);

  const reelEvents: string[] = [];
  engine.subscribe(update => reelEvents.push(...update.events.flatMap(event =>
    event.type === "videoCue" ? [`${event.action}:${event.cue}`] : [],
  )));
  settleUntilChoiceOrEnding(engine);
  expect(reelEvents).toContain("close:archive_route_reel");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "investigation_hub" });
  expect(engine.getSnapshot().stage.video).toBeNull();
  expect(engine.getSnapshot().variables.found_route).toBe(false);
});

test("the optional return label commits typed fields only after valid submission", () => {
  const engine = newGame();
  openReplyAddress(engine);
  const recipient = engine.getSnapshot().active;
  expect(recipient).toMatchObject({
    kind: "input",
    id: "registry_recipient",
    variable: "reply_name",
    inputType: "text",
    placeholder: "例如：小岚🙂",
    canCancel: true,
    draft: "",
    error: null,
  });

  // Auto, skip, pause and virtual time all stop at an active input.
  engine.setPreferences({ mode: "auto", autoDelayMs: 0 });
  engine.tick(60_000);
  expect(engine.getSnapshot().active?.kind).toBe("input");
  engine.setPreferences({ mode: "skip", skipSeenOnly: false });
  engine.tick(60_000);
  engine.pause();
  engine.tick(60_000);
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "registry_recipient" });
  engine.resume();

  engine.updateInput("小岚🙂");
  engine.submitInput();
  expect(engine.getSnapshot().variables.reply_name).toBe("小岚🙂");
  progressToInput(engine, "registry_mailbox");

  engine.updateInput("1e");
  engine.submitInput();
  expect(engine.getSnapshot().active).toMatchObject({ kind: "input", id: "registry_mailbox", error: { code: "number" } });
  expect(engine.getSnapshot().variables).not.toHaveProperty("reply_box");
  engine.updateInput("1e2");
  engine.submitInput();
  expect(engine.getSnapshot().variables.reply_box).toBe(100);
  progressToInput(engine, "registry_public_consent");

  engine.updateInput(true);
  engine.submitInput();
  expect(engine.getSnapshot().variables.reply_public).toBe(true);
  settleUntilChoiceOrEnding(engine);
  expectChoiceOptions(engine, ["clock", "roof", "memory", "leave_reply_address", "last_train"]);
  expect(engine.getSnapshot().backlog.map((entry) => entry.lineId)).toContain("registry_04_yes");
});

test("cancelling the first return-label field leaves its variable uncommitted", () => {
  const engine = newGame();
  openReplyAddress(engine);
  engine.updateInput("未寄出的草稿🙂");
  engine.cancelInput();

  expect(engine.getSnapshot().variables).not.toHaveProperty("reply_name");
  expect(engine.getSnapshot().variables).not.toHaveProperty("reply_box");
  progressToChoice(engine, "investigation_hub");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "investigation_hub" });
});

test("evidence, call/return, one failed code and a correct 714 unlock the true ending", () => {
  const engine = newGame();
  const cues = new Set<string>();
  const backgrounds = new Set<string | null>();
  let sawWait = false;
  engine.subscribe((update) => {
    backgrounds.add(update.snapshot.stage.background);
    for (const event of update.events) if (event.type === "audioCue") cues.add(event.cue);
    if (update.snapshot.phase === "wait") sawWait = true;
  });

  investigateAll(engine, true);
  expect(engine.getSnapshot().variables.mira_trust).toBeGreaterThan(0);
  expect(engine.getSnapshot().variables.proof_complete).toBe(false);
  expect(engine.getSnapshot().callStack).toHaveLength(0);
  expectChoiceOptions(engine, ["memory", "leave_reply_address", "relay", "last_train"]);

  openRelay(engine);
  dial(engine, 7, 4, 1);
  expect(engine.getSnapshot().variables.code_misses).toBe(1);
  expect(engine.getSnapshot().variables.proof_complete).toBe(false);
  expect(engine.getSnapshot().backlog.at(-1)?.text).toContain("已经试过 1 次");

  choose(engine, "retry_now");
  dial(engine, 7, 1, 4);
  expect(engine.getSnapshot().variables.proof_complete).toBe(true);
  choose(engine, "affirm_mira");
  expectChoiceOptions(engine, ["send_truth", "send_train", "keep_light"]);
  choose(engine, "send_truth");

  expectEnding(engine, "truth_letter", "truth_letter");
  expect(sawWait).toBe(true);
  expect(backgrounds).toEqual(new Set(["station", "archive", "roof", "dawn"]));
  for (const cue of ["music_storm", "station_bell", "roof_gust", "relay_click", "music_dawn"]) {
    expect(cues.has(cue)).toBe(true);
  }
  expect(engine.getSnapshot().backlog.map((entry) => entry.lineId)).toContain("truth_04");
});

test("a second wrong code locks the relay but leaves the shelter ending available", () => {
  const engine = newGame();
  investigateAll(engine, false);
  openRelay(engine);
  dial(engine, 7, 4, 1);
  choose(engine, "retry_now");
  dial(engine, 4, 7, 1);

  expect(engine.getSnapshot().variables.code_misses).toBe(2);
  expect(engine.getSnapshot().variables.relay_locked).toBe(true);
  expect(engine.getSnapshot().variables.proof_complete).toBe(false);
  expectChoiceOptions(engine, ["send_train", "keep_light"]);
  choose(engine, "keep_light");
  expectEnding(engine, "keep_the_light", "harbor_light");
});

test("the last train ending remains reachable without solving the relay", () => {
  const engine = newGame();
  begin(engine, false);
  choose(engine, "last_train");
  expectChoiceOptions(engine, ["send_train", "keep_light"]);
  choose(engine, "send_train");
  expectEnding(engine, "last_train", "dawn_departure");
});

test("timing out first evacuates the station, then safely sends the letter by train", () => {
  const engine = newGame();
  begin(engine, false);
  choose(engine, "last_train");

  expect(engine.getSnapshot().active?.kind).toBe("choice");
  const choice = engine.getSnapshot().active;
  const transitionRemaining = engine.getSnapshot().stage.transition
    ? engine.getSnapshot().stage.transition.durationMs - engine.getSnapshot().stage.transition.elapsedMs
    : 0;
  engine.tick((choice?.kind === "choice" ? choice.timeRemainingMs ?? 0 : 0) + transitionRemaining);
  expect(engine.getSnapshot().variables.timed_out).toBe(true);
  expect(engine.getSnapshot().active?.kind).toBe("say");
  expect(engine.getSnapshot().backlog.map((entry) => entry.lineId)).not.toContain("timeout_01");
  settleUntilChoiceOrEnding(engine);

  expectEnding(engine, "last_train", "dawn_departure");
  expect(engine.getSnapshot().backlog.map((entry) => entry.lineId)).toContain("timeout_01");
});

test("v3 choice facts are consumed later without changing the dial or storm-window contract", () => {
  const engine = newGame();
  engine.start();

  // The initial Ren conversation and the clock-room conversation both feed
  // the later trust threshold; the two chimes leave a separate pressure fact.
  choose(engine, "ask_ren");
  choose(engine, "memory");
  choose(engine, "keep_record");
  expect(engine.getSnapshot().variables.memory_recorded).toBe(true);
  choose(engine, "memory");
  choose(engine, "return_quiet");
  expect(engine.getSnapshot().variables.memory_recorded).toBe(true);

  choose(engine, "clock");
  choose(engine, "double_pulse");
  expect(engine.getSnapshot().variables.storm_pressure).toBe(1);
  choose(engine, "single_pulse");
  expect(engine.getSnapshot().variables.found_clock).toBe(true);
  expect(engine.getSnapshot().variables.ren_trust).toBe(2);

  // Choosing the lens first leaves the log fact false. The relay explicitly
  // performs that missing check before the unchanged relay-ready lines.
  choose(engine, "roof");
  choose(engine, "check_lens");
  expect(engine.getSnapshot().variables.roof_log_read).toBe(false);
  choose(engine, "archive");
  choose(engine, "copy_route");
  expect(engine.getSnapshot().variables.found_route).toBe(true);

  choose(engine, "relay");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "relay_open" });
  expect(engine.getSnapshot().variables.roof_log_read).toBe(true);
  expect(engine.getSnapshot().variables.memory_recorded).toBe(true);
  expect(engine.getSnapshot().variables.ren_trust).toBe(2);
  expect(engine.getSnapshot().backlog.map(entry => entry.lineId)).toContain("v3_relay_log_read");
  expect(engine.getSnapshot().backlog.map(entry => entry.lineId)).toContain("v3_relay_ren_trust");

  choose(engine, "open_dial");
  dial(engine, 7, 1, 4);
  expect(engine.getSnapshot().variables.proof_complete).toBe(true);
  choose(engine, "affirm_mira");
  const signal = engine.getSnapshot();
  expect(signal.active).toMatchObject({ kind: "choice", id: "signal_window", timeRemainingMs: 16_000 });
  const visibleLines = signal.backlog.map(entry => entry.lineId);
  expect(visibleLines).toContain("v3_signal_pressure");
  expect(visibleLines).toContain("v3_signal_record");
  expect(visibleLines).not.toContain("v3_signal_relay_locked");

  choose(engine, "send_truth");
  expectEnding(engine, "truth_letter", "truth_letter");
});

test("protecting the sealed letter is acknowledged before the unchanged train ending", () => {
  const engine = newGame();
  engine.start();
  choose(engine, "ask_ren");
  choose(engine, "memory");
  choose(engine, "protect_letter");
  expect(engine.getSnapshot().variables.letter_protected).toBe(true);

  choose(engine, "last_train");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "signal_window", timeRemainingMs: 16_000 });
  expect(engine.getSnapshot().backlog.map(entry => entry.lineId)).toContain("v3_signal_letter_kept");
  expect(engine.getSnapshot().backlog.map(entry => entry.lineId)).not.toContain("v3_signal_letter_noted");
  choose(engine, "send_train");
  expectEnding(engine, "last_train", "dawn_departure");
});

test("checking the envelope is carried forward as an observed, unopened fact", () => {
  const engine = newGame();
  engine.start();
  choose(engine, "check_seal");
  expect(engine.getSnapshot().variables.letter_seen).toBe(true);
  choose(engine, "last_train");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "signal_window", timeRemainingMs: 16_000 });
  expect(engine.getSnapshot().backlog.map(entry => entry.lineId)).toContain("v3_signal_letter_noted");
  expect(engine.getSnapshot().backlog.map(entry => entry.lineId)).not.toContain("v3_signal_letter_kept");
  choose(engine, "send_train");
  expectEnding(engine, "last_train", "dawn_departure");
});

test("relay decisions retain both clue review and direct train routes", () => {
  const engine = newGame();
  investigateAll(engine, false);
  choose(engine, "relay");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "relay_open" });
  choose(engine, "revisit_clues");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "investigation_hub" });
  choose(engine, "relay");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "relay_open" });
  choose(engine, "skip_relay");
  expect(engine.getSnapshot().active).toMatchObject({ kind: "choice", id: "signal_window", timeRemainingMs: 16_000 });
  const signal = engine.getSnapshot().active;
  expect(signal?.kind === "choice" ? signal.options.map(option => option.id) : []).toEqual(["send_train", "keep_light"]);
  choose(engine, "send_train");
  expectEnding(engine, "last_train", "dawn_departure");
});

test("all six authored memory follow-up lines play before their call returns", () => {
  for (const [responseId, lines] of [
    ["trust_mira", ["add_memory_trust_01", "add_memory_trust_02"]],
    ["protect_letter", ["add_memory_protect_01", "add_memory_protect_02"]],
    ["keep_record", ["add_memory_record_01", "add_memory_record_02"]],
  ] as const) {
    const engine = newGame();
    engine.start();
    choose(engine, "ask_ren");
    choose(engine, "memory");
    choose(engine, responseId);
    const observed = new Set(engine.getSnapshot().backlog.map(entry => entry.lineId));
    for (const lineId of lines) expect(observed.has(lineId)).toBe(true);
  }

  const repeated = newGame();
  repeated.start();
  choose(repeated, "ask_ren");
  choose(repeated, "memory");
  choose(repeated, "trust_mira");
  choose(repeated, "memory");
  choose(repeated, "return_quiet");
  const observed = new Set(repeated.getSnapshot().backlog.map(entry => entry.lineId));
  expect(observed.has("add_memory_record_01")).toBe(true);
  expect(observed.has("add_memory_record_02")).toBe(true);
  expect(repeated.getSnapshot().variables.memory_recorded).toBe(true);
});

test("JSON save/load preserves the active choice and rollback plus seen-only skip stop at unread text", () => {
  const started = newGame();
  started.start();
  settleUntilChoiceOrEnding(started);
  const serialized = JSON.parse(JSON.stringify(started.save()));

  const restored = newGame();
  restored.load(serialized);
  expect(restored.getSnapshot().active).toEqual(started.getSnapshot().active);
  expect(restored.getSnapshot().stage.background).toBe("station");

  const arrivalChoice = restored.getSnapshot().active;
  expect(arrivalChoice?.kind).toBe("choice");
  restored.selectChoice("check_seal");
  progressToLine(restored, "hub_01");
  expect(restored.getSnapshot().backlog.map((entry) => entry.lineId)).toContain("arrival_seal_02");
  const readBeforeRollback = restored.getSnapshot().meta.readLineIds;
  restored.rollback(1);
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "arrival_seal_02", complete: true });
  expect(restored.getSnapshot().meta.readLineIds).toEqual(readBeforeRollback);

  restored.setPreferences({ mode: "skip", skipSeenOnly: true, textSpeedCharsPerSecond: 0, autoDelayMs: 0 });
  restored.tick(0);
  expect(restored.getSnapshot().active).toMatchObject({ kind: "say", id: "hub_01", complete: true });
  expect(restored.getSnapshot().meta.readLineIds).not.toContain("hub_01");
  expect(restored.getSnapshot().preferences.mode).toBe("skip");
});

test("gallery replays are localized, unlock from reached endings, and leave the main save isolated", () => {
  const localized = localizeStory(lanternStory, catalogs, "en");
  expect(localized.story.replayEntries?.map(entry => [entry.id, entry.title])).toEqual([
    ["truth_ending_replay", "A reply crosses twenty years, but the way back closes."],
    ["train_ending_replay", "The messenger finds her family; the past stays silent."],
    ["shelter_ending_replay", "Everyone reaches shelter; the relay is lost."],
    ["archive_reel_memory", "The old Route 7 reel"],
    ["model_showcase", "Model theater"],
    ["feature_tour", "5-Minute Feature Tour"],
    ["parallax_showcase", "Lantern, Fog, and Distance"],
    ["letter_showcase", "An Unsent Letter"],
    ["inventory_showcase", "Harbor supplies · trading and inventory"],
    ["transition_showcase", "Through the Fog"],
    ["timeline_showcase", "Lighthouse Ensemble"],
    ["score_handoff_showcase", "When Dawn Takes the Score"],
    ["chapter_blueprint_showcase", "The Sixtieth Light"],
    ["scene_objects_showcase", "Two Objects beneath the Lamp"],
    ["rich_letter_showcase", "A Second Sea inside the Letter"],
  ]);
  for (const entry of localized.story.replayEntries ?? []) {
    const source = newGame();
    if (entry.unlockEndingId === undefined) {
      const replay = createNovelReplayEngine(localized.story, source.getSnapshot(), entry.id);
      engines.push(replay);
      expect(replay.getSnapshot().stage.background).toBeDefined();
      expect(replay.getSnapshot().active).not.toBeNull();
    } else {
      expect(() => createNovelReplayEngine(localized.story, source.getSnapshot(), entry.id)).toThrow();
    }
  }

  const main = newGame();
  begin(main, false);
  choose(main, "last_train");
  choose(main, "send_train");
  expectEnding(main, "last_train", "dawn_departure");
  const before = JSON.parse(JSON.stringify(main.save()));

  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "train_ending_replay");
  engines.push(replay);
  expect(replay.getSnapshot()).toMatchObject({
    paused: false,
    active: { kind: "say", id: "train_01" },
    stage: { background: "dawn" },
  });
  settleUntilChoiceOrEnding(replay);
  expect(replay.getSnapshot().active).toMatchObject({ kind: "ending", id: "last_train" });
  expect(main.save()).toEqual(before);
});

test("the unsent-letter replay uses three reading presentations without changing main progress", () => {
  const main = newGame();
  main.start();
  const before = JSON.parse(JSON.stringify(main.save()));
  for (const locale of ["zh", "en"]) {
    const localized = localizeStory(lanternStory, catalogs, locale);
    const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "letter_showcase");
    engines.push(replay);
    expect(replay.getSnapshot()).toMatchObject({
      active: { kind: "say", id: "letter_showcase_01", presentation: "fullscreen" },
    });
    const first = replay.getSnapshot().active;
    expect(first?.kind === "say" && first.text.includes(locale === "zh" ? "天亮以后，带着它出发。" : "take it with you and go.")).toBe(true);
    progressToLine(replay, "letter_showcase_02");
    expect(replay.getSnapshot()).toMatchObject({
      active: { kind: "say", id: "letter_showcase_02", presentation: "floating" },
    });
    progressToLine(replay, "letter_showcase_03");
    const last = replay.getSnapshot().active;
    expect(last).toMatchObject({ kind: "say", id: "letter_showcase_03", speaker: "Mira" });
    expect(last).not.toHaveProperty("presentation");
    expect(main.save()).toEqual(before);
  }
});

test("model theater is an unlocked replay, exposes the model choices, and leaves main progress unchanged", () => {
  const localized = localizeStory(lanternStory, catalogs, "en");
  const chinese = localizeStory(lanternStory, catalogs, "zh");
  expect(chinese.story.replayEntries?.find(entry => entry.id === "model_showcase")?.title).toBe("立绘试映");
  const main = newGame();
  main.start();
  choose(main, "ask_ren");
  const before = JSON.parse(JSON.stringify(main.save()));

  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "model_showcase");
  engines.push(replay);
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "model_showcase_intro" },
    stage: { background: "station", video: null, camera: { x: 0, y: 0, scale: 1, motion: null } },
  });
  choose(replay, "showcase_mira_spine");
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "choice", id: "model_showcase_mira_actions" },
    stage: {
      characters: {
        mira: { visible: true, model: { key: "mira_spine", animation: "idle", loop: true } },
        ren: { visible: false },
        sample_hiyori: { visible: false },
      },
      video: null,
      camera: { x: 0, y: 0, scale: 1, motion: null },
    },
  });
  chooseShowcaseAction(replay, "model_showcase_mira_actions", "mira_show_idle", "model_showcase_mira_idle_display", "mira", "mira_spine", "idle", true);
  chooseShowcaseAction(replay, "model_showcase_mira_actions", "mira_show_alert", "model_showcase_mira_alert_display", "mira", "mira_spine", "alert", true);
  chooseShowcaseAction(replay, "model_showcase_mira_actions", "mira_show_settle", "model_showcase_mira_settle_display", "mira", "mira_spine", "settle", true);
  choose(replay, "return_to_showcase_catalog");
  expect(Object.values(replay.getSnapshot().stage.characters).filter(character => character.visible && character.model)).toEqual([]);
  choose(replay, "showcase_hiyori_live2d");
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "choice", id: "model_showcase_hiyori_actions" },
    stage: {
      characters: {
        mira: { visible: false },
        ren: { visible: false },
        sample_hiyori: { visible: true, model: { key: "hiyori_sample", animation: "Idle:0", loop: true } },
      },
      video: null,
      camera: { x: 0, y: 0, scale: 1, motion: null },
    },
  });
  previewHiyoriFraming("hiyori_show_idle_0", "idle_0", "Idle:0", true, replay);
  previewHiyoriFraming("hiyori_show_idle_1", "idle_1", "Idle:1", true, replay);
  previewHiyoriFraming("hiyori_show_tap_body", "tap_body", "TapBody:0", false, replay);
  choose(replay, "return_hiyori_to_catalog");
  expect(Object.values(replay.getSnapshot().stage.characters).filter(character => character.visible && character.model)).toEqual([]);
  expect(main.save()).toEqual(before);
});

test("feature tour is a self-initializing replay and cannot change the parked main save", () => {
  const localized = localizeStory(lanternStory, catalogs, "en");
  const chinese = localizeStory(lanternStory, catalogs, "zh");
  expect(chinese.story.replayEntries?.find(entry => entry.id === "feature_tour")?.title).toBe("5分钟能力巡演");
  expect(lanternStory.replayEntries?.find(entry => entry.id === "feature_tour")).toEqual({
    id: "feature_tour",
    title: "5分钟能力巡演",
    location: { label: "feature_tour", index: 0 },
  });
  expect(lanternStory.replayEntries?.find(entry => entry.id === "model_showcase")).toEqual({
    id: "model_showcase",
    title: "立绘试映",
    location: { label: "model_showcase", index: 0 },
  });

  const main = newGame();
  main.start();
  choose(main, "ask_ren");
  const before = JSON.parse(JSON.stringify(main.save()));

  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "feature_tour");
  engines.push(replay);
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "tour_01" },
    stage: {
      background: "station",
      characters: { mira: { visible: true, model: { key: "mira_spine", animation: "idle" } }, ren: { visible: false } },
      video: null,
    },
    variables: { tour_word: "" },
  });

  progressToChoice(replay, "tour_hub");
  expect(replay.getSnapshot().active).toMatchObject({
    kind: "choice",
    options: [{ id: "tour_reel" }, { id: "tour_signal" }, { id: "tour_write" }],
  });
  replay.selectChoice("tour_signal");
  progressToChoice(replay, "tour_dial");
  replay.selectChoice("tour_dial_7");
  expect(replay.getSnapshot()).toMatchObject({ active: { kind: "say", id: "tour_dial_success" }, variables: { tour_route: 7 } });
  replay.advance();
  replay.advance();
  progressToChoice(replay, "tour_hub");

  replay.selectChoice("tour_write");
  progressToInput(replay, "tour_note");
  replay.updateInput("Keep the window open.");
  replay.submitInput();
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "tour_06" });
  expect(replay.getSnapshot().variables.tour_word).toBe("Keep the window open.");
  replay.advance();
  replay.advance();
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "tour_07" });
  expect(main.save()).toEqual(before);
});

test("parallax showcase runs camera and layer choices in an isolated replay", () => {
  const localized = localizeStory(lanternStory, catalogs, "en");
  const chinese = localizeStory(lanternStory, catalogs, "zh");
  expect(assets.backgrounds.parallax_station).toBe(assets.backgrounds.station);
  expect(assets.backgrounds.parallax_lantern).toBe("art/fx/parallax-lantern.png");
  expect(assets.backgrounds.sea_mist).toBe("art/fx/sea-mist.png");
  expect(lanternStory.replayEntries?.find(entry => entry.id === "parallax_showcase")).toEqual({
    id: "parallax_showcase",
    title: "灯火与雾的层次",
    location: { label: "parallax_showcase", index: 0 },
  });
  expect(localized.story.replayEntries?.find(entry => entry.id === "parallax_showcase")?.title).toBe("Lantern, Fog, and Distance");
  expect(chinese.story.replayEntries?.find(entry => entry.id === "parallax_showcase")?.title).toBe("灯火与雾的层次");

  const main = newGame();
  main.start();
  choose(main, "ask_ren");
  const before = JSON.parse(JSON.stringify(main.save()));
  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "parallax_showcase");
  engines.push(replay);

  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "parallax_01" },
    stage: {
      background: "parallax_station",
      backgroundLayers: [
        { background: "parallax_lantern", parallax: 0.42 },
        { background: "sea_mist", parallax: 0.12 },
      ],
      camera: { x: 0, y: 0, scale: 1, motion: null },
    },
  });
  progressToChoice(replay, "parallax_showcase_menu");

  replay.selectChoice("parallax_pan");
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "parallax_pan_note" },
    stage: {
      background: "parallax_station",
      backgroundLayers: [{ background: "parallax_lantern" }, { background: "sea_mist" }],
      camera: { x: -38, y: -12, scale: 1.08, motion: { durationMs: 1200 } },
    },
  });
  progressToChoice(replay, "parallax_showcase_menu");

  replay.selectChoice("parallax_clear");
  expect(replay.getSnapshot()).toMatchObject({ active: { kind: "say", id: "parallax_clear_note" } });
  expect(replay.getSnapshot().stage.backgroundLayers).toBeUndefined();
  progressToChoice(replay, "parallax_showcase_menu");

  replay.selectChoice("parallax_restore");
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "parallax_restore_note" },
    stage: { backgroundLayers: [{ background: "parallax_lantern" }, { background: "sea_mist" }] },
  });
  progressToChoice(replay, "parallax_showcase_menu");
  replay.selectChoice("parallax_zoom");
  expect(replay.getSnapshot()).toMatchObject({
    active: { kind: "say", id: "parallax_zoom_note" },
    stage: { camera: { x: 18, y: -24, scale: 1.2, motion: { durationMs: 1200 } } },
  });
  progressToChoice(replay, "parallax_showcase_menu");
  replay.selectChoice("parallax_exit");
  expect(replay.getSnapshot()).toMatchObject({ phase: "ending", active: { kind: "ending", id: "parallax_showcase_exit" } });
  expect(main.save()).toEqual(before);
});

test("v1 through v5 save maps point directly to v6; only the six Hiyori framing labels may vary position and scale", () => {
  expect(lanternStory.version).toBe(6);
  expect([revisionMapV1.fromVersion, revisionMapV2.fromVersion, revisionMapV3.fromVersion, revisionMapV4.fromVersion, revisionMapV5.fromVersion]).toEqual([1, 2, 3, 4, 5]);
  expect([revisionMapV1.toVersion, revisionMapV2.toVersion, revisionMapV3.toVersion, revisionMapV4.toVersion, revisionMapV5.toVersion]).toEqual([6, 6, 6, 6, 6]);
  const temporary = mkdtempSync(join(tmpdir(), "lantern-v6-revision-map-"));
  const targetPath = join(temporary, "story.json");
  const outputPath = join(temporary, "revision-map.json");
  const generator = join(import.meta.dir, "scripts/generate_revision_map.ts");
  const legacyApp = resolve(import.meta.dir, "../../../../sdk/.pocket-build/lantern-v3-causal-20261108/app.js");
  const allowedLabels = [
    "model_showcase_hiyori_idle_0", "model_showcase_hiyori_idle_0_closeup",
    "model_showcase_hiyori_idle_1", "model_showcase_hiyori_idle_1_closeup",
    "model_showcase_hiyori_tap_body", "model_showcase_hiyori_tap_body_closeup",
  ].join(",");
  const run = (target: unknown, options: string[] = []) => {
    writeFileSync(targetPath, `${JSON.stringify(target)}\n`);
    return spawnSync(process.execPath, [generator, "--legacy-app", legacyApp, "--target-story", targetPath, "--out", outputPath, ...options], { encoding: "utf8" });
  };
  try {
    const current = JSON.parse(JSON.stringify(lanternStory)) as typeof lanternStory;
    expect(run(current, ["--hiyori-framing-labels", allowedLabels]).status).toBe(0);
    expect(run(current).status).not.toBe(0);

    const invalidException = run(current, ["--hiyori-framing-labels", `${allowedLabels},start`]);
    expect(invalidException.status).not.toBe(0);
    expect(invalidException.stderr).toContain("Hiyori framing exception is not allowed for 'start'");

    const changedOtherField = JSON.parse(JSON.stringify(current)) as any;
    const scene = changedOtherField.script.model_showcase_hiyori_idle_0?.find(instruction => instruction.type === "scene");
    if (!scene || scene.type !== "scene") throw new Error("Expected a Hiyori scene for strict map regression");
    const sample = scene.characters?.find((character: { id: string }) => character.id === "sample_hiyori");
    if (!sample) throw new Error("Expected the Hiyori character to test non-framing field strictness");
    sample.rotation = 1;
    const rejected = run(changedOtherField, ["--hiyori-framing-labels", allowedLabels]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("old instruction model_showcase_hiyori_idle_0");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an incorrect feature-tour dial can return to the tour menu without changing main variables", () => {
  const localized = localizeStory(lanternStory, catalogs, "en");
  const main = newGame();
  main.start();
  const before = JSON.parse(JSON.stringify(main.save()));
  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "feature_tour");
  engines.push(replay);

  progressToChoice(replay, "tour_hub");
  replay.selectChoice("tour_signal");
  progressToChoice(replay, "tour_dial");
  replay.selectChoice("tour_dial_1");
  expect(replay.getSnapshot()).toMatchObject({ active: { kind: "say", id: "tour_dial_retry" }, variables: { tour_route: 0 } });
  replay.advance();
  replay.advance();
  progressToChoice(replay, "tour_hub");
  expect(main.save()).toEqual(before);
});

test("expanded mainline meets the authored length while preserving every decision and ending ID", () => {
  const reachableLabels = new Set<string>();
  const pendingLabels = [lanternStory.start];
  while (pendingLabels.length > 0) {
    const label = pendingLabels.pop();
    if (label === undefined || reachableLabels.has(label)) continue;
    reachableLabels.add(label);
    for (const instruction of lanternStory.script[label] ?? []) {
      if (instruction.type === "jump" || instruction.type === "call") pendingLabels.push(instruction.target);
      else if (instruction.type === "branch") pendingLabels.push(instruction.then, instruction.else);
      else if (instruction.type === "trade") pendingLabels.push(instruction.onFailure);
      else if (instruction.type === "choice") {
        pendingLabels.push(...instruction.options.map(option => option.target));
        if (instruction.timeoutTarget) pendingLabels.push(instruction.timeoutTarget);
      }
    }
  }
  // The optional film and the isolated tours do not count toward the mainline
  // target, even though the film can be launched from an archive choice.
  const mainlineLabels = [...reachableLabels].filter(label => label !== "archive_reel_entry");
  const mainline = mainlineLabels.flatMap(label =>
    lanternStory.script[label]?.filter((instruction) => instruction.type === "say") ?? [],
  );
  const hanCount = mainline.reduce((total, instruction) =>
    total + (instruction.type === "say" ? (instruction.text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uF900-\uFAFF]/gu)?.length ?? 0) : 0), 0);
  const lineIds = mainline.map(instruction => instruction.id);
  expect(mainline.length).toBeGreaterThanOrEqual(200);
  expect(hanCount).toBeGreaterThanOrEqual(8_000);
  expect(mainlineLabels.length).toBeGreaterThan(45);
  expect(new Set(lineIds).size).toBe(lineIds.length);

  const choices = new Map([
    ["arrival_approach", ["listen_mira", "ask_ren", "check_seal"]],
    ["investigation_hub", ["archive", "clock", "roof", "memory", "leave_reply_address", "relay", "last_train"]],
    ["archive_read", ["copy_route", "ask_mira_archive", "leave_archive", "watch_archive_reel"]],
    ["clock_test", ["single_pulse", "double_pulse", "ask_ren_clock"]],
    ["roof_inspection", ["read_log", "ask_mira_roof", "check_lens"]],
    ["memory_response", ["trust_mira", "protect_letter", "keep_record"]],
    ["memory_repeat_response", ["affirm_mira", "return_quiet"]],
    ["relay_open", ["open_dial", "revisit_clues", "skip_relay"]],
    ["dial_one", ["route_7", "route_1", "route_4"]],
    ["dial_two", ["pulse_7", "pulse_1", "pulse_4"]],
    ["dial_three", ["minute_7", "minute_1", "minute_4"]],
    ["signal_window", ["send_truth", "send_train", "keep_light"]],
  ] as const);
  for (const [choiceId, expectedOptions] of choices) {
    const choice = Object.values(lanternStory.script).flat().find(instruction =>
      instruction.type === "choice" && instruction.id === choiceId,
    );
    expect(choice?.type === "choice" ? choice.options.map(option => option.id) : []).toEqual(expectedOptions);
  }
  expect(lanternStory.script.dial_check?.[0]).toMatchObject({ type: "branch", then: "dial_success", else: "dial_failure" });
  expect(lanternStory.script.signal_window?.find(instruction => instruction.type === "choice")).toMatchObject({ timeLimitMs: 16_000 });
  expect(lanternStory.script.ending_truth?.find(instruction => instruction.type === "ending")).toMatchObject({ id: "truth_letter" });
  expect(lanternStory.script.ending_train?.find(instruction => instruction.type === "ending")).toMatchObject({ id: "last_train" });
  expect(lanternStory.script.ending_shelter?.find(instruction => instruction.type === "ending")).toMatchObject({ id: "keep_the_light" });

  const showcaseLabels = Object.keys(lanternStory.script).filter(label => label.startsWith("model_showcase"));
  expect(showcaseLabels).toEqual([
    "model_showcase", "model_showcase_mira", "model_showcase_mira_menu", "model_showcase_mira_idle",
    "model_showcase_mira_alert", "model_showcase_mira_settle", "model_showcase_hiyori", "model_showcase_hiyori_menu",
    "model_showcase_hiyori_idle_0", "model_showcase_hiyori_idle_0_framing", "model_showcase_hiyori_idle_0_closeup",
    "model_showcase_hiyori_idle_1", "model_showcase_hiyori_idle_1_framing", "model_showcase_hiyori_idle_1_closeup",
    "model_showcase_hiyori_tap_body", "model_showcase_hiyori_tap_body_framing", "model_showcase_hiyori_tap_body_closeup",
  ]);
  const english = localizeStory(lanternStory, catalogs, "en").story;
  for (const label of mainlineLabels) {
    for (const instruction of lanternStory.script[label] ?? []) {
      if (instruction.type !== "say") continue;
      expect(english.script[label]).toContainEqual(expect.objectContaining({
        type: "say",
        id: instruction.id,
        text: catalogs.en.lines[instruction.id],
      }));
    }
  }
});

test("all scene model animations and optional Spine skins exist in the bundled model data", () => {
  const sceneIntents = Object.entries(lanternStory.script).flatMap(([label, instructions]) => instructions.flatMap((instruction, index) =>
    instruction.type === "scene"
      ? (instruction.characters ?? []).flatMap(character => character.model
        ? [{ label, index, characterId: character.id, intent: character.model }]
        : [])
      : [],
  ));
  const definitions = assets.models as Record<string, { kind: string; animations?: readonly string[]; interactive?: boolean }>;
  const spineSkins = new Set(miraSpine.skins.map(skin => skin.name));
  expect(sceneIntents.length).toBeGreaterThan(0);
  expect(definitions.hiyori_sample?.interactive).toBe(true);
  expect(definitions.mira_spine?.interactive).toBeUndefined();

  for (const { intent } of sceneIntents) {
    const definition = definitions[intent.key];
    expect(definition).toBeDefined();
    if (!definition) continue;
    if (intent.animation !== undefined) expect(definition.animations ?? []).toContain(intent.animation);
    if (intent.skin !== undefined) {
      expect(definition.kind).toBe("spine");
      expect(spineSkins).toContain(intent.skin);
    }
  }
});


test("the authored supply shop buys, refunds and consumes inventory while replay leaves the main save intact", () => {
  const main = newGame();
  main.start();
  const before = main.save();
  const replay = createNovelReplayEngine(lanternStory, main.getSnapshot(), "inventory_showcase");
  engines.push(replay);
  progressToChoice(replay, "platform_stall_menu");
  replay.selectChoice("buy_sleeve");
  expect(replay.getSnapshot().variables).toMatchObject({ travel_tokens: 8, weather_sleeves: 1, spare_wicks: 0 });
  progressToChoice(replay, "platform_stall_menu");
  replay.selectChoice("sell_sleeve");
  expect(replay.getSnapshot().variables).toMatchObject({ travel_tokens: 10, weather_sleeves: 0 });
  progressToChoice(replay, "platform_stall_menu");
  replay.selectChoice("buy_wick");
  expect(replay.getSnapshot().variables).toMatchObject({ travel_tokens: 3, spare_wicks: 1 });
  progressToChoice(replay, "platform_stall_menu");
  replay.selectChoice("use_wick");
  expect(replay.getSnapshot().variables).toMatchObject({ travel_tokens: 3, spare_wicks: 0 });
  progressToChoice(replay, "platform_stall_menu");
  const beforeRefusal = replay.getSnapshot().variables;
  replay.selectChoice("buy_sleeve");
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "stall_buy_refused_01" });
  expect(replay.getSnapshot().variables).toEqual(beforeRefusal);
  progressToChoice(replay, "platform_stall_menu");
  replay.selectChoice("leave_stall");
  settleUntilChoiceOrEnding(replay);
  expect(replay.getSnapshot().active).toMatchObject({ kind: "ending", id: "inventory_showcase_done" });
  expect(main.save()).toEqual(before);
});

test("the four-direction scene theater keeps the parked journey and its save unchanged", () => {
  const main = newGame();
  main.start();
  choose(main, "ask_ren");
  const parked = JSON.parse(JSON.stringify(main.save()));
  const localized = localizeStory(lanternStory, catalogs, "en");
  expect(localized.story.replayEntries?.find(entry => entry.id === "transition_showcase")?.title).toBe("Through the Fog");
  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "transition_showcase");
  engines.push(replay);
  for (const [index, direction] of ["left", "right", "up", "down"].entries()) {
    expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: `reveal_0${index + 1}` });
    expect(replay.getSnapshot().stage.transition).toMatchObject({ kind: "reveal", direction, durationMs: 1200 });
    replay.tick(600);
    const middle = replay.save();
    expect(middle.state.stage.transition?.elapsedMs).toBe(600);
    replay.pause();
    replay.tick(500);
    expect(replay.getSnapshot().stage.transition?.elapsedMs).toBe(600);
    replay.resume();
    replay.tick(600);
    expect(replay.getSnapshot().stage.transition).toBeNull();
    expect(main.save()).toEqual(parked);
    if (index < 3) {
      replay.advance();
      if (replay.getSnapshot().active?.id === `reveal_0${index + 1}`) replay.advance();
    }
  }
  expect(main.save()).toEqual(parked);
});

test("the lighthouse ensemble reuses one synchronized preset and leaves the parked main save intact", () => {
  const main = newGame(); main.start(); choose(main, "ask_ren");
  const parked = JSON.parse(JSON.stringify(main.save()));
  const localized = localizeStory(lanternStory, catalogs, "en");
  expect(localized.story.replayEntries?.find(entry => entry.id === "timeline_showcase")?.title).toBe("Lighthouse Ensemble");
  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "timeline_showcase");
  const loaded = createNovelEngine(localized.story);
  engines.push(replay, loaded);
  const cues: string[] = [];
  replay.subscribe(update => { for (const event of update.events) if (event.type === "audioCue") cues.push(event.cue); });
  replay.setPreferences({ textSpeedCharsPerSecond: 0 });
  replay.advance();
  expect(replay.getSnapshot().stage.timeline).toEqual({ id: "beacon_sweep", elapsedMs: 0 });
  expect(cues).toEqual(["roof_gust"]);
  replay.tick(1800);
  expect(replay.getSnapshot().stage.camera).toMatchObject({ x: -12, y: -4, scale: 1.12, motion: null });
  expect(replay.getSnapshot().stage.characters.mira).toMatchObject({ position: { x: 4, y: 108 }, scale: 1.04, rotation: -2 });
  expect(cues).toEqual(["roof_gust", "station_bell"]);
  replay.pause(); replay.tick(800);
  expect(replay.getSnapshot().stage.timeline?.elapsedMs).toBe(1800);
  loaded.load(JSON.parse(JSON.stringify(replay.save())));
  const recovered: string[] = [];
  loaded.subscribe(update => { for (const event of update.events) if (event.type === "audioCue") recovered.push(event.cue); });
  loaded.resume(); loaded.tick(2400);
  expect(recovered).toEqual(["relay_click"]);
  loaded.tick(1800);
  expect(loaded.getSnapshot().stage.timeline).toBeFalsy();
  expect(loaded.getSnapshot().stage.characters.mira.position).toEqual({ x: -24, y: 116 });
  replay.resume(); replay.tick(4200); replay.advance();
  expect(replay.getSnapshot().stage.background).toBe("roof");
  expect(replay.getSnapshot().stage.timeline).toEqual({ id: "beacon_sweep", elapsedMs: 0 });
  expect(cues).toEqual(["roof_gust", "station_bell", "relay_click", "roof_gust"]);
  replay.tick(6000); replay.advance();
  expect(replay.getSnapshot().stage.timeline).toBeFalsy();
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "timeline_04" });
  expect(main.save()).toEqual(parked);
});

test("the ensemble's second movement fades the wind through saved channel gains and stops on early advance", () => {
  const main = newGame(); main.start();
  const parked = JSON.parse(JSON.stringify(main.save()));
  const replay = createNovelReplayEngine(lanternStory, main.getSnapshot(), "timeline_showcase");
  const loaded = createNovelEngine(lanternStory);
  engines.push(replay, loaded);
  replay.setPreferences({ textSpeedCharsPerSecond: 0 });
  for (let index = 0; index < 5; index++) replay.advance();
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "timeline_06" });
  expect(replay.getSnapshot().audioIntents["harbor-wind"]).toEqual({ action: "play", cue: "roof_gust", loop: true, gain: 0 });
  replay.tick(1500);
  expect(replay.getSnapshot().audioIntents["harbor-wind"].gain).toBeCloseTo(0.85, 8);
  replay.pause(); replay.tick(6000);
  loaded.load(JSON.parse(JSON.stringify(replay.save())));
  expect(loaded.getSnapshot().audioIntents["harbor-wind"].gain).toBeCloseTo(0.85, 8);
  loaded.resume(); loaded.tick(2300);
  expect(loaded.getSnapshot().audioIntents["harbor-wind"].gain).toBeCloseTo(0.4, 8);
  loaded.tick(2200);
  expect(loaded.getSnapshot().stage.timeline).toBeUndefined();
  expect(loaded.getSnapshot().audioIntents["harbor-wind"]).toMatchObject({ action: "stop", cue: "roof_gust" });
  replay.resume(); replay.advance();
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "timeline_07" });
  expect(replay.getSnapshot().stage.timeline).toBeUndefined();
  expect(replay.getSnapshot().audioIntents["harbor-wind"]).toMatchObject({ action: "stop", cue: "roof_gust" });
  expect(main.save()).toEqual(parked);
});

test("the score handoff routes both real scores to music, crossfades them on the shared timeline, and releases without changing the main save", () => {
  const main = newGame();
  main.setPreferences({ textSpeedCharsPerSecond: 0 });
  main.start();
  const parked = JSON.parse(JSON.stringify(main.save()));
  const localized = localizeStory(lanternStory, catalogs, "en", { assetRegistry: assets });
  expect(localized.story.replayEntries?.find(entry => entry.id === "score_handoff_showcase")?.title).toBe("When Dawn Takes the Score");
  const replay = createNovelReplayEngine(localized.story, main.getSnapshot(), "score_handoff_showcase");
  engines.push(replay);

  progressToLine(replay, "score_handoff_02");
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "score_handoff_02", speaker: "Mira" });
  const events: Array<{ action: string; channel: string | null; cue: string; group?: string }> = [];
  replay.subscribe(update => {
    for (const event of update.events) {
      if (event.type === "audioCue") events.push({ action: event.action, channel: event.channel, cue: event.cue, ...(event.group ? { group: event.group } : {}) });
    }
  });
  replay.advance();

  expect(replay.getSnapshot().active).toMatchObject({ kind: "wait", durationMs: 14000, remainingMs: 14000 });
  expect(replay.getSnapshot().stage.timeline).toEqual({ id: "score_handoff", elapsedMs: 0 });
  expect(replay.getSnapshot().audioIntents["score-storm"]).toMatchObject({
    action: "play", cue: "music_storm", loop: true, group: "music",
  });
  expect(replay.getSnapshot().audioIntents["score-storm"].gain ?? 1).toBe(1);
  expect(replay.getSnapshot().audioIntents["score-dawn"]).toBeUndefined();
  expect(main.save()).toEqual(parked);

  replay.tick(4800);
  expect(replay.getSnapshot().audioIntents["score-storm"].gain ?? 1).toBe(1);
  expect(replay.getSnapshot().audioIntents["score-dawn"]).toMatchObject({
    action: "play", cue: "music_dawn", loop: true, group: "music", gain: 0,
  });
  replay.tick(2800);
  const overlap = replay.getSnapshot().audioIntents;
  expect(overlap["score-storm"].group).toBe("music");
  expect(overlap["score-dawn"].group).toBe("music");
  expect(overlap["score-storm"].gain).toBeCloseTo(0.5, 8);
  expect(overlap["score-dawn"].gain).toBeCloseTo(0.5, 8);
  expect(events).toContainEqual({ action: "play", channel: null, cue: "station_bell" });

  replay.tick(2800);
  expect(replay.getSnapshot().stage.background).toBe("dawn");
  expect(replay.getSnapshot().stage.transition).toBeNull();
  expect(replay.getSnapshot().audioIntents["score-storm"]).toMatchObject({ action: "stop", cue: "music_storm" });
  expect(replay.getSnapshot().audioIntents["score-storm"]).not.toHaveProperty("group");
  expect(replay.getSnapshot().audioIntents["score-dawn"].gain ?? 1).toBe(1);
  replay.tick(1800);
  expect(replay.getSnapshot().audioIntents["score-dawn"].gain ?? 1).toBe(1);
  replay.tick(1800);
  expect(replay.getSnapshot().active).toMatchObject({ kind: "say", id: "score_handoff_03" });
  expect(replay.getSnapshot().audioIntents["score-dawn"]).toMatchObject({ action: "stop", cue: "music_dawn" });
  expect(replay.getSnapshot().audioIntents["score-dawn"]).not.toHaveProperty("group");
  expect(events).toContainEqual({ action: "stop", channel: "score-storm", cue: "music_storm" });
  expect(events).toContainEqual({ action: "stop", channel: "score-dawn", cue: "music_dawn" });
  expect(main.save()).toEqual(parked);
});
