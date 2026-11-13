import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LOOSELEAF_AMBER_NIGHT_PALETTE,
  LOOSELEAF_DARK_PALETTE,
  LOOSELEAF_NOTEBOOK_PALETTE,
  accentColorOf,
  densityHitHeight,
  hashSeed,
  penColor,
  resolveLooseleafPalette,
  seedOffset,
  seedTilt,
  stockBackground,
} from "../src/tokens.ts";
import { parseClassLiteral, unknownUtilities } from "../../../.cache/pocketjs/framework/compiler/tailwind.ts";

const packageRoot = resolve(import.meta.dir, "..");
const srcDir = join(packageRoot, "src");

describe("@pocket/looseleaf standalone UI package", () => {
  test("exports deterministic seeded geometry & zero-tilt calm mode", () => {
    expect(hashSeed("home-notes")).toBe(hashSeed("home-notes"));
    expect(hashSeed("home-notes")).not.toBe(hashSeed("home-chart"));

    const comfortableTilt = seedTilt("home-card", 1.2, "comfortable");
    expect(Math.abs(comfortableTilt)).toBeLessThanOrEqual(1.2);
    expect(seedTilt("home-card", 1.2, "calm")).toBe(0);
    expect(seedOffset("home-btn", 2, "misreg", "calm")).toBe(0);

    expect(densityHitHeight("comfortable")).toBe(40);
    expect(densityHitHeight("compact")).toBe(34);
    expect(densityHitHeight("calm")).toBe(30);
  });

  test("resolves Notebook, Charcoal Dark, and 0% Blue-Light Amber Night palettes", () => {
    expect(resolveLooseleafPalette("notebook")).toBe(LOOSELEAF_NOTEBOOK_PALETTE);
    expect(resolveLooseleafPalette(false)).toBe(LOOSELEAF_NOTEBOOK_PALETTE);
    expect(resolveLooseleafPalette("dark")).toBe(LOOSELEAF_DARK_PALETTE);
    expect(resolveLooseleafPalette(true)).toBe(LOOSELEAF_DARK_PALETTE);
    expect(resolveLooseleafPalette("amber-night")).toBe(LOOSELEAF_AMBER_NIGHT_PALETTE);

    // Every hex color in LOOSELEAF_AMBER_NIGHT_PALETTE must keep 00 blue channel!
    for (const [key, value] of Object.entries(LOOSELEAF_AMBER_NIGHT_PALETTE)) {
      if (key === "mode" || typeof value !== "string" || !value.startsWith("#")) continue;
      const blueHex = value.slice(5, 7).toUpperCase();
      expect(blueHex).toBe("00");
    }

    expect(stockBackground(LOOSELEAF_NOTEBOOK_PALETTE, "card")).toBe("#FBF6E9");
    expect(stockBackground(LOOSELEAF_NOTEBOOK_PALETTE, "graph")).toBe("#F4F7EF");
    expect(penColor(LOOSELEAF_NOTEBOOK_PALETTE, "marker")).toBe("#DF6B3C");
    expect(penColor(LOOSELEAF_NOTEBOOK_PALETTE, "blue")).toBe("#2C4F9E");
    expect(accentColorOf(LOOSELEAF_NOTEBOOK_PALETTE, "sky")).toBe("#4AA8E8");
  });

  test("every JSX class literal in @pocket/looseleaf compiles cleanly under PocketJS --strict-classes", () => {
    expect(existsSync(join(packageRoot, "package.json"))).toBe(true);
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(7);

    const classAttrLiterals: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(srcDir, file), "utf8");
      // Match static class="..." and ternary branches inside class={...}
      const directMatches = content.matchAll(/\bclass="([^"]+)"/g);
      for (const m of directMatches) classAttrLiterals.push(`${file} :: ${m[1]!}`);

      const blockMatches = content.matchAll(/\bclass=\{([\s\S]*?)\}/g);
      for (const block of blockMatches) {
        const inner = block[1]!;
        for (const str of inner.matchAll(/"([^"]+)"/g)) {
          const val = str[1]!;
          // Skip prop comparisons like size() === "icon" or props.align === "end"
          if (!val.includes(" ") && !/^(flex|w-full|h-full|relative|absolute|items-|justify-|text-|p-|px-|py-)/.test(val)) {
            continue;
          }
          classAttrLiterals.push(`${file} :: ${val}`);
        }
      }
    }

    expect(classAttrLiterals.length).toBeGreaterThan(50);
    for (const entry of classAttrLiterals) {
      const literal = entry.split(" :: ")[1]!;
      const unknown = unknownUtilities(literal);
      expect(unknown).toEqual([]);
      const record = parseClassLiteral(literal);
      expect(record).not.toBeNull();
    }
  });
});
