import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NativeSession, type Frame, type NativeArtifacts } from "./native_session.ts";

test("Lantern's actual Spine mesh animates in QuickJS and pauses with the menu", async () => {
  const directory = resolve(import.meta.dir, "../../assets/apps/lantern");
  const metadataPath = resolve(directory, "app.bytecode.json");
  const artifacts: NativeArtifacts = { bytecodePath: resolve(directory, "app.qjbc"), pakPath: resolve(directory, "app.pak"), metadataPath, runtimeAbi: JSON.parse(readFileSync(metadataPath, "utf8")).runtimeAbi };
  const previous = process.env.POCKET_NATIVE_PROBE;
  process.env.POCKET_NATIVE_PROBE = resolve(import.meta.dir, "../../../sdk/native/target/debug/pocket_probe");
  const session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 30000 });
  const triangles = (frame: Frame) => frame.ops?.filter(op => op.type === "textureTriangle" && String((op as any).asset).includes("mira-")) ?? [];
  const points = (frame: Frame) => JSON.stringify(triangles(frame).map(op => op.points));
  try {
    let frame = await session.boot();
    frame = await session.tap("启程 · 开始新的故事", frame);
    frame = await session.settle(frame, 70);
    expect(triangles(frame).length).toBeGreaterThan(10);
    const initial = points(frame);
    frame = await session.settle(frame, 45);
    expect(points(frame)).not.toBe(initial);
    frame = await session.tap("手札", frame);
    const paused = points(frame);
    frame = await session.settle(frame, 45);
    expect(points(frame)).toBe(paused);
    frame = await session.tap("返回", frame);
    frame = await session.settle(frame, 40);
    expect(points(frame)).not.toBe(paused);
  } finally {
    await session.quit();
    if (previous === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = previous;
  }
}, 45000);
