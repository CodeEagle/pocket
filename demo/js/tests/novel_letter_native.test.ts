import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { NativeSession, center, readNativeArtifacts, textOf, type DrawOp, type Frame } from "./native_session.ts";

const guestDirectory = resolve(import.meta.dir, "../../assets/apps/lantern");
const sourceDirectory = resolve(import.meta.dir, "../apps/lantern");
const sourceStory = JSON.parse(readFileSync(resolve(sourceDirectory, "story.json"), "utf8")) as {
  script: Record<string, LetterInstruction[]>;
  replayEntries: Array<{ id: string; title: string }>;
};
const localeDocument = JSON.parse(readFileSync(resolve(sourceDirectory, "novel.locales.json"), "utf8")) as {
  catalogs: Record<string, LetterLocaleCatalog>;
};
const parkedSave = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/lantern-v3-native-save.json"), "utf8")) as {
  storage: Record<string, unknown>;
};

process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(guestDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(guestDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(guestDirectory, "app.bytecode.json");
const artifacts = readNativeArtifacts("POCKET_LANTERN");
assert.ok(existsSync(artifacts.bytecodePath), "the staged Lantern QuickJS Guest is required for letter acceptance");
assert.ok(existsSync(artifacts.pakPath), "the staged Lantern PAK is required for letter acceptance");

type LetterInstruction = { type?: string; id?: string; text?: string; presentation?: string; speaker?: string };
type LetterLocaleCatalog = {
  lines?: Record<string, string>;
  replays?: Record<string, string>;
  ui?: Record<string, string>;
};
type Rect = { x: number; y: number; w: number; h: number };

const letterScript = sourceStory.script.letter_showcase ?? [];
const longLetter = letterScript.find(item => item.type === "say" && item.id === "letter_showcase_01");
const floatingLine = letterScript.find(item => item.type === "say" && item.id === "letter_showcase_02");
const dialogueLine = letterScript.find(item => item.type === "say" && item.id === "letter_showcase_03");
const letterReplay = sourceStory.replayEntries.find(item => item.id === "letter_showcase");
assert.ok(longLetter?.text && longLetter.presentation === "fullscreen", "the first letter passage is an authored fullscreen say");
assert.equal(floatingLine?.presentation, "floating", "the second passage is authored as floating text");
assert.ok(dialogueLine && !dialogueLine.presentation && dialogueLine.speaker === "Mira", "the last passage is ordinary Mira dialogue");
assert.ok(letterReplay, "the letter has a declared title-screen replay entry");

function compact(value: string): string {
  return value.replace(/\s/g, "");
}

function textAsset(op: DrawOp): string | undefined {
  return (op as DrawOp & { asset?: string }).asset;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

function opRect(op: DrawOp): Rect | null {
  if ([op.x, op.y, op.w, op.h].some(value => typeof value !== "number")) return null;
  return { x: op.x!, y: op.y!, w: op.w!, h: op.h! };
}

function visibleRect(op: DrawOp, frame: Frame): Rect | null {
  const rect = opRect(op);
  if (!rect) return null;
  const viewport = { x: 0, y: 0, w: frame.width ?? 0, h: frame.height ?? 0 };
  const clipped = op.clip
    ? intersect(rect, { x: op.clip.x ?? 0, y: op.clip.y ?? 0, w: op.clip.w ?? viewport.w, h: op.clip.h ?? viewport.h })
    : rect;
  return clipped ? intersect(clipped, viewport) : null;
}

function visibleTextOp(frame: Frame, label: string): DrawOp | undefined {
  const wanted = compact(label);
  return (frame.ops ?? []).find(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(wanted)) return false;
    const visible = visibleRect(op, frame);
    if (!visible) return false;
    const rect = opRect(op)!;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    if (cx < visible.x || cx > visible.x + visible.w || cy < visible.y || cy > visible.y + visible.h) return false;
    return typeof op.color !== "number" || ((op.color >>> 24) & 0xff) > 0;
  });
}

function visibleLineFact(
  frame: Frame,
  fragment: string,
): { op: DrawOp; line: string; lineRect: Rect; visibleRect: Rect } | undefined {
  const wanted = compact(fragment);
  if (!wanted) return undefined;
  for (const op of frame.ops ?? []) {
    if (op.type !== "text" || typeof op.text !== "string") continue;
    const rect = opRect(op);
    if (!rect || rect.h <= 0) continue;
    const lines = op.text.split(/\r?\n/);
    const compactLines = lines.map(compact);
    const startOffset = compactLines.join("").indexOf(wanted);
    if (startOffset < 0) continue;
    const endOffset = startOffset + wanted.length - 1;
    const lineForOffset = (offset: number): number => {
      let lineStart = 0;
      for (let index = 0; index < compactLines.length; index += 1) {
        const lineEnd = lineStart + compactLines[index]!.length;
        if (offset < lineEnd) return index;
        lineStart = lineEnd;
      }
      return -1;
    };
    const lineIndex = lineForOffset(endOffset);
    if (lineIndex < 0 || lineIndex >= lines.length) continue;
    const lineHeight = rect.h / Math.max(1, lines.length);
    const lineRect = {
      x: rect.x,
      y: rect.y + lineIndex * lineHeight,
      w: rect.w,
      h: lineHeight,
    };
    const viewport = { x: 0, y: 0, w: frame.width ?? 0, h: frame.height ?? 0 };
    const clip = op.clip
      ? { x: op.clip.x ?? 0, y: op.clip.y ?? 0, w: op.clip.w ?? viewport.w, h: op.clip.h ?? viewport.h }
      : viewport;
    const clippedLine = intersect(lineRect, clip);
    if (!clippedLine) continue;
    const visible = intersect(clippedLine, viewport);
    if (!visible || visible.h < lineHeight * 0.75) continue;
    const centerX = lineRect.x + lineRect.w / 2;
    const centerY = lineRect.y + lineRect.h / 2;
    if (centerX < visible.x || centerX > visible.x + visible.w || centerY < visible.y || centerY > visible.y + visible.h) continue;
    if (typeof op.color === "number" && ((op.color >>> 24) & 0xff) === 0) continue;
    return { op, line: lines[lineIndex]!, lineRect, visibleRect: visible };
  }
  return undefined;
}

function anyVisibleTextOp(frame: Frame, labels: readonly string[]): { label: string; op: DrawOp } | undefined {
  for (const label of labels) {
    const op = visibleTextOp(frame, label);
    if (op) return { label, op };
  }
  return undefined;
}

function visibleText(frame: Frame, label: string): boolean {
  return visibleTextOp(frame, label) !== undefined;
}

function letterBodyOp(frame: Frame, fragment: string): DrawOp | undefined {
  const wanted = compact(fragment);
  return (frame.ops ?? []).find(op => op.type === "text" && compact(op.text ?? "").includes(wanted));
}

function assertImageBackedSkin(frame: Frame, where: string): void {
  const skin = (frame.ops ?? []).filter(op => op.type === "textureTriangle" && textAsset(op) === "art/ui/harbor-frame-refined.png");
  assert.ok(skin.length > 0, `${where} must paint the actual image-backed game skin mesh; frame=${textOf(frame)}`);
}

function lineText(locale: "zh" | "en", id: string): string {
  if (locale === "en") {
    const localized = localeDocument.catalogs.en?.lines?.[id];
    assert.ok(localized, `the English catalog supplies ${id}`);
    return localized!;
  }
  const line = letterScript.find(item => item.id === id);
  assert.ok(line?.text, `the Chinese source story supplies ${id}`);
  return line!.text!;
}

function localeUi(locale: "zh" | "en"): { titleStart: string; reveal: string; continue: string; exit: string; replayTitle: string } {
  if (locale === "en") {
    const catalog = localeDocument.catalogs.en!;
    return {
      titleStart: catalog.ui?.["title.start"] ?? "Begin · Start a new story",
      reveal: catalog.ui?.["player.reveal"] ?? "Tap to reveal all",
      continue: catalog.ui?.["player.continue"] ?? "Tap to continue  ›",
      exit: catalog.ui?.["replay.exit"] ?? "Return to journey",
      replayTitle: catalog.replays?.letter_showcase ?? "An Unsent Letter",
    };
  }
  return {
    titleStart: "启程 · 开始新的故事",
    reveal: "轻触显全",
    continue: "轻触继续  ›",
    exit: "返回原旅程",
    replayTitle: letterReplay!.title,
  };
}

function textOpsInClip(frame: Frame, clip: Rect): Array<{ text: string; y: number; h: number }> {
  return (frame.ops ?? [])
    .filter(op => op.type === "text" && op.clip &&
      (op.clip.x ?? 0) === clip.x && (op.clip.y ?? 0) === clip.y &&
      (op.clip.w ?? frame.width) === clip.w && (op.clip.h ?? frame.height) === clip.h &&
      typeof op.y === "number")
    .map(op => ({ text: op.text ?? "", y: op.y!, h: op.h ?? 0 }));
}

async function scrollTitleToReplay(session: NativeSession, initial: Frame, ui: ReturnType<typeof localeUi>): Promise<Frame> {
  let frame = initial;
  const start = visibleTextOp(frame, ui.titleStart);
  assert.ok(start?.clip, `title action must be inside its real scroll clip: ${textOf(frame)}`);
  const clip = start!.clip!;
  const clipRect = { x: clip.x ?? 0, y: clip.y ?? 0, w: clip.w ?? session.width, h: clip.h ?? session.height };
  let moved = false;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const replay = visibleTextOp(frame, ui.replayTitle);
    if (replay) {
      assert.ok(moved || visibleTextOp(initial, ui.replayTitle), "the title entry is either initially visible or reached by real scrolling");
      return frame;
    }
    const before = JSON.stringify(textOpsInClip(frame, clipRect));
    frame = await session.drag(
      { x: clipRect.x + clipRect.w * 0.52, y: clipRect.y + clipRect.h * 0.82 },
      { x: clipRect.x + clipRect.w * 0.52, y: clipRect.y + clipRect.h * 0.24 },
      8,
      2,
    );
    frame = await session.settle(frame, 2);
    const after = JSON.stringify(textOpsInClip(frame, clipRect));
    moved ||= before !== after;
  }
  throw new Error(`title replay never became visibly hittable after real scroll; moved=${moved}; frame=${textOf(frame)}`);
}

