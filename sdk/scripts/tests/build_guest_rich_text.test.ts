import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuest } from "../build_guest.ts";

test("a standalone rich-text consumer rejects malformed annotations before compiling its entry", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-rich-build-negative-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" } }));
    writeFileSync(join(project, "app.tsx"), 'throw new Error("invalid rich annotations must be rejected before compiling");');
    for (const [text, rich] of [
      ["A🌊B", { spans: [{ id: "outside", start: 0, end: 5, ruby: "test" }], pauses: [] }],
      ["A🌊B", { spans: [{ id: "duplicate", start: 0, end: 1, ruby: "A" }], pauses: [{ id: "duplicate", at: 1, durationMs: null }] }],
      ["A🌊B", { spans: [], pauses: [{ id: "bad-duration", at: 1, durationMs: -1 }] }],
      ["A{{name}}B", { spans: [{ id: "split-token", start: 2, end: 4, ruby: "invalid" }], pauses: [] }],
      ["A{{name}}B", { spans: [], pauses: [{ id: "split-token-pause", at: 3, durationMs: null }] }],
    ]) {
      writeFileSync(join(project, "story.json"), JSON.stringify({ id: "rich-build", version: 1, start: "start", script: { start: [{ type: "say", id: "rich-line", text, rich }] } }));
      await expect(buildGuest({ projectRoot: project, outDir: output })).rejects.toThrow(/rich|span|pause|code.point|annotation/i);
      expect(existsSync(output)).toBe(false);
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
});
