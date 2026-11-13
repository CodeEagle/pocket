import { strict as assert } from "node:assert";
import { ProbeSession, center, textOf, textOps, type Frame } from "./probe_session.ts";
import { FakeStudio } from "./fake_studio.ts";

export const has = (frame: Frame, text: string): boolean => textOf(frame).includes(text);

/** Taps the n-th text op that equals `label`. */
export async function tapText(session: ProbeSession, frame: Frame, label: string | RegExp, nth = 0): Promise<void> {
  const ops = textOps(frame, label);
  const op = nth < 0 ? ops[ops.length + nth] : ops[nth];
  assert.ok(op, `no text "${String(label)}" (#${nth}) in\n${textOf(frame)}`);
  const p = center(op);
  await session.tap(p.x, p.y);
}

/** Opens the first project and waits for its file tree. */
export async function openAlpha(session: ProbeSession): Promise<Frame> {
  let frame = await session.until((f) => has(f, "Alpha 应用"), "project list");
  await tapText(session, frame, "Alpha 应用");
  frame = await session.until((f) => has(f, "app.tsx"), "file tree");
  return frame;
}

export async function openFile(session: ProbeSession, name: string, marker: string): Promise<Frame> {
  let frame = await session.frame();
  await tapText(session, frame, name);
  frame = await session.until((f) => has(f, marker), `file ${name} in editor`);
  return frame;
}

/** Taps the editor text (the InputField shell), then delivers `text` as the native edit. */
export async function typeInEditor(session: ProbeSession, frame: Frame, shellText: string | RegExp, text: string): Promise<Frame> {
  await tapText(session, frame, shellText);
  return session.typeIntoOpenField(text);
}

/** A fake studio service wired to a booted probe session. */
export async function boot(setup?: (fake: FakeStudio) => void, editor: "input" | "code" = "input"): Promise<{ fake: FakeStudio; session: ProbeSession }> {
  const fake = new FakeStudio();
  // The M2/M3 workflow tests drive the InputField, so they store editor:"input"; code-pane tests pass "code" (the product default).
  fake.storage.set("studio.settings.v1", { editor });
  setup?.(fake);
  const session = new ProbeSession(fake.handle);
  fake.attach(session);
  await session.boot();
  return { fake, session };
}

/** One `input.text` key-down (modifier mask: shift=1 control=2 alt=4 meta=8) and the frame that handles it. */
export async function press(session: ProbeSession, name: string, modifiers = 0): Promise<Frame> {
  session.sendEvent("input.text", [{ kind: "keyDown", key: name, ...(modifiers ? { modifiers } : {}) }] as unknown as Record<string, unknown>);
  return session.frame();
}

/** The code view session handshake of the code-pane tests: tap a code row, the host answers rawOpened. */
export async function focusEditor(session: ProbeSession, rowText: RegExp): Promise<Frame> {
  const frame = await session.frame();
  const op = textOps(frame, rowText)[0];
  assert.ok(op, `no code row ${rowText} in\n${textOf(frame)}`);
  await session.tap(op.x! + 1, center(op).y);
  const open = [...session.guestEvents].reverse().find((e) => e.name === "textInput.rawOpen");
  assert.ok(open, "tapping the code view must open a raw text session");
  session.sendEvent("textInput.rawOpened", { id: String(open.payload.id) });
  return session.settle(3);
}
