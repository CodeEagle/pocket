import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const expectedTargets = [
  "devices/3ds/pocket-3ds-pica/src/driver.c",
  "devices/gles/pocket-gles/src/geometry.rs",
  "devices/gles/pocket-gles/src/lib.rs",
  "devices/gles/pocket-gles/src/tests.rs",
  "devices/psp/pocket-psp-render/src/encode.rs",
  "devices/psp/pocket-psp-render/src/tests.rs",
  "devices/vita/pocket-vita-render/src/geometry.rs",
  "devices/vita/pocket-vita-render/src/lib.rs",
  "devices/vita/pocket-vita-render/src/tests.rs",
  "devices/web/pocket-web-render/src/batch.rs",
  "devices/web/pocket-web-render/src/lib.rs",
  "devices/web/pocket-web-render/tests/gpu.rs",
  "engine/backends/gpui/src/render.rs",
];

test("float mesh backend patch applies after the core subpixel patch and round-trips", () => {
  const sdk = resolve(import.meta.dir, "../..");
  const cache = join(sdk, ".cache/pocketjs");
  const patch = readFileSync(join(sdk, "native/patches/image-mesh-subpixel-backends.patch"), "utf8");
  const targets = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!);
  expect(targets.sort()).toEqual([...expectedTargets].sort());

  const temporary = mkdtempSync(join(tmpdir(), "pocket-float-mesh-backends-"));
  try {
    for (const target of targets) {
      const path = join(temporary, target);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(cache, target)));
    }
    const apply = (...args: string[]) => spawnSync(
      "patch",
      ["--batch", "--fuzz=0", "-p1", ...args],
      { cwd: temporary, input: patch, encoding: "utf8" },
    );
    const reverse = apply("--reverse");
    expect(reverse.status, reverse.stdout + reverse.stderr).toBe(0);
    const forward = apply("--forward");
    expect(forward.status, forward.stdout + forward.stderr).toBe(0);
    for (const target of targets) {
      expect(readFileSync(join(temporary, target))).toEqual(readFileSync(join(cache, target)));
    }
    expect(apply("--reverse", "--dry-run").status).toBe(0);

    const pica = readFileSync(join(cache, expectedTargets[0]!), "utf8");
    expect(pica).toContain("POCKET_DRAW_OP_TEX_TRI_FLOAT");
    expect(pica).toContain("op.word_count < 15");
    expect(pica).toContain("word_float(w[at]) * scale");
    expect(pica).toContain("POCKET_DRAW_OP_TEX_TRI_REPEAT_FLOAT");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
