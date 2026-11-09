import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";

test("plain scene-object projects reject bad declarations and missing registry references before creating a Guest", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-object-build-negative-"));
  const output = join(project, "out");
  const writeStory = (object: unknown) => writeFileSync(join(project, "story.json"), JSON.stringify({ id: "object-build", version: 1, start: "start", script: { start: [{ type: "scene", objects: [object] }, { type: "say", id: "inspect", text: "Inspect." }] } }));
  try {
    mkdirSync(join(project, "art"));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "app.tsx"), 'throw new Error("a rejected object project must never compile or run this entry");');
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {} }));
    const object = { id: "letter", image: "missing-letter", frame: { x: 0.1, y: 0.1, w: 0.4, h: 0.3 } };
    writeStory(object);
    await expect(buildGuest({ projectRoot: project, outDir: output })).rejects.toThrow("script.start[0].objects[0].image references unknown background 'missing-letter'");
    expect(existsSync(join(output, "app.qjbc"))).toBe(false);
    writeStory({ ...object, crop: { x: 0, y: 0, w: Number.MIN_VALUE, h: 0.5 } });
    await expect(buildGuest({ projectRoot: project, outDir: output })).rejects.toThrow(/crop/);
    writeStory({ ...object, interaction: { label: "Inspect", effects: [{ type: "jump", target: "start" }] } });
    await expect(buildGuest({ projectRoot: project, outDir: output })).rejects.toThrow(/effects/);
    expect(existsSync(output)).toBe(false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