async function waitVisible(session: NativeSession, initial: Frame, labels: readonly string[], attempts = 240): Promise<{ frame: Frame; label: string; op: DrawOp }> {
  let frame = initial;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = anyVisibleTextOp(frame, labels);
    if (found) return { frame, ...found };
    frame = await session.frame();
  }
  throw new Error(`none of the requested controls became visibly hittable (${labels.join(" | ")}); frame=${textOf(frame)}`);
}

async function waitBody(session: NativeSession, initial: Frame, fragment: string, attempts = 240): Promise<{ frame: Frame; op: DrawOp }> {
  let frame = initial;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const op = letterBodyOp(frame, fragment);
    if (op && visibleRect(op, frame)) return { frame, op };
    frame = await session.frame();
  }
  throw new Error(`letter passage did not become visible (${fragment}); frame=${textOf(frame)}`);
}

async function revealCurrentLine(
  session: NativeSession,
  initial: Frame,
  ui: ReturnType<typeof localeUi>,
  fragment: string,
  expectedText: string,
): Promise<Frame> {
  let frame = initial;
  const first = await waitBody(session, frame, fragment);
  frame = first.frame;
  assertImageBackedSkin(frame, `letter passage ${fragment}`);
  let action = await waitVisible(session, frame, [ui.continue, ui.reveal], 600);
  frame = action.frame;
  if (compact(action.label) === compact(ui.reveal)) {
    frame = await session.tapPoint(center(action.op, `visible reveal action ${ui.reveal}`));
    action = await waitVisible(session, frame, [ui.continue], 240);
    frame = action.frame;
  }
  const fullBody = letterBodyOp(frame, fragment);
  assert.ok(fullBody, `the actual line text remains painted after reveal: ${fragment}`);
  assert.ok(compact(fullBody!.text ?? "").includes(compact(expectedText)), `the complete localized line is painted after explicit reveal: ${fragment}`);
  assertImageBackedSkin(frame, `revealed passage ${fragment}`);
  return frame;
}

