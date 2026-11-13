import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import module from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = (import.meta as { dir?: string }).dir ?? resolve(fileURLToPath(import.meta.url), "..");
const packageRoot = resolve(testDir, "..");
const srcDir = join(packageRoot, "src");
const upstreamCandidates = [
  resolve(packageRoot, "../../.cache/pocketjs"),
  resolve(packageRoot, "../../../../../FPKit/pocket/sdk/.cache/pocketjs"),
];
const upstreamDir = upstreamCandidates.find((p) => existsSync(join(p, "package.json"))) ?? upstreamCandidates[0]!;
const reqUpstream = module.createRequire(join(upstreamDir, "package.json"));

if (typeof module.registerHooks === "function") {
  let inHook = false;
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@pocketjs/framework/solid/lifecycle") {
        return {
          url: pathToFileURL(join(upstreamDir, "framework/src/lifecycle.ts")).href,
          shortCircuit: true,
        };
      }
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (!inHook && !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:")) {
          inHook = true;
          try {
            return { url: pathToFileURL(reqUpstream.resolve(specifier)).href, shortCircuit: true };
          } finally {
            inHook = false;
          }
        }
        throw err;
      }
    },
  });
}

const { ARC_ALL_ACCENTS, concentricInnerRadius, resolveArcPalette } = await import("../src/tokens.ts");
const { ARC_SPRINGS, stepArcSpring } = await import("../src/motion.ts");
const { parseClassLiteral, unknownUtilities } = await import("../../../.cache/pocketjs/framework/compiler/tailwind.ts");

export function runArcPackageTests(): void {
  assert.equal(concentricInnerRadius(22, 6), 16);
  assert.equal(concentricInnerRadius(16, 6), 10);
  assert.equal(concentricInnerRadius(10, 20, 4), 4);
  assert.equal(concentricInnerRadius(Number.NaN, 6, 4), 4);
  assert.equal(concentricInnerRadius(16, -5, 4), 16);

  for (const acc of ARC_ALL_ACCENTS) {
    const light = resolveArcPalette("light", acc);
    const dark = resolveArcPalette("dark", acc);
    assert.equal(light.mode, "light");
    assert.equal(dark.mode, "dark");
    assert.equal(light.accentName, acc);
    assert.equal(dark.accentName, acc);
    assert.notEqual(light.background, dark.background);
    assert.equal(light.radiusControl, 10);
    assert.equal(light.radiusSurface, 16);
    assert.equal(light.radiusPanel, 22);
  }

  const fallback = resolveArcPalette("light", "invalid_accent" as any);
  assert.equal(fallback.accentName, "coral");

  const amber = resolveArcPalette("amber-night", "violet");
  assert.equal(amber.mode, "amber-night");
  const checkZeroBlue = (hex: string, key: string) => {
    if (!hex.startsWith("#") || hex.length < 7) return;
    assert.equal(hex.slice(5, 7).toUpperCase(), "00", `Expected 00 blue channel for ${key}: ${hex}`);
  };
  for (const [k, v] of Object.entries(amber)) {
    if (typeof v === "string") checkZeroBlue(v, k);
    else if (v && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (typeof sv === "string") checkZeroBlue(sv, `${k}.${sk}`);
      }
    }
  }

  const rm = stepArcSpring({ value: 0, velocity: 12, settled: false }, 1, 0.016, ARC_SPRINGS.calm, true);
  assert.deepEqual(rm, { value: 1, velocity: 0, settled: true });

  const zeroDt = stepArcSpring({ value: 0.2, velocity: 0, settled: false }, 1, 0, ARC_SPRINGS.calm, false);
  assert.equal(zeroDt.value, 0.2);
  assert.equal(zeroDt.settled, false);
  const nanTarget = stepArcSpring({ value: 0.5, velocity: 3, settled: false }, Number.NaN, 0.016);
  assert.deepEqual(nanTarget, { value: 0.5, velocity: 0, settled: true });

  const spike = stepArcSpring({ value: 0, velocity: 0, settled: false }, 1, 5.0, ARC_SPRINGS.snappy, false);
  assert.ok(Number.isFinite(spike.value) && spike.value > 0 && spike.value < 1.5);

  for (const presetName of ["calm", "snappy", "gentle", "soft"] as const) {
    let st = { value: 0, velocity: 0, settled: false };
    for (let f = 0; f < 90 && !st.settled; f++) {
      st = stepArcSpring(st, 100, 1 / 60, ARC_SPRINGS[presetName], false);
    }
    assert.equal(st.settled, true, `Preset ${presetName} should settle cleanly`);
    assert.equal(st.value, 100);
    assert.equal(st.velocity, 0);
  }

  assert.equal(existsSync(join(packageRoot, "package.json")), true);
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
  assert.ok(files.length >= 7);
  for (const file of files) {
    const content = readFileSync(join(srcDir, file), "utf8");
    for (const m of content.matchAll(/\bclass="([^"]+)"/g)) {
      const lit = m[1]!;
      assert.deepEqual(unknownUtilities(lit), [], `Unknown utility in ${file}: ${lit}`);
      assert.notEqual(parseClassLiteral(lit), null);
    }
  }
}

runArcPackageTests();
console.log("@pocket/arc unit & boundary tests passed!");
