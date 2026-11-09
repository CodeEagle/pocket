import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import {
  NativeSession,
  center,
  readNativeArtifacts,
  textOf,
  type DrawOp,
  type Frame,
} from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const guestDirectory = resolve(repositoryRoot, "demo/assets/apps/lantern");
process.env.POCKET_LANTERN_GUEST_BYTECODE ??= resolve(guestDirectory, "app.qjbc");
process.env.POCKET_LANTERN_GUEST_PAK ??= resolve(guestDirectory, "app.pak");
process.env.POCKET_LANTERN_GUEST_METADATA ??= resolve(guestDirectory, "app.bytecode.json");

const artifacts = readNativeArtifacts("POCKET_LANTERN");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

assert.ok(existsSync(artifacts.bytecodePath), "the selected Lantern Guest bytecode must exist");
assert.ok(existsSync(artifacts.pakPath), "the selected Lantern Guest PAK must exist");

const assetDocument = JSON.parse(readFileSync(resolve(repositoryRoot, "demo/js/apps/lantern/novel.assets.json"), "utf8")) as {
  characters: Record<string, Record<string, string>>;
  collections: Record<string, {
    entries: Record<string, { title: string; body: string; portrait?: { character: string; expression: string }; unlockVariable?: string }>;
  }>;
};
const publicEntry = assetDocument.collections.evidence!.entries.station!;
const miraEntry = assetDocument.collections.people!.entries.mira!;
const sealedLetterEntry = assetDocument.collections.evidence!.entries.sealed_letter!;
const miraPortraitAsset = assetDocument.characters.mira!.neutral!;

type RuntimeState = Record<string, any>;
const autosaveKey = "lantern.slot.auto";
const compact = (value: string) => value.replace(/[\s\u200b\ufeff]/g, "");

function active(session: NativeSession): RuntimeState | null {
  return (session.storage[autosaveKey]?.state?.active as RuntimeState | undefined) ?? null;
}

function visibleBounds(op: DrawOp, frame: Frame): { x: number; y: number; w: number; h: number } | undefined {
  if ([op.x, op.y, op.w, op.h].some(value => typeof value !== "number")) return undefined;
  const clip = op.clip ?? { x: 0, y: 0, w: frame.width ?? Number.POSITIVE_INFINITY, h: frame.height ?? Number.POSITIVE_INFINITY };
  const x = Math.max(op.x!, clip.x ?? 0, 0);
  const y = Math.max(op.y!, clip.y ?? 0, 0);
  const right = Math.min(op.x! + op.w!, (clip.x ?? 0) + (clip.w ?? Number.POSITIVE_INFINITY), frame.width ?? Number.POSITIVE_INFINITY);
  const bottom = Math.min(op.y! + op.h!, (clip.y ?? 0) + (clip.h ?? Number.POSITIVE_INFINITY), frame.height ?? Number.POSITIVE_INFINITY);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : undefined;
}

function visibleTextOp(frame: Frame, label: string): DrawOp | undefined {
  const target = compact(label);
  return (frame.ops ?? []).find(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(target)) return false;
    const visible = visibleBounds(op, frame);
    if (!visible) return false;
    const x = op.x! + op.w! / 2;
    const y = op.y! + op.h! / 2;
    return x >= visible.x && x <= visible.x + visible.w && y >= visible.y && y <= visible.y + visible.h;
  });
}

function scrollClip(frame: Frame, anchorText: string): NonNullable<DrawOp["clip"]> {
  const anchor = (frame.ops ?? []).find(op => op.type === "text" && op.clip
    && compact(op.text ?? "").includes(compact(anchorText)));
  if (anchor?.clip) return anchor.clip;
  const fallback = (frame.ops ?? []).find(op => op.type === "text" && op.clip
    && (op.clip.w ?? 0) >= 120 && (op.clip.h ?? 0) >= 100);
  assert.ok(fallback?.clip, `a real clipped scroll viewport must be painted: ${textOf(frame)}`);
  return fallback!.clip!;
}

async function revealText(
  session: NativeSession,
  initial: Frame,
  label: string,
  options: { direction: "down" | "up"; anchorText: string },
): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if (visibleTextOp(frame, label)) return frame;
    const clip = scrollClip(frame, options.anchorText);
    const x = clip.x! + clip.w! / 2;
    const fromY = clip.y! + clip.h! * (options.direction === "down" ? 0.82 : 0.22);
    const toY = clip.y! + clip.h! * (options.direction === "down" ? 0.22 : 0.82);
    frame = await session.drag({ x, y: fromY }, { x, y: toY }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`text did not become visibly reachable through real scrolling: ${label}; painted=${textOf(frame)}`);
}

async function tapVisibleText(session: NativeSession, frame: Frame, label: string): Promise<Frame> {
  const op = visibleTextOp(frame, label);
  assert.ok(op, `visible text action is painted: ${label}; painted=${textOf(frame)}`);
  return session.tapPoint(center(op!, label));
}

