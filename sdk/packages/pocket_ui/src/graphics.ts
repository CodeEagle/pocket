/**
 * Pure JavaScript graphics helpers adapted from the retained PocketJS demo.
 *
 * Provenance:
 * `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js`.
 *
 * Only reusable SVG specifications are exported. Legacy line/arc command
 * producers were removed because the current renderer has no consumer for
 * those commands. This module does not claim a 3D or particle renderer.
 */

export const POCKET_GRAPHICS_VERSION = "0.1.0";

export interface SvgIconSpec {
  readonly svgXml: string;
  readonly [key: string]: unknown;
}

/** Declarative vector specs retained from the old weather/camera/BLE demos. */
export const POCKET_SVG_ICON_SPECS: Readonly<Record<string, SvgIconSpec>> = Object.freeze({
  weatherSunCloud: Object.freeze({
    svgXml:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="46" cy="44" r="18" fill="#FACC15"/><path d="M34 82H86C94.8 82 102 74.8 102 66C102 57.6 95.5 50.7 87.3 50C84.2 38.5 73.6 30 61 30C45.5 30 33 42.5 33 58C26.8 61.3 22 66.8 22 73.5C22 81.1 27.3 82 34 82Z" fill="#E0F2FE" stroke="#FFFFFF" stroke-width="1.5"/></svg>',
    sunCx: 0.38,
    sunCy: 0.36,
    sunGlowRadiusFactor: 0.55,
    sunCoreRadiusFactor: 0.34,
    sunColorArgb: 0xfffacc15,
    cloudCx: 0.54,
    cloudCy: 0.58,
    cloudWidthFactor: 0.62,
    cloudHeightFactor: 0.32,
  }),
  trackpadRings: Object.freeze({
    svgXml:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><circle cx="80" cy="80" r="60" stroke="#38BDF8" stroke-width="2" stroke-dasharray="8 6" fill="none"/><circle cx="80" cy="80" r="44" stroke="#EC4899" stroke-width="3.5" fill="none"/><circle cx="80" cy="80" r="28" fill="#0F172A" stroke="#38BDF8" stroke-width="1.8"/></svg>',
    outerRingFactor: 0.88,
    innerCoreFactor: 0.66,
    accentColorArgb: 0xff38bdf8,
  }),
  cameraShutter: Object.freeze({
    svgXml:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="42" stroke="#FFFFFF" stroke-width="4" fill="none"/><circle cx="48" cy="48" r="34" fill="#FFFFFF"/></svg>',
    outerRingFactor: 0.92,
    innerFillFactor: 0.74,
    colorArgb: 0xffffffff,
  }),
  bleRadar: Object.freeze({
    svgXml:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><path d="M28 34L68 62L48 80V16L68 34L28 62" stroke="#0284C7" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    ringFactor: 0.85,
    runePoints: Object.freeze([
      Object.freeze([-0.35, -0.28]),
      Object.freeze([0.35, 0.28]),
      Object.freeze([0.0, 0.62]),
      Object.freeze([0.0, -0.62]),
      Object.freeze([0.35, -0.28]),
      Object.freeze([-0.35, 0.28]),
    ]),
    colorArgb: 0xff0284c7,
  }),
});
