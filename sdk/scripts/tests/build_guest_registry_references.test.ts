import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

test("buildGuest rejects unresolved VN references and invalid conditions before emitting a Guest", async () => {
  const sdkRoot = resolve(import.meta.dir, "../..");
  const project = mkdtempSync(join(tmpdir(), "pocket-build-guest-vn-registry-"));
  const output = join(project, "out");
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({
      dependencies: { "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}` },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "fixture.vn-registry-validation",
      app: { entry: "app.tsx", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      pocket: 2,
      id: "fixture.vn-registry-validation",
      capabilities: { requires: [], optional: [] },
    }));
    writeFileSync(join(project, "novel.assets.json"), JSON.stringify({ backgrounds: {}, characters: {}, cgs: {}, audio: {} }));
    writeFileSync(join(project, "app.tsx"), "export {};\n");

    const buildRejected = async (story: unknown, expected: RegExp): Promise<void> => {
      writeFileSync(join(project, "story.json"), `${JSON.stringify(story, null, 2)}\n`);
      await assert.rejects(buildGuest({ projectRoot: project, outDir: output }), expected);
      assert.equal(existsSync(join(output, "app.qjbc")), false, "rejected story references must not produce a Guest bytecode file");
      assert.equal(existsSync(join(output, "guest-manifest.json")), false, "rejected stories must not leave a build manifest");
    };

    await buildRejected({
      id: "missing-voice-cue",
      version: 1,
      start: "start",
      script: { start: [
        { type: "say", id: "line", voice: "missing_voice", text: "Hello." },
        { type: "ending", id: "end" },
      ] },
    }, /script\.start\[0\]\.voice: Unknown dialogue voice audio cue asset key/);

    await buildRejected({
      id: "missing-background-key",
      version: 1,
      start: "start",
      script: { start: [
        { type: "scene", background: "missing_background" },
        { type: "ending", id: "end" },
      ] },
    }, /script\.start\[0\]\.background: Unknown background asset key/);

    await buildRejected({
      id: "invalid-condition",
      version: 1,
      start: "start",
      script: {
        start: [{ type: "branch", when: { op: "xor" }, then: "end", else: "end" }],
        end: [{ type: "ending", id: "complete" }],
      },
    }, /invalid inventory\/story: .*start\[0\]\.when\.op is unsupported/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
