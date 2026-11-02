/**
 * Small, source-backed adapters from the original demo's pure JS libraries.
 *
 * Provenance:
 * - `mini_apps/syslib/pocket_syslib_router.js` (`TRANSITION_MODES`,
 *   `computeTransitionDescriptor`)
 * - `mini_apps/pocketjs_uikit.js` (`smoothStep`, SDF helpers and
 *   `buildLiquidGlassPrimitiveProps`)
 *
 * The original modules also contain Dart/C-FFI assumptions and are therefore
 * intentionally not imported wholesale by this independent guest package.
 */

export type TransitionMode =
  | "IOS_SPRING_PARALLAX"
  | "SHARED_AXIS_Z"
  | "LIQUID_GLASS_MORPH"
  | "PORTAL_EXPAND";

export interface TransitionDescriptor {
  inTx: number;
  inTy: number;
  inScale: number;
  outTx: number;
  outTy: number;
  outScale: number;
  easedT: number;
}

export const TRANSITION_MODES: readonly TransitionMode[] = [
  "IOS_SPRING_PARALLAX",
  "SHARED_AXIS_Z",
  "LIQUID_GLASS_MORPH",
  "PORTAL_EXPAND",
];

/** Adapted from old `computeTransitionDescriptor` with the same math. */
export function computeTransitionDescriptor(
  mode: TransitionMode,
  rawProgress: number,
  isReverse = false,
  viewportWidth = 360,
): TransitionDescriptor {
  const p = Math.max(0, Math.min(1, rawProgress));
  const inv = 1 - p;
  const t = 1 - inv * inv * inv;
  if (mode === "IOS_SPRING_PARALLAX") {
    return !isReverse
      ? { inTx: viewportWidth * (1 - t), inTy: 0, inScale: 1, outTx: -viewportWidth * 0.28 * t, outTy: 0, outScale: 1, easedT: t }
      : { inTx: -viewportWidth * 0.28 * (1 - t), inTy: 0, inScale: 1, outTx: viewportWidth * t, outTy: 0, outScale: 1, easedT: t };
  }
  if (mode === "SHARED_AXIS_Z") {
    return !isReverse
      ? { inTx: viewportWidth * (1 - t), inTy: 64 * (1 - t), inScale: 1, outTx: -viewportWidth * 0.52 * t, outTy: -44 * t, outScale: 1, easedT: t }
      : { inTx: -viewportWidth * 0.52 * (1 - t), inTy: -44 * (1 - t), inScale: 1, outTx: viewportWidth * t, outTy: 64 * t, outScale: 1, easedT: t };
  }
  if (mode === "PORTAL_EXPAND") {
    return !isReverse
      ? { inTx: viewportWidth * (1 - t), inTy: 140 * (1 - t), inScale: 1, outTx: -viewportWidth * 0.25 * t, outTy: -68 * t, outScale: 1, easedT: t }
      : { inTx: -viewportWidth * 0.25 * (1 - t), inTy: -68 * (1 - t), inScale: 1, outTx: viewportWidth * t, outTy: 140 * t, outScale: 1, easedT: t };
  }
  const wave = Math.sin(t * Math.PI);
  return !isReverse
    ? { inTx: viewportWidth * (1 - t), inTy: -32 * wave, inScale: 1, outTx: -viewportWidth * 0.38 * t, outTy: 22 * wave, outScale: 1, easedT: t }
    : { inTx: -viewportWidth * 0.38 * (1 - t), inTy: 22 * wave, inScale: 1, outTx: viewportWidth * t, outTy: -32 * wave, outScale: 1, easedT: t };
}

export type GlassShape = "rounded" | "circle" | "pill";

export interface LiquidGlassRecipe {
  shape: GlassShape;
  radius: number;
  blurSigma: number;
  warp: boolean;
  tintOpacity: number;
  edgeIntensity: number;
  rimIntensity: number;
  baseIntensity: number;
  cornerBoost: number;
  rippleEffect: number;
  bgColors: readonly number[];
  bgStops: readonly number[];
  shadowColor: number;
  shadowBlur: number;
  /** The shader math result for a representative UV, useful for tests/UI copy. */
  sample: { u: number; v: number; sdf: number; totalRefraction: number; rimLight: number };
}