async function scrollLongPassageToBottom(
  session: NativeSession,
  initial: Frame,
  fragment: string,
  fullText: string,
  requireOverflow: boolean,
): Promise<{ frame: Frame; dragCount: number; startY: number; finalY: number; clipHeight: number; textHeight: number }> {
  let frame = initial;
  let body = letterBodyOp(frame, fragment);
  assert.ok(body?.clip, `the fullscreen letter body exposes its real clipped scroll viewport: ${textOf(frame)}`);
  assert.ok(typeof body!.y === "number" && typeof body!.h === "number", "the long passage exposes actual native text geometry");
  assert.ok(compact(body!.text ?? "").includes(compact(fullText)), "the complete long passage stays in the active rendered Text operation");
  const rawClip = body!.clip!;
  const clip = { x: rawClip.x ?? 0, y: rawClip.y ?? 0, w: rawClip.w ?? session.width, h: rawClip.h ?? session.height };
  const startY = body!.y!;
  const textHeight = body!.h!;
  const overflows = textHeight > clip.h + 2;
  if (requireOverflow) assert.ok(overflows, `phone viewport must exercise long-letter scrolling: text=${textHeight}, clip=${clip.h}`);
  let dragCount = 0;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    body = letterBodyOp(frame, fragment);
    assert.ok(body, "the active letter text remains painted while its scroll viewport moves");
    assert.ok(typeof body!.y === "number" && typeof body!.h === "number", "the active letter retains native scroll geometry");
    const bottom = body!.y! + body!.h!;
    if (bottom <= clip.y + clip.h + 3) break;
    const beforeY = body!.y!;
    frame = await session.drag(
      { x: clip.x + clip.w * 0.5, y: clip.y + clip.h * 0.82 },
      { x: clip.x + clip.w * 0.5, y: clip.y + clip.h * 0.24 },
      8,
      2,
    );
    frame = await session.settle(frame, 2);
    const after = letterBodyOp(frame, fragment);
    assert.ok(after, "long-letter body remains in the Guest's draw operations after drag");
    assert.ok(after!.y! < beforeY, `dragging the real text clip upward must scroll the letter; before=${beforeY}, after=${after!.y}`);
    dragCount += 1;
  }
  body = letterBodyOp(frame, fragment);
  assert.ok(body && body!.y! + body!.h! <= clip.y + clip.h + 3,
    `the final paragraph must reach the visible bottom of the clipped page, not merely exist off-clip: body=${JSON.stringify(body)}, clip=${JSON.stringify(clip)}`);
  if (overflows) assert.ok(dragCount > 0, "long passage overflow is cleared only by real pointer scrolls");
  const tail = compact(fullText.slice(-48));
  assert.ok(compact(body!.text ?? "").includes(tail), "the final letter paragraph remains the text currently painted at the scroll end");
  return { frame, dragCount, startY, finalY: body!.y!, clipHeight: clip.h, textHeight };
}