async function advanceSay(session: NativeSession, initial: Frame): Promise<Frame> {
  const before = active(session);
  assert.equal(before?.kind, "say", `expected a dialogue line, got ${JSON.stringify(before)}`);
  const id = String(before!.id);
  let frame = await session.tapPoint({ x: 180, y: 470 });
  frame = await session.settle(frame, 1);
  if (active(session)?.kind === "say" && active(session)?.id === id) {
    frame = await session.tapPoint({ x: 180, y: 470 });
    frame = await session.settle(frame, 1);
  }
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (active(session)?.id !== id) return frame;
    frame = await session.frame();
  }
  throw new Error(`real dialogue input did not advance beyond ${id}; prior=${textOf(initial)}; latest=${textOf(frame)}`);
}

async function driveToChoice(session: NativeSession, initial: Frame, id: string): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 700; attempt += 1) {
    const state = active(session);
    if (state?.kind === "choice") {
      assert.equal(state.id, id, `expected choice ${id}, reached ${state.id}`);
      return frame;
    }
    if (state?.kind === "say") frame = await advanceSay(session, frame);
    else if (state?.kind === "wait") frame = await session.frame();
    else throw new Error(`cannot drive toward choice ${id} from ${JSON.stringify(state)}; painted=${textOf(frame)}`);
  }
  throw new Error(`did not reach choice ${id}; active=${JSON.stringify(active(session))}; painted=${textOf(frame)}`);
}

async function choose(session: NativeSession, initial: Frame, optionId: string): Promise<Frame> {
  const choice = active(session);
  assert.equal(choice?.kind, "choice", `expected a choice before selecting ${optionId}`);
  const option = (choice!.options as Array<{ id: string; text: string }>).find(item => item.id === optionId);
  assert.ok(option, `choice ${choice!.id} must offer ${optionId}`);
  let frame = initial;
  let op: DrawOp | undefined;
  const target = compact(option!.text);
  for (let attempt = 0; attempt < 180; attempt += 1) {
    op = (frame.ops ?? [])
      .filter(item => item.type === "text" && compact(item.text ?? "").length >= 2
        && target.startsWith(compact(item.text ?? "")) && visibleBounds(item, frame) !== undefined)
      .sort((left, right) => compact(right.text ?? "").length - compact(left.text ?? "").length)[0];
    if (op) break;
    frame = await session.frame();
  }
  assert.ok(op, `choice option ${optionId} must be visibly painted before pointer input: ${textOf(frame)}`);
  return session.tapPoint(center(op!, optionId));
}

async function driveToHub(session: NativeSession, initial: Frame): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 700; attempt += 1) {
    const state = active(session);
    if (state?.kind === "choice" && state.id === "investigation_hub") return frame;
    if (state?.kind === "say") frame = await advanceSay(session, frame);
    else if (state?.kind === "wait") frame = await session.frame();
    else throw new Error(`expected Mira route to reach investigation_hub, got ${JSON.stringify(state)}; painted=${textOf(frame)}`);
  }
  throw new Error(`Mira route did not reach investigation_hub; active=${JSON.stringify(active(session))}`);
}

function assertLockedBodiesNotPainted(frame: Frame): void {
  const painted = compact(textOf(frame));
  assert.equal(painted.includes(compact("她替母亲带来一封不能代拆的信")), false,
    "locked Mira archive body must not be mounted in the title archive list");
  assert.equal(painted.includes(compact("收件栏写着 Ren，寄件栏空白")), false,
    "locked sealed-letter archive body must not be mounted in the title archive list");
}

function portraitIsFullyVisible(frame: Frame, asset: string): boolean {
  return (frame.ops ?? []).some(op => {
    if (op.type !== "image" || (op as DrawOp & { asset?: string }).asset !== asset) return false;
    const visible = visibleBounds(op, frame);
    return visible !== undefined && Math.abs(visible.x - op.x!) < 1 && Math.abs(visible.y - op.y!) < 1
      && Math.abs(visible.w - op.w!) < 1 && Math.abs(visible.h - op.h!) < 1;
  });
}

function textIsFullyVisible(frame: Frame, value: string): boolean {
  const needle = compact(value);
  const candidates = (frame.ops ?? []).filter(op => op.type === "text" && typeof op.text === "string"
    && needle.includes(compact(op.text)) && compact(op.text).length > 1)
    .sort((left, right) => (left.y ?? 0) - (right.y ?? 0));
  const text = candidates.filter(op => {
    const visible = visibleBounds(op, frame);
    return visible !== undefined && Math.abs(visible.x - op.x!) < 1 && Math.abs(visible.y - op.y!) < 1
      && Math.abs(visible.w - op.w!) < 1 && Math.abs(visible.h - op.h!) < 1;
  }).map(op => compact(op.text ?? "")).join("");
  return text.includes(needle);
}

