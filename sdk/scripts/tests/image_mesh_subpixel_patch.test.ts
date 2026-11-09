import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("subpixel mesh patch applies and reverses over the retained-mesh cache", () => {
  const sdk = resolve(import.meta.dir, "../..");
  const patch = readFileSync(join(sdk, "native/patches/image-mesh-subpixel.patch"), "utf8");
  const temporary = join(tmpdir(), `pocket-mesh-subpixel-${process.pid}-${Date.now()}`);
  const targets = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!);
  try {
    for (const target of targets) {
      const path = join(temporary, target);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(sdk, ".cache/pocketjs", target)));
    }
    const runPatch = (direction: "forward" | "reverse") => spawnSync(
      "patch",
      ["--batch", "--fuzz=0", direction === "reverse" ? "--reverse" : "--forward", "-p1"],
      { cwd: temporary, input: patch, encoding: "utf8" },
    );
    const frozen = new Map(targets.map(target => [target, readFileSync(join(temporary, target))]));
    const source = readFileSync(join(temporary, "contracts/spec/spec.ts"), "utf8");
    expect(source).toContain("export const DRAW_LIST_VERSION = 3;");
    expect(source).toContain("texTriFloat: 15,");
    expect(source).toContain("texTriRepeatFloat: 16,");

    // The shared pinned cache is already patched during development. Rebuild
    // the clean predecessor in this isolated target set, then prove the patch
    // deterministically restores the exact cached source.
    const reverse = runPatch("reverse");
    expect(reverse.status, reverse.stdout + reverse.stderr).toBe(0);
    const predecessor = readFileSync(join(temporary, "contracts/spec/spec.ts"), "utf8");
    expect(predecessor).not.toContain("texTriFloat: 15,");
    const reapply = runPatch("forward");
    expect(reapply.status, reapply.stdout + reapply.stderr).toBe(0);
    for (const target of targets) {
      expect(readFileSync(join(temporary, target))).toEqual(frozen.get(target));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
