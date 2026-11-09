import { strict as assert } from "node:assert";
import { NativeSession, center, textOf, type Frame, type DrawOp } from "./native_session.ts";

const compact = (value: string): string => value.replace(/[\s\u200b\ufeff]/g, "");

export function visibleTextOp(frame: Frame, label: string): DrawOp | undefined {
  const wanted = compact(label);
  return (frame.ops ?? []).find(op => {
    if (op.type !== "text" || !compact(op.text ?? "").includes(wanted)) return false;
    if ([op.x, op.y, op.w, op.h].some(value => typeof value !== "number")) return false;
    const clip = op.clip ?? { x: 0, y: 0, w: frame.width ?? Number.POSITIVE_INFINITY, h: frame.height ?? Number.POSITIVE_INFINITY };
    const left = Math.max(op.x!, clip.x ?? 0, 0);
    const top = Math.max(op.y!, clip.y ?? 0, 0);
    const right = Math.min(op.x! + op.w!, (clip.x ?? 0) + (clip.w ?? Number.POSITIVE_INFINITY), frame.width ?? Number.POSITIVE_INFINITY);
    const bottom = Math.min(op.y! + op.h!, (clip.y ?? 0) + (clip.h ?? Number.POSITIVE_INFINITY), frame.height ?? Number.POSITIVE_INFINITY);
    const centerX = op.x! + op.w! / 2;
    const centerY = op.y! + op.h! / 2;
    return right > left && bottom > top && centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
  });
}

export async function waitForText(session: NativeSession, initial: Frame, expected: string, attempts = 120): Promise<Frame> {
  let frame = initial;
  const target = compact(expected);
  for (let index = 0; index < attempts; index += 1) {
    if (compact(textOf(frame)).includes(target)) return frame;
    frame = await session.frame();
  }
  throw new Error(`real Lantern QJBC never painted '${expected}': ${textOf(frame)}`);
}

export async function revealVisibleAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  let frame = initial;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const target = visibleTextOp(frame, label);
    if (target) return frame;
    const source = (frame.ops ?? []).find(op => op.type === "text" && compact(op.text ?? "").includes(compact(label)) && op.clip);
    const clip = source?.clip ?? (frame.ops ?? []).find(op => op.type === "text" && op.clip && (op.clip.h ?? 0) > 120)?.clip;
    assert.ok(clip, `the actual guest must expose a clipped menu/gallery scroller for '${label}': ${textOf(frame)}`);
    const x = clip!.x! + clip!.w! / 2;
    frame = await session.drag({ x, y: clip!.y! + clip!.h! * 0.82 }, { x, y: clip!.y! + clip!.h! * 0.22 }, 8, 2);
    frame = await session.settle(frame, 2);
  }
  throw new Error(`actual guest action did not become visibly reachable: ${label}; ${textOf(frame)}`);
}

export async function tapVisibleAction(session: NativeSession, initial: Frame, label: string): Promise<Frame> {
  const frame = await revealVisibleAction(session, initial, label);
  const op = visibleTextOp(frame, label);
  assert.ok(op, `visible UI action is painted: ${label}`);
  return session.settle(await session.tapPoint(center(op!, label)), 3);
}

export async function tapUntilText(session: NativeSession, initial: Frame, expected: string, attempts = 10): Promise<Frame> {
  let frame = initial;
  const target = compact(expected);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (compact(textOf(frame)).includes(target)) return frame;
    frame = await session.tapPoint({ x: 180, y: 470 });
    frame = await session.settle(frame, 1);
  }
  throw new Error(`story input did not reach '${expected}': ${textOf(frame)}`);
}