function assertSameAuto(session: NativeSession, before: string, writesBefore: number, stage: string): void {
  assert.equal(JSON.stringify(session.storage["lantern.slot.auto"]), before, `parked main autosave bytes must stay unchanged ${stage}`);
  const writes = session.storageSets.filter(item => item.key === "lantern.slot.auto").length +
    session.storageBatches.flat().filter(operation => operation.type === "set" && operation.key === "lantern.slot.auto").length;
  assert.equal(writes, writesBefore, `letter replay must not write the parked main autosave ${stage}`);
}

test("changing title language preserves the parked main autosave before and during a letter replay", async () => {
  const session = new NativeSession(artifacts, { width: 1280, height: 900, deadlineMs: 90_000 });
  try {
    let frame = await session.settle(await session.boot(), 4);
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 45);
    const saved = JSON.stringify(session.storage["lantern.slot.auto"]);
    assert.ok(saved, "a real new-game input must create the parked autosave");
    assert.equal(session.storage["lantern.slot.auto"]?.state?.active?.id, "arrival_01");
    frame = await session.tap("手札", frame);
    frame = await session.tap("返回扉页", frame);
    frame = await session.settle(frame, 4);
    const writes = session.storageSets.filter(item => item.key === "lantern.slot.auto").length +
      session.storageBatches.flat().filter(operation => operation.type === "set" && operation.key === "lantern.slot.auto").length;
    frame = await session.tap("阅读偏好", frame);
    frame = await session.tap("游戏语言 · 中文", frame);
    frame = await session.settle(frame, 60);
    assert.ok(visibleTextOp(frame, "Game language · English"), "the actual language control must switch to English");
    frame = await session.tap("Back", frame);
    frame = await session.settle(frame, 8);
    assertSameAuto(session, saved, writes, "after changing the title language");
    const ui = localeUi("en");
    frame = await scrollTitleToReplay(session, frame, ui);
    frame = await session.tapPoint(center(visibleTextOp(frame, ui.replayTitle)!, "letter replay after title language change"));
    frame = (await waitBody(session, frame, "To whoever finds this letter")).frame;
    assertSameAuto(session, saved, writes, "while the localized letter is playing");
    frame = await session.tap(ui.exit, frame);
    frame = await session.settle(frame, 8);
    assertSameAuto(session, saved, writes, "after exiting the localized replay");
  } finally {
    await session.quit();
  }
}, 90_000);