test("Lantern v5 title and journal collections reveal only earned records through real pointer input", async () => {
  const session = new NativeSession(artifacts, { width: 800, height: 600, deadlineMs: 180_000 });
  try {
    let frame = await session.boot();
    frame = await revealText(session, frame, "旅人档案", {
      direction: "down",
      anchorText: "开始新的故事",
    });
    frame = await tapVisibleText(session, frame, "旅人档案");
    frame = await session.settle(frame, 3);
    assert.ok(textOf(frame).includes("雾港人物"), "the real title-page archive panel opens");
    assertLockedBodiesNotPainted(frame);

    frame = await revealText(session, frame, "雾港旧站", {
      direction: "down",
      anchorText: "Mira · 携信人",
    });
    frame = await tapVisibleText(session, frame, "雾港旧站");
    frame = await session.settle(frame, 3);
    assert.ok(visibleTextOp(frame, "收信亭、旧透镜和铃箱曾属于同一条邮路"),
      "the public station record body is visible before starting the story");
    assertLockedBodiesNotPainted(frame);

    frame = await revealText(session, frame, "返回档案列表", {
      direction: "down",
      anchorText: "收信亭、旧透镜",
    });
    frame = await tapVisibleText(session, frame, "返回档案列表");
    frame = await session.settle(frame, 2);
    frame = await revealText(session, frame, "Mira · 携信人", {
      direction: "up",
      anchorText: "雾港旧站",
    });
    assert.ok(textOf(frame).includes("尚未解锁，继续旅程后再来看看"), "Mira entry is visibly locked before her route");
    frame = await session.tapPoint(center(visibleTextOp(frame, "Mira · 携信人")!, "locked Mira entry"));
    frame = await session.settle(frame, 2);
    assertLockedBodiesNotPainted(frame);
    assert.equal((frame.ops ?? []).some(op => (op as DrawOp & { asset?: string }).asset === miraPortraitAsset), false,
      "the locked entry must not mount Mira's portrait image");

    frame = await tapVisibleText(session, frame, "返回");
    frame = await session.settle(frame, 2);
    frame = await revealText(session, frame, "启程 · 开始新的故事", {
      direction: "up",
      anchorText: "旅人档案",
    });
    frame = await tapVisibleText(session, frame, "启程 · 开始新的故事");
    frame = await driveToChoice(session, frame, "arrival_approach");
    frame = await choose(session, frame, "listen_mira");
    frame = await driveToChoice(session, frame, "memory_response");
    frame = await choose(session, frame, "trust_mira");
    frame = await driveToHub(session, frame);
    const unlockedSave = session.storage[autosaveKey];
    assert.equal(unlockedSave?.state?.meta?.persistentVariables?.record_mira, true,
      "the real listen_mira dialogue/call route must execute its persistent unlock instruction");

    frame = await tapVisibleText(session, frame, "手札");
    frame = await session.settle(frame, 2);
    frame = await revealText(session, frame, "旅人档案", {
      direction: "down",
      anchorText: "继续阅读",
    });
    frame = await tapVisibleText(session, frame, "旅人档案");
    frame = await session.settle(frame, 2);
    frame = await revealText(session, frame, miraEntry.title, {
      direction: "down",
      anchorText: "雾港人物",
    });
    frame = await tapVisibleText(session, frame, miraEntry.title);
    frame = await session.settle(frame, 3);

    const paintedText = compact(textOf(frame));
    assert.ok(paintedText.includes(compact(miraEntry.body)), "the unlocked Mira archive body is fully painted in the journal detail");
    assert.ok(textIsFullyVisible(frame, miraEntry.body), "the unlocked Mira archive body fits inside the visible journal clip");
    assert.ok(portraitIsFullyVisible(frame, miraPortraitAsset),
      `the unlocked archive detail shows the original registered Mira portrait (${miraPortraitAsset}) fully inside its clip`);
    console.log("LANTERN_COLLECTIONS_NATIVE", JSON.stringify({
      guestQjbcSha256: sha256(artifacts.bytecodePath),
      guestPakSha256: sha256(artifacts.pakPath),
      publicEntry: "evidence.station",
      publicBodyVisibleBeforeStory: true,
      lockedMiraAndLetterBodiesNotPainted: true,
      unlockRoute: "title start -> arrival_approach/listen_mira -> memory_note call -> investigation_hub",
      unlockedVariable: unlockedSave.state.meta.persistentVariables.record_mira,
      journalEntry: "people.mira",
      journalBodyVisible: paintedText.includes(compact(miraEntry.body)),
      portraitAsset: miraPortraitAsset,
      portraitFullyVisible: portraitIsFullyVisible(frame, miraPortraitAsset),
      activeHubChoice: "investigation_hub",
    }));
  } finally {
    await session.quit();
  }
}, 210_000);
