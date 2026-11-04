import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import {
  nativeProbeSourceInputs,
  selectNativeProbe,
} from "../native_probe_path.ts";

function touch(path: string, mtimeMs: number): void {
  writeFileSync(path, "fixture");
  const time = new Date(mtimeMs);
  utimesSync(path, time, time);
}

test("default probe selection compares every native input and prefers the fresh candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-native-probe-path-"));
  try {
    const native = join(root, "native");
    const source = join(native, "src");
    const target = join(native, "target");
    const release = join(target, "release", "pocket_probe");
    const debug = join(target, "debug", "pocket_probe");
    const sourceA = join(source, "lib.rs");
    const sourceB = join(native, "Cargo.lock");
    mkdirSync(source, { recursive: true });
    mkdirSync(join(target, "release"), { recursive: true });
    mkdirSync(join(target, "debug"), { recursive: true });
    touch(sourceA, 1_000_000);
    touch(sourceB, 2_000_000);
    // This release candidate is newer than one source file but stale relative
    // to Cargo.lock. A path-exists or single-file mtime heuristic would pick it.
    touch(release, 1_500_000);
    touch(debug, 2_500_000);

    assert.equal(selectNativeProbe({
      candidates: [release, debug],
      sourceInputs: [source, sourceB],
    }), debug);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("freshness input discovery excludes target outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-native-probe-inputs-"));
  try {
    const source = join(root, "native", "src");
    const nestedTarget = join(source, "target");
    const lock = join(root, "native", "Cargo.lock");
    mkdirSync(nestedTarget, { recursive: true });
    touch(join(source, "lib.rs"), 1_000_000);
    touch(join(nestedTarget, "generated.rs"), 9_000_000);
    touch(lock, 2_000_000);

    const inputs = nativeProbeSourceInputs(root);
    assert.ok(inputs.some((path) => path.endsWith("native/src")));
    assert.ok(inputs.some((path) => path.endsWith("native/Cargo.lock")));
    assert.equal(inputs.some((path) => path.includes(`${join("native", "target")}/`)), false);
    const candidate = join(root, "native", "target", "debug", "pocket_probe");
    mkdirSync(join(root, "native", "target", "debug"), { recursive: true });
    touch(candidate, 2_500_000);
    assert.equal(selectNativeProbe({ candidates: [candidate], sourceInputs: [source, lock] }), candidate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale defaults fail clearly while an explicit missing override fails immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-native-probe-errors-"));
  try {
    const source = join(root, "native", "src");
    const candidate = join(root, "native", "target", "debug", "pocket_probe");
    mkdirSync(join(root, "native", "target", "debug"), { recursive: true });
    const input = join(source, "lib.rs");
    mkdirSync(source, { recursive: true });
    touch(input, 3_000_000);
    touch(candidate, 2_000_000);

    assert.throws(() => selectNativeProbe({
      candidates: [candidate],
      sourceInputs: [source],
    }), /No fresh default pocket_probe.*newest:/);
    assert.throws(() => selectNativeProbe({
      configuredPath: join(root, "missing", "pocket_probe"),
      candidates: [candidate],
      sourceInputs: [source],
    }), /POCKET_NATIVE_PROBE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
