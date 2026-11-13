import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("subpixel mesh patch applies and reverses over the retained-mesh cache", () => {
  const sdk = resolve(import.meta.dir, "../..");
  const meshPatch = readFileSync(join(sdk, "native/patches/image-mesh-subpixel.patch"), "utf8");
  const fontPatch = readFileSync(join(sdk, "native/patches/host-native-fonts.patch"), "utf8");
  const drawFile = "engine/core/src/draw.rs";
  const sectionFor = (patch: string, target: string) => {
    const starts = [...patch.matchAll(/^diff --git /gm)].map(match => match.index!);
    for (let i = 0; i < starts.length; i++) {
      const section = patch.slice(starts[i], starts[i + 1] ?? patch.length);
      if (section.includes(`+++ b/${target}`)) return section;
    }
    throw new Error(`patch does not contain ${target}`);
  };
  const patches = [sectionFor(meshPatch, drawFile), sectionFor(fontPatch, drawFile)];
  const temporary = join(tmpdir(), `pocket-mesh-subpixel-${process.pid}-${Date.now()}`);
  try {
    const path = join(temporary, drawFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(sdk, ".cache/pocketjs", drawFile)));
    const runPatch = (patch: string, direction: "forward" | "reverse") => spawnSync(
      "patch",
      ["--batch", "--fuzz=0", "--forward", ...(direction === "reverse" ? ["--reverse"] : []), "-p1"],
      { cwd: temporary, input: patch, encoding: "utf8" },
    );
    const frozen = readFileSync(path);
    const source = readFileSync(join(sdk, ".cache/pocketjs/contracts/spec/spec.ts"), "utf8");
    expect(source).toContain("export const DRAW_LIST_VERSION = 5;");
    expect(source).toContain("texTriFloat: 15,");
    expect(source).toContain("texTriRepeatFloat: 16,");
    expect(source).toContain("TEXT_RUN_FLAG_TRACKING");
    expect(source).toContain("TEXT_RUN_FLAG_AFFINE");

    // Exercise the shared Core file so newer DrawList version bumps elsewhere
    // in the full patch series do not obscure the interaction between these
    // two layers. The fonts patch is later in bootstrap order and must be
    // removed before the earlier subpixel patch.
    const reverseFonts = runPatch(patches[1]!, "reverse");
    expect(reverseFonts.status, reverseFonts.stdout + reverseFonts.stderr).toBe(0);
    expect(reverseFonts.stdout + reverseFonts.stderr).not.toMatch(/ignored|skipping|failed/i);
    const withoutFonts = readFileSync(path, "utf8");
    expect(withoutFonts).not.toContain("uses_native_for(");
    expect(withoutFonts).toContain("emit_mesh_tex_tri(");

    const reverseMesh = runPatch(patches[0]!, "reverse");
    expect(reverseMesh.status, reverseMesh.stdout + reverseMesh.stderr).toBe(0);
    expect(reverseMesh.stdout + reverseMesh.stderr).not.toMatch(/ignored|skipping|failed/i);
    const withoutMesh = readFileSync(path, "utf8");
    expect(withoutMesh).not.toContain("emit_mesh_tex_tri(");

    // Reapply in bootstrap order and compare all touched files byte for byte.
    const reapplyMesh = runPatch(patches[0]!, "forward");
    expect(reapplyMesh.status, reapplyMesh.stdout + reapplyMesh.stderr).toBe(0);
    expect(reapplyMesh.stdout + reapplyMesh.stderr).not.toMatch(/ignored|skipping|failed/i);
    const reapplyFonts = runPatch(patches[1]!, "forward");
    expect(reapplyFonts.status, reapplyFonts.stdout + reapplyFonts.stderr).toBe(0);
    expect(reapplyFonts.stdout + reapplyFonts.stderr).not.toMatch(/ignored|skipping|failed/i);
    expect(readFileSync(path)).toEqual(frozen);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
