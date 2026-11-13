import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("mesh patch applies to the pinned predecessor and is repeatably detectable", () => {
  const sdk = resolve(import.meta.dir, "../..");
  const drawTarget = "engine/core/src/draw.rs";
  const bootstrap = readFileSync(join(sdk, "scripts/prepare_upstream.py"), "utf8");
  const patchList = bootstrap.slice(bootstrap.indexOf("PATCHES = ("), bootstrap.indexOf("SUPERSEDED_PATCH_MARKERS ="));
  const names = [...patchList.matchAll(/\("([^"]+\.patch)",/g)].map(match => match[1]!);
  const patchNames = names.slice(names.indexOf("image-mesh.patch"));
  const allPatches = patchNames.map(name => readFileSync(join(sdk, "native/patches", name), "utf8"));
  const sectionFor = (source: string, target: string) => {
    const gitSections = [...source.matchAll(/^diff --git /gm)].map(match => match.index!);
    const starts = gitSections.length > 0
      ? gitSections
      : [...source.matchAll(/^--- a\/[^\n]+\n\+\+\+ b\//gm)].map(match => match.index!);
    for (let i = 0; i < starts.length; i++) {
      const section = source.slice(starts[i], starts[i + 1] ?? source.length);
      if (section.includes(`+++ b/${target}`)) return section;
    }
    return null;
  };
  const relevant = allPatches.flatMap((source, index) => {
    const patch = sectionFor(source, drawTarget);
    return patch === null ? [] : [{ name: patchNames[index]!, patch }];
  });
  const patches = relevant.map(item => item.patch);
  const temporary = join(tmpdir(), `pocket-mesh-patch-${process.pid}-${Date.now()}`);
  try {
    const path = join(temporary, drawTarget);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(sdk, ".cache/pocketjs", drawTarget)));
    const frozen = readFileSync(path);
    const source = readFileSync(join(sdk, ".cache/pocketjs/contracts/spec/spec.ts"), "utf8");
    expect(source).toContain("export const DRAW_LIST_VERSION = 5;");
    expect(source).toContain("texTriFloat: 15,");
    expect(source).toContain("TEXT_RUN_FLAG_TRACKING");
    const apply = (patch: string, reverse = false) => spawnSync(
      "patch",
      ["--batch", "--fuzz=0", "--forward", ...(reverse ? ["--reverse"] : []), "-p1"],
      { cwd: temporary, input: patch, encoding: "utf8" },
    );

    // Ablate all later layers that edit this Core file in reverse bootstrap
    // order. Other patch targets are validated by prepare_upstream.py and
    // their focused tests; including unrelated hunks here only creates false
    // conflicts when a later protocol legitimately supersedes old DrawList
    // version markers.
    for (let index = patches.length - 1; index > 0; index--) {
      const result = apply(patches[index]!, true);
      expect(result.status, `${relevant[index]!.name}: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/ignored|skipping|failed/i);
    }
    const reverseBase = apply(patches[0]!, true);
    expect(reverseBase.status, reverseBase.stdout + reverseBase.stderr).toBe(0);
    expect(reverseBase.stdout + reverseBase.stderr).not.toMatch(/ignored|skipping|failed/i);
    const predecessor = readFileSync(path, "utf8");
    expect(predecessor).not.toContain("fn emit_mesh(");
    expect(predecessor).not.toContain("fn emit_mesh_triangles(");

    for (const patch of patches) {
      const result = apply(patch);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).not.toMatch(/ignored|skipping|failed/i);
    }
    expect(readFileSync(path)).toEqual(frozen);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