function smoothStep(a: number, b: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

function roundedRectSdf(x: number, y: number, halfW: number, halfH: number, radius: number): number {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

function circleSdf(x: number, y: number, radius = 0.45): number {
  return Math.hypot(x, y) - radius;
}

function pillSdf(x: number, y: number, halfW = 0.46, halfH = 0.42): number {
  const radius = Math.min(halfW, halfH);
  const lineHalf = Math.max(0, halfW - radius);
  const px = Math.abs(x) - Math.min(Math.abs(x), lineHalf);
  return Math.hypot(px, y) - radius;
}

function fragmentSample(
  u: number,
  v: number,
  shape: GlassShape,
  controls: Pick<LiquidGlassRecipe, "edgeIntensity" | "rimIntensity" | "baseIntensity" | "cornerBoost" | "rippleEffect">,
): LiquidGlassRecipe["sample"] {
  const ix = u - 0.5;
  const iy = v - 0.5;
  const sdf = shape === "circle"
    ? circleSdf(ix, iy)
    : shape === "pill"
      ? pillSdf(ix, iy)
      : roundedRectSdf(ix, iy, 0.45, 0.42, 0.22);
  const distFromEdge = Math.max(0, -sdf);
  const centerDist = Math.hypot(ix, iy);
  const edgeFalloff = Math.exp(-distFromEdge / 0.15);
  const rimFalloff = Math.exp(-distFromEdge / 0.8);
  const baseFalloff = Math.exp(-centerDist / 0.1);
  const cornerDist = Math.hypot(Math.abs(ix) - 0.36, Math.abs(iy) - 0.34);
  const cornerFactor = Math.exp(-cornerDist / 0.14) * controls.cornerBoost;
  const ripple = Math.sin(u * 14 + v * 5) * Math.cos(v * 14 - u * 5) * controls.rippleEffect * 0.025;
  const displacement = smoothStep(0.8, 0, sdf - 0.12);
  const lensPull = smoothStep(0, 1, displacement);
  const totalRefraction = (1 - lensPull) * 0.24
    + controls.edgeIntensity * edgeFalloff * 2.2
    + controls.rimIntensity * rimFalloff * 0.55
    + controls.baseIntensity * baseFalloff * 2.5
    + cornerFactor + ripple;
  const scale = 1 - totalRefraction;
  return {
    u: ix * scale + 0.5,
    v: iy * scale + 0.5,
    sdf,
    totalRefraction,
    rimLight: controls.rimIntensity * rimFalloff + cornerFactor * 1.2,
  };
}

/**
 * Adapted from `buildLiquidGlassPrimitiveProps`. The current host's public
 * style ABI has gradients/rings but no blur/refraction surface op, so callers
 * must present this as a recipe and not claim native backdrop blur.
 */
export function buildLiquidGlassRecipe(options: {
  shape?: GlassShape;
  focused?: boolean;
  nested?: boolean;
  warp?: boolean;
  tintOpacity?: number;
} = {}): LiquidGlassRecipe {
  const shape = options.shape ?? "rounded";
  const focused = options.focused === true;
  const nested = options.nested === true;
  const warp = options.warp === true;
  const tintOpacity = Math.max(0.04, Math.min(0.65, options.tintOpacity ?? 0.16));
  const edgeIntensity = 0.015;
  const rimIntensity = 0.05;
  const baseIntensity = 0.01;
  const cornerBoost = 0.02;
  const rippleEffect = 0.08;
  const topAlpha = Math.round(tintOpacity * 1.15 * 255) & 0xff;
  const midAlpha = Math.round(tintOpacity * 0.45 * 255) & 0xff;
  const bottomAlpha = Math.round(tintOpacity * 0.85 * 255) & 0xff;
  const radius = shape === "circle" || shape === "pill" ? 999 : 22;
  const recipe = {
    shape,
    radius,
    blurSigma: Number((5 * (nested ? 1.1 : 1.5)).toFixed(1)),
    warp,
    tintOpacity,
    edgeIntensity,
    rimIntensity,
    baseIntensity,
    cornerBoost,
    rippleEffect,
    bgColors: [
      (topAlpha << 24) | 0x00ffffff,
      (midAlpha << 24) | 0x00ffffff,
      (bottomAlpha << 24) | 0x00ffffff,
    ],
    bgStops: [0, 0.52, 1],
    shadowColor: 0x33000000,
    shadowBlur: focused ? 24 : 18,
    sample: undefined as LiquidGlassRecipe["sample"] | undefined,
  };
  recipe.sample = fragmentSample(0.22, 0.34, shape, recipe);
  return recipe as LiquidGlassRecipe;
}

