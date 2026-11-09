import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NativeSession, center, readNativeArtifacts, textOf, textOps, type DrawOp, type Frame } from "./native_session.ts";
import { createNovelViewportLayout } from "../../../sdk/packages/pocket_vn/src/viewport.ts";

const directory = `${import.meta.dir}/../../assets/apps/lantern`;
process.env.POCKET_VIEWPORT_GUEST_BYTECODE = `${directory}/app.qjbc`;
process.env.POCKET_VIEWPORT_GUEST_PAK = `${directory}/app.pak`;
process.env.POCKET_VIEWPORT_GUEST_METADATA = `${directory}/app.bytecode.json`;
const artifacts = readNativeArtifacts("POCKET_VIEWPORT");
const story = JSON.parse(readFileSync(resolve(import.meta.dir, "../apps/lantern/story.json"), "utf8")) as {
  script: Record<string, Array<{ type?: string; id?: string; prompt?: string; options?: Array<{ id: string; text: string }> }>>;
};
const firstChoiceId = "arrival_approach";

function authoredChoice(id: string) {
  for (const instructions of Object.values(story.script)) {
    const found = instructions.find(instruction => instruction.type === "choice" && instruction.id === id);
    if (found) return found;
  }
  throw new Error(`current Lantern story has no choice with stable ID ${id}`);
}

function activeSave(session: NativeSession): Record<string, any> | undefined {
  return session.storage["lantern.slot.auto"]?.state?.active as Record<string, any> | undefined;
}

function normalizeText(value: string): string { return value.replace(/[\s\u200b\ufeff]/g, ""); }

function dialoguePoint(session: NativeSession): { x: number; y: number } {
  const layout = createNovelViewportLayout({ width: session.width, height: session.height }, { top: 0, right: 0, bottom: 0, left: 0 });
  return { x: layout.insetL + layout.width / 2, y: layout.insetT + layout.height - layout.dialogueBottom - layout.dialogueHeight / 2 };
}

function assertFrameSize(frame: Frame, width: number, height: number): void {
  expect(frame.width).toBe(width);
  expect(frame.height).toBe(height);
}

function findPaintedTextStartingWith(frame: Frame, prefix: string): DrawOp | undefined {
  const normalizedPrefix = normalizeText(prefix);
  if (!normalizeText(textOf(frame)).includes(normalizedPrefix)) return undefined;
  return (frame.ops ?? []).find(op => op.type === "text" && typeof op.text === "string"
    && normalizeText(op.text).startsWith(normalizedPrefix)
    && (op.color === undefined || ((op.color >>> 24) & 0xff) >= 250));
}

async function waitForPaintedTextStartingWith(session: NativeSession, initial: Frame, fullText: string, prefix: string, maxFrames = 120): Promise<{ frame: Frame; op: DrawOp }> {
  let frame = initial;
  for (let index = 0; index < maxFrames; index += 1) {
    const op = findPaintedTextStartingWith(frame, prefix);
    if (op && normalizeText(textOf(frame)).includes(normalizeText(fullText))) return { frame, op };
    frame = await session.frame();
  }
  throw new Error(`choice option never became visibly painted and tappable: ${fullText}\n${textOf(frame)}`);
}

async function waitForStableText(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  let previous = textOps(frame, label)[0];
  expect(previous, `resized frame must paint ${label}`).toBeDefined();
  for (let index = 0; index < 12; index += 1) {
    frame = await session.frame();
    const current = textOps(frame, label)[0];
    if (!current || !previous) { previous = current; continue; }
    const stable = (["x", "y", "w", "h"] as const).every(key =>
      Math.abs((current[key] ?? 0) - (previous![key] ?? 0)) < 0.5,
    );
    if (stable) return frame;
    previous = current;
  }
  throw new Error(`${label} did not settle to stable painted coordinates after live resize`);
}

async function reachFirstChoice(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  const expected = authoredChoice(firstChoiceId);
  expect(expected.prompt).toBeTruthy();
  for (let step = 0; step < 100; step += 1) {
    const current = activeSave(session);
    if (current?.kind === "choice") {
      expect(current.id).toBe(firstChoiceId);
      expect(normalizeText(String(current.prompt ?? ""))).toBe(normalizeText(expected.prompt!));
      if (normalizeText(textOf(frame)).includes(normalizeText(String(current.prompt)))) return frame;
      frame = await session.frame();
      continue;
    }
    if (current?.kind === "ending") throw new Error(`Lantern reached ending ${current.id} before ${firstChoiceId}`);
    frame = await session.tapPoint(dialoguePoint(session));
    frame = await session.settle(frame, 48);
  }
  throw new Error(`actual choice ${firstChoiceId} did not become visible; active=${JSON.stringify(activeSave(session))}; painted=${textOf(frame)}`);
}

