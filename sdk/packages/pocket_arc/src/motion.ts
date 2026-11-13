/**
 * @pocket/arc — Calm Motion Presets & Deterministic Spring Physics (`motion-tokens.ts`).
 *
 * Faithful to `kuratlielia/arc-library`:
 * - Shared spring presets (`calm`, `snappy`, `gentle`, `soft`) + duration tokens.
 * - Semi-implicit Euler spring solver with max-timestep clamping so background tab
 *   hiccups never explode velocity, snapping cleanly to `target` within epsilon.
 * - Every animation honors `reducedMotion`: when enabled, transitions jump/settle
 *   immediately without physical oscillation.
 */

import { createEffect, createSignal } from "solid-js";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";

export type ArcSpringPresetName = "calm" | "snappy" | "gentle" | "soft";

export interface ArcSpringConfig {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
  readonly precision?: number;
}

/** Canonical Arc motion springs (`lib/motion-tokens.ts`). */
export const ARC_SPRINGS: Readonly<Record<ArcSpringPresetName, ArcSpringConfig>> = {
  /** Gliding selection indicators, segmented control pills, height/panel morphs. */
  calm: { stiffness: 290, damping: 29, mass: 1.0, precision: 0.002 },
  /** Tactile switches, press-settle buttons, quick micro-confirmations. */
  snappy: { stiffness: 430, damping: 33, mass: 0.9, precision: 0.002 },
  /** Progress meters, activity rings, calm sheet & toast entrances. */
  gentle: { stiffness: 190, damping: 25, mass: 1.05, precision: 0.002 },
  /** Ambient background orbital rings & breathing glow. */
  soft: { stiffness: 120, damping: 20, mass: 1.2, precision: 0.002 },
};

export const ARC_DURATIONS_MS = {
  instant: 90,
  fast: 150,
  normal: 220,
  slow: 340,
} as const;

export interface ArcSpringState {
  readonly value: number;
  readonly velocity: number;
  readonly settled: boolean;
}

/**
 * Pure, deterministic single-step spring integrator (unit-testable across all edge cases).
 * Clamps `dtSec` to `[0, 0.05]` so dropped frames never cause numerical instability.
 */
export function stepArcSpring(
  current: ArcSpringState,
  target: number,
  dtSec: number,
  config: ArcSpringConfig = ARC_SPRINGS.calm,
  reducedMotion = false,
): ArcSpringState {
  if (!Number.isFinite(target)) {
    return { value: current.value, velocity: 0, settled: true };
  }
  if (!Number.isFinite(current.value) || reducedMotion) {
    return { value: target, velocity: 0, settled: true };
  }
  if (!Number.isFinite(dtSec) || dtSec <= 0) {
    const alreadyThere = Math.abs(target - current.value) <= (config.precision ?? 0.002);
    return alreadyThere
      ? { value: target, velocity: 0, settled: true }
      : { value: current.value, velocity: current.velocity, settled: false };
  }

  const safeDt = Math.min(0.05, dtSec);
  const mass = Math.max(0.1, config.mass);
  const stiffness = Math.max(1, config.stiffness);
  const damping = Math.max(0.1, config.damping);
  const precision = config.precision ?? 0.002;

  // Sub-step into <= 8ms slices for unconditional stability even at stiffness=430
  const subSteps = Math.max(1, Math.ceil(safeDt / 0.008));
  const h = safeDt / subSteps;

  let x = current.value;
  let v = Number.isFinite(current.velocity) ? current.velocity : 0;

  for (let i = 0; i < subSteps; i++) {
    const force = -stiffness * (x - target) - damping * v;
    const acc = force / mass;
    v += acc * h;
    x += v * h;
  }

  if (Math.abs(target - x) <= precision && Math.abs(v) <= precision * 6) {
    return { value: target, velocity: 0, settled: true };
  }
  return { value: x, velocity: v, settled: false };
}

/**
 * Reactive 60fps PocketJS spring signal that glides smoothly toward `target()`
 * and automatically pauses `onFrame` continuous ticking the moment it settles.
 */
export function createArcSpring(
  target: () => number,
  options: {
    preset?: ArcSpringPresetName;
    reducedMotion?: () => boolean;
  } = {},
): () => number {
  const initial = target();
  const [value, setValue] = createSignal(Number.isFinite(initial) ? initial : 0);
  const [settled, setSettled] = createSignal(true);
  let velocity = 0;

  createEffect(() => {
    const nextTarget = target();
    const rm = options.reducedMotion?.() ?? false;
    if (rm) {
      velocity = 0;
      setValue(nextTarget);
      setSettled(true);
      return;
    }
    if (Math.abs(nextTarget - value()) > 0.001) {
      setSettled(false);
    }
  });

  onFrame(
    (dtMs?: number) => {
      if (settled()) return;
      const rm = options.reducedMotion?.() ?? false;
      const cfg = ARC_SPRINGS[options.preset ?? "calm"];
      const dtSec = typeof dtMs === "number" && dtMs > 0 ? dtMs / 1000 : 1 / 60;
      const next = stepArcSpring(
        { value: value(), velocity, settled: settled() },
        target(),
        dtSec,
        cfg,
        rm,
      );
      velocity = next.velocity;
      setValue(next.value);
      if (next.settled) {
        setSettled(true);
      }
    },
    { continuous: () => !settled() },
  );

  return value;
}
