import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createNovelEngine } from "../../../sdk/packages/pocket_vn/src/engine.ts";
import type { StoryDefinition } from "../../../sdk/packages/pocket_vn/src/types.ts";
import storyDocument from "../apps/lantern/story.json";
import { NativeSession, readNativeArtifacts, textOf, type DrawOp } from "./native_session.ts";

const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
process.env.POCKET_STARTUP_VN_GUEST_BYTECODE ??= `${directory}/app.qjbc`;
process.env.POCKET_STARTUP_VN_GUEST_PAK ??= `${directory}/app.pak`;
process.env.POCKET_STARTUP_VN_GUEST_METADATA ??= `${directory}/app.bytecode.json`;
const artifacts = readNativeArtifacts("POCKET_STARTUP_VN");
const criticalKeys = ["lantern.audio.mix", "lantern.audio.textSoundsEnabled", "lantern.locale", "lantern.slot.auto"];
const startupImageOps = (frame: { readonly ops?: readonly DrawOp[] }): DrawOp[] =>
  (frame.ops ?? []).filter(op => op.type === "image" || op.type === "textureTriangle");

test("Lantern shows real startup completion, overlaps independent reads and enters while thumbnail cleanup waits", async () => {
  const session = new NativeSession(artifacts, {
    width: 390, height: 844, deadlineMs: 90_000,
    deferCapabilities: ["platform.storage.get", "platform.storage.keys", "platform.images.list"],
  });
  try {
    let frame = await session.boot();
    const requested = session.requests.filter(request => request.capability === "platform.storage.get").map(request => request.params.key);
    expect([...requested].sort()).toEqual([...criticalKeys].sort());
    expect(textOf(frame)).toContain("0 / 4");
    expect(textOf(frame)).toContain("正在读取语言偏好");
    expect(startupImageOps(frame)).toHaveLength(0);
    for (const op of frame.ops ?? []) {
      if (op.type !== "text") continue;
      expect(op.x! >= 0 && op.x! + op.w! <= 390 && op.y! >= 0 && op.y! + op.h! <= 844).toBe(true);
    }
    frame = await session.settle(frame, 30);
    expect(textOf(frame)).toContain("0 / 4");
    expect(session.requests.some(request => request.capability === "platform.storage.keys")).toBe(false);
    session.sendEvent("display.viewport", { width: 390, height: 844, safeArea: { top: 59, bottom: 34, left: 0, right: 0 }, keyboardInset: 0, reservedRegions: [] });
    // Reply in a different order from request issuance. Locale restoration
    // must not race the raw autosave read, and failures count as settled work.
    session.respondPending("platform.storage.get", null, true, request => request.params.key === "lantern.slot.auto");
    frame = await session.settle(await session.frame(), 2);
    expect(textOf(frame)).toContain("1 / 4");
    expect(startupImageOps(frame)).toHaveLength(0);
    session.respondPending("platform.storage.get", null, false, request => request.params.key === "lantern.audio.mix");
    frame = await session.settle(await session.frame(), 2);
    expect(textOf(frame)).toContain("2 / 4");
    session.respondPending("platform.storage.get", false, true, request => request.params.key === "lantern.audio.textSoundsEnabled");
    frame = await session.settle(await session.frame(), 2);
    expect(textOf(frame)).toContain("3 / 4");
    session.respondPending("platform.storage.get", "en", true, request => request.params.key === "lantern.locale");
    frame = await session.settle(await session.frame(), 8);
    expect(textOf(frame)).toContain("Begin · Start a new story");
    expect(session.requests.some(request => request.capability === "platform.storage.keys")).toBe(true);
    // Leave thumbnail scan unanswered: it must not prevent the title action.
    frame = await session.tap("Begin · Start a new story", frame);
    frame = await session.settle(frame, 8);
    expect(textOf(frame)).toContain("Journal");
    expect(textOf(frame)).not.toContain("3 / 4");
  } finally { await session.quit(); }
}, 120_000);

test("Lantern startup reads time out together and still permits a new journey", async () => {
  const session = new NativeSession(artifacts, {
    width: 390, height: 844, deadlineMs: 90_000,
    deferCapabilities: ["platform.storage.get", "platform.storage.keys", "platform.images.list"],
  });
  try {
    let frame = await session.boot();
    expect(textOf(frame)).toContain("0 / 4");
    // The real bridge timeout is ten guest-clock seconds. One timeout window
    // must settle all parallel reads, rather than four serial windows.
    frame = await session.settle(frame, 630);
    expect(textOf(frame)).toContain("启程 · 开始新的故事");
    frame = await session.tap("启程 · 开始新的故事", frame);
    expect(textOf(frame)).toContain("手札");
  } finally { await session.quit(); }
}, 120_000);


test("parallel startup applies saved locale before validating autosave metadata", async () => {
  const source = createNovelEngine(storyDocument as StoryDefinition, { initialMeta: { readLineIds: [], endingIds: [], cgIds: ["truth_letter"] } });
  source.start();
  const saved = source.save();
  source.dispose();
  const session = new NativeSession(artifacts, { width: 390, height: 844, deferCapabilities: ["platform.storage.get", "platform.storage.keys"], deadlineMs: 90_000 });
  try {
    let frame = await session.boot();
    for (const [key, value] of [["lantern.locale", "en"], ["lantern.audio.mix", null], ["lantern.audio.textSoundsEnabled", false], ["lantern.slot.auto", saved]] as const) {
      session.respondPending("platform.storage.get", value, true, request => request.params.key === key);
      frame = await session.frame();
    }
    frame = await session.settle(frame, 8);
    const clip = frame.ops?.find(op => op.text === "Begin · Start a new story")?.clip;
    expect(clip).toBeDefined();
    for (let attempt = 0; attempt < 10 && !textOf(frame).includes("Harbor memories"); attempt++) {
      const x = clip!.x! + clip!.w! / 2;
      frame = await session.drag({ x, y: clip!.y! + clip!.h! * .82 }, { x, y: clip!.y! + clip!.h! * .22 }, 8, 2);
      frame = await session.settle(frame, 4);
    }
    expect(textOf(frame)).toContain("Harbor memories");
    frame = await session.tap("Harbor memories", frame);
    frame = await session.settle(frame, 4);
    expect(textOf(frame)).toContain("Collected 1 / 3 memories");
    expect(textOf(frame)).toContain("A reply across twenty years");
  } finally { await session.quit(); }
}, 120_000);