test("one running Lantern guest fills phone, tablet and desktop viewports and keeps menu/dialogue/choice pointer targets reachable", async () => {
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 60_000 });
  try {
    let frame = await session.boot();
    assertFrameSize(frame, 360, 640);
    const start = textOps(frame, "启程 · 开始新的故事")[0];
    expect(start).toBeDefined();
    expect(start!.x).toBeGreaterThanOrEqual(0);
    expect(start!.x! + start!.w!).toBeLessThanOrEqual(360);

    // A real title-screen pointer starts the same compiled guest session.
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 80);
    expect(textOf(frame)).toContain("23点08分");

    const sizes = [[360, 640], [390, 844], [1280, 720], [1920, 1080], [1024, 768], [390, 844], [844, 340]] as const;
    for (const [width, height] of sizes) {
      frame = width === session.width && height === session.height ? frame : await session.resize(width, height);
      assertFrameSize(frame, width, height);
      frame = await waitForStableText(session, frame, "手札");
      expect(textOf(frame)).toContain("23点08分");

      if (width >= 1200) {
        const line = findPaintedTextStartingWith(frame, "23点08分");
        expect(line, "long dialogue must paint in the wider bounded text column").toBeDefined();
        expect(line!.w!).toBeGreaterThan(360);
        expect(line!.w!).toBeLessThanOrEqual(720.5);
        const station = (frame.ops ?? []).find(op => op.type === "image" && (op as DrawOp & { asset?: string }).asset === "art/station.png");
        expect(station, "the original background must still render after viewport resize").toBeDefined();
        expect(station!.w!).toBeGreaterThanOrEqual(1280);
      }

      // Exercise the real header button, modal, and Continue action at each size.
      const menuOp = textOps(frame, "手札")[0];
      expect(menuOp).toBeDefined();
      const menuPoint = center(menuOp!, `menu at ${width}×${height}`);
      console.log(`novel_viewport_native: ${width}×${height} menu text at ${menuOp!.x},${menuOp!.y}, ${menuOp!.w}×${menuOp!.h}; pointer=${menuPoint.x},${menuPoint.y}`);
      if (width === 1920) expect(menuPoint.x, "wide right-side header remains painted past the old ten-bit wire ceiling").toBeGreaterThan(1023);
      frame = await session.tapPoint(menuPoint);
      frame = await session.settle(frame, 2);
      expect(textOf(frame), `the painted menu must open by pointer at ${width}×${height}`).toContain("旅途手札");
      const continueLabel = textOps(frame, "继续阅读")[0];
      expect(continueLabel, `Continue must be painted in ${width}×${height}`).toBeDefined();
      expect(continueLabel!.x!).toBeGreaterThanOrEqual(0);
      expect(continueLabel!.y!).toBeLessThan(height);
      frame = await session.tap("继续阅读", frame);
      frame = await session.settle(frame, 2);
      expect(textOf(frame)).not.toContain("旅途手札");
    }

    // Resize keeps the original JS engine/scene alive. Use its ordinary
    // dialogue hit target to reach and select the authored first choice.
    frame = await reachFirstChoice(session, frame);
    const definition = authoredChoice(firstChoiceId);
    const selectedId = "listen_mira";
    const authoredOption = definition.options?.find(value => value.id === selectedId);
    expect(authoredOption, `current choice ${firstChoiceId} must retain the stable option ID ${selectedId}`).toBeDefined();
    const runtimeOption = (activeSave(session)?.options as Array<{ id: string; text: string }> | undefined)?.find(value => value.id === selectedId);
    expect(runtimeOption).toBeDefined();
    expect(normalizeText(runtimeOption!.text)).toBe(normalizeText(authoredOption!.text));
    expect(normalizeText(textOf(frame))).toContain(normalizeText(runtimeOption!.text));
    const prefix = Array.from(authoredOption!.text).slice(0, 12).join("");
    const painted = await waitForPaintedTextStartingWith(session, frame, runtimeOption!.text, prefix);
    frame = await session.tapPoint({ x: painted.op.x! + painted.op.w! / 2, y: painted.op.y! + painted.op.h! / 2 });
    frame = await session.settle(frame, 48);
    expect(normalizeText(textOf(frame))).not.toContain(normalizeText(String(definition.prompt)));
    expect(session.requests.some(request => request.capability === "media.audio.play"), "story start must keep using the real native capability boundary").toBe(true);
  } finally {
    await session.quit();
  }
}, 90_000);