for (const locale of ["zh", "en"] as const) {
  for (const viewport of [
    { name: "phone", width: 360, height: 640, requireLongOverflow: true },
    { name: "wide", width: 1280, height: 900, requireLongOverflow: false },
  ]) {
    test(`native letter showcase scrolls and returns without touching main save (${locale}, ${viewport.name})`, async () => {
      const ui = localeUi(locale);
      const firstText = lineText(locale, "letter_showcase_01");
      const floatText = lineText(locale, "letter_showcase_02");
      const dialogueText = lineText(locale, "letter_showcase_03");
      const expectedFirst = locale === "zh" ? "读到这封信的人：" : "To whoever finds this letter:";
      const expectedFloat = locale === "zh" ? "玻璃后浮起一行浅浅的字" : "A faint line appears behind the glass";
      const expectedDialogue = locale === "zh" ? "原来这封信的收件人" : "This letter was meant for everyone";
      const storage = structuredClone(parkedSave.storage) as Record<string, unknown>;
      storage["lantern.locale"] = locale;
      const session = new NativeSession(artifacts, {
        width: viewport.width,
        height: viewport.height,
        storage,
        deadlineMs: 150_000,
        memory: { heapLimitBytes: 128 * 1024 * 1024, maxPakBytes: 72 * 1024 * 1024 },
      });
      try {
        let frame = await session.boot();
        assert.ok(visibleText(frame, ui.titleStart), `the original title screen is visible in ${viewport.width}×${viewport.height}`);
        const mainAuto = JSON.stringify(session.storage["lantern.slot.auto"]);
        assert.ok(mainAuto && mainAuto !== "null", "the title starts with a parked main autosave fixture");
        const autoWrites = session.storageSets.filter(item => item.key === "lantern.slot.auto").length +
          session.storageBatches.flat().filter(operation => operation.type === "set" && operation.key === "lantern.slot.auto").length;

        frame = await scrollTitleToReplay(session, frame, ui);
        const entry = visibleTextOp(frame, ui.replayTitle);
        assert.ok(entry, `the letter entry is visibly inside the title scroll clip: ${textOf(frame)}`);
        frame = await session.tapPoint(center(entry!, `visible title replay ${ui.replayTitle}`));
        const firstBody = await waitBody(session, frame, expectedFirst, 420);
        frame = firstBody.frame;
        assertImageBackedSkin(frame, "long fullscreen letter opening");
        assertSameAuto(session, mainAuto!, autoWrites, "after opening the replay");

        frame = await revealCurrentLine(session, frame, ui, expectedFirst, firstText);
        const longScroll = await scrollLongPassageToBottom(session, frame, expectedFirst, firstText, viewport.requireLongOverflow);
        frame = longScroll.frame;
        assertSameAuto(session, mainAuto!, autoWrites, "after reading and scrolling the long letter");
        const firstBounds = letterBodyOp(frame, expectedFirst);
        assert.ok(firstBounds?.clip, "long letter still owns the clipped reader viewport at the scroll end");

        const continueFirst = await waitVisible(session, frame, [ui.continue]);
        frame = await session.tapPoint(center(continueFirst.op, `visible continue after fullscreen letter ${locale}`));
        const floating = await revealCurrentLine(session, frame, ui, expectedFloat, floatText);
        frame = floating;
        const floatingOp = letterBodyOp(frame, expectedFloat);
        assert.ok(floatingOp && visibleRect(floatingOp!, frame), "floating passage has a visible rendered text rectangle");
        assertImageBackedSkin(frame, "floating passage");
        assertSameAuto(session, mainAuto!, autoWrites, "after floating passage");

        const continueFloating = await waitVisible(session, frame, [ui.continue]);
        frame = await session.tapPoint(center(continueFloating.op, `visible continue after floating passage ${locale}`));
        frame = await revealCurrentLine(session, frame, ui, expectedDialogue, dialogueText);
        const dialogueOp = letterBodyOp(frame, expectedDialogue);
        assert.ok(dialogueOp && visibleRect(dialogueOp!, frame), "ordinary Mira dialogue is visibly painted");
        assertImageBackedSkin(frame, "ordinary dialogue passage");
        assertSameAuto(session, mainAuto!, autoWrites, "after ordinary dialogue");

        const floatBounds = opRect(floatingOp!);
        const dialogueBounds = opRect(dialogueOp!);
        assert.ok(floatBounds && dialogueBounds, "both visual modes expose native text bounds");
        assert.ok(floatBounds!.y !== dialogueBounds!.y || floatBounds!.h !== dialogueBounds!.h,
          "floating text and ordinary dialogue occupy distinct rendered layouts");

        const exit = await waitVisible(session, frame, [ui.exit]);
        frame = await session.tapPoint(center(exit.op, `visible replay exit ${ui.exit}`));
        const returned = await waitVisible(session, frame, [ui.titleStart, ui.replayTitle], 240);
        frame = returned.frame;
        assertSameAuto(session, mainAuto!, autoWrites, "after returning to the title journey");
        console.log("NATIVE_LETTER_SHOWCASE", JSON.stringify({
          locale,
          viewport: [viewport.width, viewport.height],
          entry: letterReplay!.id,
          longLine: "letter_showcase_01",
          floatingLine: "letter_showcase_02",
          dialogueLine: "letter_showcase_03",
          longScrollDrags: longScroll.dragCount,
          longTextBounds: { startY: longScroll.startY, finalY: longScroll.finalY, height: longScroll.textHeight, clipHeight: longScroll.clipHeight },
          skinTriangles: (frame.ops ?? []).filter(op => op.type === "textureTriangle" && textAsset(op) === "art/ui/harbor-frame-refined.png").length,
          parkedAutosaveBytes: Buffer.byteLength(mainAuto!, "utf8"),
          autosaveWritesDuringReplay: 0,
        }));
      } finally {
        await session.quit();
      }
    }, 180_000);
  }
}

