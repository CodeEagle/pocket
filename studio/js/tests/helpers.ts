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
