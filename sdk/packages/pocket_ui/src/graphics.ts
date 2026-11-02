/**
 * Pure JavaScript graphics helpers adapted from the retained PocketJS demo.
 *
 * Provenance:
 * `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_graphics.js`.
 *
 * These functions only calculate deterministic draw-command data. They do not
 * create a Scene, talk to FFI, allocate a native surface, or claim that a
 * 3D/physics runtime is present. Callers may feed the returned commands into
 * an existing Pocket draw-list surface when one is available.
 */

export const POCKET_GRAPHICS_VERSION = "0.1.0";
export const MAX_PARTICLE_COUNT = 4096;

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

export type GraphicsColor = number;

export interface DrawLineCommand {
  readonly op: "line";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly strokeW: number;
  readonly color: GraphicsColor;
}

export interface DrawArcCommand {
  readonly op: "arc";
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly color: GraphicsColor;
}

export type GraphicsDrawCommand = DrawLineCommand | DrawArcCommand;

export interface MechaEntity {
  readonly slot: number;
  readonly entityId: number;
  readonly tx: number;
  readonly ty: number;
  readonly tz: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  readonly rw: number;
}

export interface MechaFrame {
  readonly entities: readonly MechaEntity[];
  readonly drawCommands: readonly GraphicsDrawCommand[];
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function pitchScale(touchPitchDeg: number): number {
  return Math.max(0.45, Math.min(1.55, 1.0 + finite(touchPitchDeg, 0) * 0.008));
}

/**
 * Calculates the old demo's six-node orbit and wireframe overlay.
 *
 * The `3d` in the compatibility name describes the output's transform fields;
 * this is a CPU math helper, not a 3D renderer or physics implementation.
 */
export function compute3dMechaFrame(
  animTimeSec: number,
  touchYawDeg = 0.0,
  touchPitchDeg = 0.0,
): MechaFrame {
  const time = finite(animTimeSec, 0);
  const yawOffset = (finite(touchYawDeg, 0) * Math.PI) / 180.0;
  const scale = pitchScale(touchPitchDeg);
  const entities: MechaEntity[] = [];
  const drawCommands: GraphicsDrawCommand[] = [];
  const cx = 185.0;
  const cy = 92.0;

  for (let i = 0; i < 6; i += 1) {
    const angle = time * 1.6 + yawOffset + i * (Math.PI / 3.0);
    entities.push({
      slot: i,
      entityId: 100 + i,
      tx: Math.cos(angle) * 2.5,
      ty: Math.sin(time * 2.0 + i) * 0.8 * scale,
      tz: Math.sin(angle) * 2.5,
      rx: 0.0,
      ry: Math.sin(angle * 0.5),
      rz: 0.0,
      rw: Math.cos(angle * 0.5),
    });

    const firstAngle = time * 1.5 + yawOffset + i * (Math.PI / 3.0);
    const nextAngle = time * 1.5 + yawOffset + ((i + 1) % 6) * (Math.PI / 3.0);
    const x1 = cx + Math.cos(firstAngle) * 72.0;
    const y1 = cy + Math.sin(firstAngle) * 44.0 * scale;
    const x2 = cx + Math.cos(nextAngle) * 72.0;
    const y2 = cy + Math.sin(nextAngle) * 44.0 * scale;
    drawCommands.push({
      op: "line",
      x1,
      y1,
      x2,
      y2,
      strokeW: 2.4,
      color: 0xff38bdf8,
    });
    drawCommands.push({
      op: "arc",
      x: x1,
      y: y1,
      r: 6.8,
      color: i % 2 === 0 ? 0xff22c55e : 0xffa855f7,
    });
  }

  return { entities, drawCommands };
}

/**
 * Calculates the old demo's deterministic 2D particle commands.
 *
 * The result can be serialized into an existing draw-list surface. It does
 * not itself schedule frames or imply a native particle engine.
 */
export function compute2dParticleFrame(
  animTimeSec: number,
  particleCount = 28,
  touchYawDeg = 0.0,
  touchPitchDeg = 0.0,
): readonly DrawArcCommand[] {
  const time = finite(animTimeSec, 0);
  const yawOffset = (finite(touchYawDeg, 0) * Math.PI) / 180.0;
  const scale = pitchScale(touchPitchDeg);
  const count = Math.max(0, Math.min(MAX_PARTICLE_COUNT, Math.floor(finite(particleCount, 0))));
  const drawCommands: DrawArcCommand[] = [];

  for (let i = 0; i < count; i += 1) {
    const phase = time * 1.8 + yawOffset + i * 0.45;
    const x = 28.0 + ((i * 29) % 310) + Math.sin(phase) * 16.0;
    const y = 30.0 + ((i * 19) % 120) + Math.cos(phase * 1.2) * 12.0 * scale;
    const r = 4.0 + (i % 5) * 1.8;
    const color = i % 3 === 0 ? 0xff38bdf8 : i % 3 === 1 ? 0xffa855f7 : 0xff22c55e;
    drawCommands.push({ op: "arc", x, y, r, color });
  }
  return drawCommands;
}