test("narrow fullscreen letter reaches its final line and resets the floating passage to a visible clip", async () => {
  const locale = "zh" as const;
  const ui = localeUi(locale);
  const firstText = lineText(locale, "letter_showcase_01");
  const floatText = lineText(locale, "letter_showcase_02");
  const expectedFirst = "读到这封信的人：";
  const expectedFloatStart = "玻璃后浮起一行浅浅的字";
  const expectedFloatEnd = "守灯的人，也应该拥有自己的天亮。";
  const expectedLast = "天亮以后，带着它出发。";
  const storage = structuredClone(parkedSave.storage) as Record<string, unknown>;
  storage["lantern.locale"] = locale;
  const session = new NativeSession(artifacts, {
    width: 329,
    height: 600,
    storage,
    deadlineMs: 150_000,
    memory: { heapLimitBytes: 128 * 1024 * 1024, maxPakBytes: 72 * 1024 * 1024 },
  });
  try {
    let frame = await session.boot();
    const mainAuto = JSON.stringify(session.storage["lantern.slot.auto"]);
    assert.ok(mainAuto && mainAuto !== "null", "narrow replay starts with a parked main autosave");
    const writesBefore = session.storageSets.filter(item => item.key === "lantern.slot.auto").length +
      session.storageBatches.flat().filter(operation => operation.type === "set" && operation.key === "lantern.slot.auto").length;
    frame = await scrollTitleToReplay(session, frame, ui);
    const entry = visibleTextOp(frame, ui.replayTitle);
    assert.ok(entry, `letter replay is visible in the 329×600 title viewport: ${textOf(frame)}`);
    frame = await session.tapPoint(center(entry!, "narrow letter title replay"));
    const firstBody = await revealCurrentLine(session, frame, ui, expectedFirst, firstText);
    frame = firstBody;
    const longScroll = await scrollLongPassageToBottom(session, frame, expectedFirst, firstText, true);
    frame = longScroll.frame;
    const finalLine = visibleLineFact(frame, expectedLast);
    assert.ok(finalLine, `the final fullscreen sentence is visible inside its clip after a real scroll; frame=${textOf(frame)}`);
    assert.ok(finalLine!.visibleRect.h >= finalLine!.lineRect.h * 0.75,
      `the final line must have substantial visible clip area: ${JSON.stringify(finalLine)}`);
    const continueFirst = await waitVisible(session, frame, [ui.continue]);
    frame = await session.tapPoint(center(continueFirst.op, "narrow fullscreen continue"));
    const floating = await revealCurrentLine(session, frame, ui, expectedFloatStart, floatText);
    frame = floating;
    const floatingStart = visibleLineFact(frame, expectedFloatStart);
    const floatingEnd = visibleLineFact(frame, expectedFloatEnd);
    assert.ok(floatingStart && floatingEnd,
      `both opening and closing floating text lines must be visible within their real clip; frame=${textOf(frame)}`);
    assert.ok(floatingStart!.visibleRect.h >= floatingStart!.lineRect.h * 0.75);
    assert.ok(floatingEnd!.visibleRect.h >= floatingEnd!.lineRect.h * 0.75);
    assertImageBackedSkin(frame, "narrow floating passage");
    assertSameAuto(session, mainAuto!, writesBefore, "after narrow fullscreen-to-floating transition");
    const exit = await waitVisible(session, frame, [ui.exit]);
    frame = await session.tapPoint(center(exit.op, "narrow letter replay exit"));
    await waitVisible(session, frame, [ui.titleStart, ui.replayTitle]);
    assertSameAuto(session, mainAuto!, writesBefore, "after narrow replay exit");
    console.log("NATIVE_LETTER_NARROW_SCROLL", JSON.stringify({
      viewport: [329, 600],
      fullscreenScrollDrags: longScroll.dragCount,
      fullscreenFinalLine: { rect: finalLine!.lineRect, visible: finalLine!.visibleRect },
      floatingStart: { line: floatingStart!.line, rect: floatingStart!.lineRect, visible: floatingStart!.visibleRect },
      floatingEnd: { line: floatingEnd!.line, rect: floatingEnd!.lineRect, visible: floatingEnd!.visibleRect },
      parkedAutosaveBytes: Buffer.byteLength(mainAuto!, "utf8"),
      autosaveWritesDuringReplay: 0,
    }));
  } finally {
    await session.quit();
  }
}, 180_000);
