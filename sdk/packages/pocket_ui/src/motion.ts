/** Shared timing for the JS-owned Mobile UI. Values are milliseconds, at any
 * simulation rate. These are Pocket choices inspired by Apple's motion
 * guidance, not constants published by Apple. */
export const MOBILE_MOTION = {
  state: 200,
  selection: 240,
  control: 280,
  presentation: 300,
} as const;

export function motionEaseInOut(phase: number): number {
  const t = Math.max(0, Math.min(1, phase));
  return t * t * (3 - 2 * t);
}

/** The same damped-oscillator model as the pinned core's anim.rs, specialized
 * to critical damping for JS scalars (the native API animates node props).
 * Exact integration keeps the response independent of 30/60/120 Hz and
 * carries velocity when a controlled value changes its destination. */
export function stepMotionSpring(
  position: number,
  velocity: number,
  target: number,
  deltaSeconds: number,
  responseMs: number,
): { position: number; velocity: number } {
  if (deltaSeconds <= 0) return { position, velocity };
  const omega = 8 / Math.max(0.001, responseMs / 1000);
  const offset = position - target;
  const coefficient = velocity + omega * offset;
  const decay = Math.exp(-omega * deltaSeconds);
  return {
    position: target + (offset + coefficient * deltaSeconds) * decay,
    velocity: (velocity - omega * coefficient * deltaSeconds) * decay,
  };
}
