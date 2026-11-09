import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  NativeSession,
  readNativeArtifacts,
  textOf,
  textOps,
  type Frame,
  type NativeArtifacts,
} from "./native_session.ts";

const width = 360;
const height = 640;
const storyId = "demo.lantern.misty-last-letter";
const autosaveKey = "lantern.slot.auto";
const artifactDirectory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(artifactDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(artifactDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(artifactDirectory, "app.bytecode.json");

const artifacts: NativeArtifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "Lantern QJBC must be built before keyboard acceptance");
assert.ok(existsSync(artifacts.pakPath), "Lantern PAK must be built before keyboard acceptance");
const storyDocument = JSON.parse(readFileSync(resolve(artifactDirectory, "../../../js/apps/lantern/story.json"), "utf8")) as { id?: string };
assert.equal(storyDocument.id, storyId, "keyboard acceptance must load the compiled Lantern story");

type SaveState = Record<string, any>;
type NovelSave = { storyId?: string; state?: SaveState };

// The masks are the official PocketJS BTN.CIRCLE and BTN.CROSS values. In the
// host app, Space/Enter map to CIRCLE and Escape maps to CROSS.
const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;
const BTN_DOWN = 0x0040;

function save(session: NativeSession): NovelSave {
  const value = session.storage[autosaveKey] as NovelSave | undefined;
  assert.ok(value && value.storyId === storyId, "native guest must persist the active Lantern state");
  return value!;
}

function active(session: NativeSession): Record<string, any> | null {
  return (save(session).state?.active as Record<string, any> | null) ?? null;
}

function normalize(value: string): string { return value.replace(/[\s\u200b\ufeff]/g, ""); }

async function pulse(session: NativeSession, buttons: number): Promise<Frame> {
  session.sendEvent("input.buttons", { buttons });
  let frame = await session.frame();
  session.sendEvent("input.buttons", { buttons: 0 });
  frame = await session.frame();
  return frame;
}

async function waitForActive(
  session: NativeSession,
  initial: Frame,
  predicate: (value: Record<string, any> | null) => boolean,
  description: string,
  maxFrames = 900,
): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    if (predicate(active(session))) return frame;
    frame = await session.frame();
  }
  throw new Error(`native keyboard guest did not reach ${description}; active=${JSON.stringify(active(session))}; text=${textOf(frame)}`);
}

async function advanceToChoice(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  for (let index = 0; index < 1_200; index += 1) {
    const current = active(session);
    if (current?.kind === "choice") return frame;
    if (current?.kind === "say") {
      // A CIRCLE press reveals an incomplete line; the next press advances it.
      frame = await pulse(session, BTN_CIRCLE);
    } else {
      frame = await session.frame();
    }
  }
  throw new Error(`native keyboard guest did not reach a choice; active=${JSON.stringify(active(session))}`);
}

async function run(): Promise<void> {
  const session = new NativeSession(artifacts, { width, height, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    assert.equal(frame.width, width);
    assert.equal(frame.height, height);
    assert.ok(textOps(frame, "启程 · 开始新的故事").length > 0, "title action must be painted by QJBC guest");

    frame = await pulse(session, BTN_CROSS);
    assert.ok(textOps(frame, "启程 · 开始新的故事").length > 0, "Escape on title must not bypass the title interaction");
    assert.equal(session.storage[autosaveKey], undefined, "Escape on title must not start the story");

    frame = await pulse(session, BTN_CIRCLE);
    frame = await waitForActive(session, frame, value => value?.kind === "say" && value.id === "arrival_01", "first keyboard-started line");
    assert.ok(textOps(frame, "雾港末班信").length > 0, "the native guest must paint the running story title");

    const firstLine = active(session)!;
    frame = await pulse(session, BTN_CIRCLE);
    assert.equal(active(session)?.id, firstLine.id, "confirm on an incomplete line reveals it without skipping it");
    assert.ok(normalize(textOf(frame)).includes(normalize(String(firstLine.text))), "confirm must paint the complete line before advancing");

    frame = await pulse(session, BTN_CIRCLE);
    frame = await waitForActive(session, frame, value => value?.kind === "say" && value.id !== firstLine.id, "next line after confirm");

    const secondLine = active(session)!;
    frame = await pulse(session, BTN_CROSS);
    assert.ok(textOps(frame, "旅途手札").length > 0, "Escape during the story opens the journal");
    assert.equal(active(session)?.id, secondLine.id, "opening the journal must leave the current story interaction in place");
    frame = await pulse(session, BTN_CROSS);
    assert.equal(textOps(frame, "旅途手札").length, 0, "Escape from the journal returns to the story");
    assert.equal(active(session)?.id, secondLine.id, "returning from the journal must resume the same line");

    frame = await advanceToChoice(session, frame);
    frame = await session.frame();
    assert.equal(active(session)?.id, "arrival_approach", "keyboard confirm must retain the authored choice boundary");

    // Escape is a separate BTN from focus confirmation. It opens and closes
    // the journal without selecting or bypassing the current choice.
    frame = await pulse(session, BTN_CROSS);
    assert.ok(textOps(frame, "旅途手札").length > 0, "Escape at a choice opens the journal");
    assert.equal(active(session)?.id, "arrival_approach", "Escape must not select a choice");
    frame = await pulse(session, BTN_CROSS);
    assert.equal(active(session)?.id, "arrival_approach", "returning from the journal must preserve the active choice");

    // The first option receives programmatic focus; d-pad plus the same CIRCLE
    // confirm selects the second authored option through Focusable.
    frame = await pulse(session, BTN_DOWN);
    frame = await pulse(session, BTN_CIRCLE);
    frame = await waitForActive(session, frame, value => value?.kind === "say" && value.id === "arrival_ren_01", "second focused choice");
    assert.equal(active(session)?.kind, "say", "confirm selects the focused choice instead of advancing through it");

    console.log(`novel_keyboard_native: QJBC focus confirmation, d-pad choice selection and Escape journal navigation passed (abi=${artifacts.runtimeAbi})`);
    await session.quit();
  } finally {
    session.forceKill();
  }
}

test("native Lantern QJBC handles keyboard button input without skipping VN choices", run, 180_000);
