import { test, expect } from "bun:test";
import { POCKET_SVG_ICON_SPECS } from "../src/graphics.ts";

test("retained SVG specs are immutable vector assets", () => {
  expect(Object.keys(POCKET_SVG_ICON_SPECS).sort()).toEqual([
    "bleRadar", "cameraShutter", "trackpadRings", "weatherSunCloud",
  ]);
  for (const spec of Object.values(POCKET_SVG_ICON_SPECS)) {
    expect(spec.svgXml).toMatch(/^<svg[\s>]/);
    expect(Object.isFrozen(spec)).toBe(true);
  }
  expect(POCKET_SVG_ICON_SPECS.bleRadar.runePoints?.length).toBe(6);
});
