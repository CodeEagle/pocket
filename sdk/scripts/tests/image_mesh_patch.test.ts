import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("mesh patch applies to the pinned predecessor and is repeatably detectable", () => {
  const sdk = resolve(import.meta.dir, "../..");
  const bootstrap = readFileSync(join(sdk, "scripts/prepare_upstream.py"), "utf8");
  const patchList = bootstrap.slice(bootstrap.indexOf("PATCHES = ("), bootstrap.indexOf("SUPERSEDED_PATCH_MARKERS ="));
  const names = [...patchList.matchAll(/\("([^"]+\.patch)",/g)].map(match => match[1]!);
  const laterPatchNames = names.slice(names.indexOf("image-mesh.patch") + 1);
  const sources = ["image-mesh.patch", ...laterPatchNames].map(name => ({
    name,
    source: readFileSync(join(sdk, "native/patches", name), "utf8"),
  }));
  const baseTargets = new Set([...sources[0]!.source.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!));
  // Replay only the retained-mesh contract's files. Later patches also add
  // independent tests/resources whose subsequent successors are outside this
  // chain (for example high-resolution IMG assertions in core/tests.rs).
  const patches = sources.map(({ name, source }) => ({ name, source: source
    .split(/^diff --git /m.test(source) ? /(?=^diff --git )/m : /(?=^--- a\/)/m)
    .filter(section => baseTargets.has(section.match(/^\+\+\+ b\/(.+)$/m)?.[1] ?? ""))
    .join("") }));
  const temporary = mkdtempSync(join(tmpdir(), "pocket-mesh-patch-"));
  try {
    const targets = [...new Set(patches.flatMap(({ source }) =>
      [...source.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!)))];
    for (const target of targets) {
      const path = join(temporary, target);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(sdk, ".cache/pocketjs", target)));
    }
    const frozen = new Map(targets.map(target => [target, readFileSync(join(temporary, target))]));
    const apply = (source: string, reverse = false, dryRun = false) => spawnSync(
      "patch",
      ["--batch", "--fuzz=0", reverse ? "--reverse" : "--forward", ...(dryRun ? ["--dry-run"] : []), "-p1"],
      { cwd: temporary, input: source, encoding: "utf8" },
    );

    // Later versioned changes overlap the same spec/core files. Remove them
    // in reverse bootstrap order before checking the original retained-mesh
    // patch against its actual predecessor.
    for (const { source } of [...patches.slice(1)].reverse()) {
      const result = apply(source, true);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    const reverseBase = apply(patches[0]!.source, true);
    expect(reverseBase.status, reverseBase.stdout + reverseBase.stderr).toBe(0);
    const predecessor = readFileSync(join(temporary, "contracts/spec/spec.ts"), "utf8");
    expect(predecessor).toContain("export const DRAW_LIST_VERSION = 1;");

    for (const { source } of patches) {
      const result = apply(source);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    for (const target of targets) expect(readFileSync(join(temporary, target))).toEqual(frozen.get(target));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
