/** Shared timing for the JS-owned Mobile UI. Values are milliseconds, at any
 * simulation rate. These are Pocket choices inspired by Apple's motion
 * guidance, not constants published by Apple. */
export const MOBILE_MOTION = {
  state: 200,
  selection: 240,
  control: 280,
  presentation: 300,
  overlay: 220,
} as const;

export function motionEaseInOut(phase: number): number {
  const t = Math.max(0, Math.min(1, phase));
  return t * t * (3 - 2 * t);
}

/** Prompt overlay reveal; the same phase can run backward on dismissal. */
export function motionEaseOut(phase: number): number {
  const t = Math.max(0, Math.min(1, phase));
  return 1 - (1 - t) ** 3;
}

/** The same damped-oscillator model as the pinned core's anim.rs, used for
 * JS scalars (the native API animates node props). Critical damping remains
 * the default; opt-in underdamping adds a release bounce for direct manipulation.
 * Exact integration keeps the response independent of 30/60/120 Hz and
 * carries velocity when a controlled value changes its destination. */
export function stepMotionSpring(
  position: number,
  velocity: number,
  target: number,
  deltaSeconds: number,
  responseMs: number,
  dampingRatio = 1,
): { position: number; velocity: number } {
  if (deltaSeconds <= 0) return { position, velocity };
  const omega = 8 / Math.max(0.001, responseMs / 1000);
  const offset = position - target;
  const damping = Math.max(0.01, Math.min(2, dampingRatio));
  if (Math.abs(damping - 1) < 1e-5) {
    const coefficient = velocity + omega * offset;
    const decay = Math.exp(-omega * deltaSeconds);
    return {
      position: target + (offset + coefficient * deltaSeconds) * decay,
      velocity: (velocity - omega * coefficient * deltaSeconds) * decay,
    };
  }
  if (damping < 1) {
    const decayRate = damping * omega;
    const frequency = omega * Math.sqrt(1 - damping * damping);
    const coefficient = (velocity + decayRate * offset) / frequency;
    const cosine = Math.cos(frequency * deltaSeconds);
    const sine = Math.sin(frequency * deltaSeconds);
    const displacement = offset * cosine + coefficient * sine;
    const decay = Math.exp(-decayRate * deltaSeconds);
    return {
      position: target + decay * displacement,
      velocity: decay * (frequency * (coefficient * cosine - offset * sine) - decayRate * displacement),
    };
  }
  const split = Math.sqrt(damping * damping - 1);
  const slow = -omega * (damping - split);
  const fast = -omega * (damping + split);
  const slowCoefficient = (velocity - fast * offset) / (slow - fast);
  const fastCoefficient = offset - slowCoefficient;
  const slowDisplacement = slowCoefficient * Math.exp(slow * deltaSeconds);
  const fastDisplacement = fastCoefficient * Math.exp(fast * deltaSeconds);
  return {
    position: target + slowDisplacement + fastDisplacement,
    velocity: slow * slowDisplacement + fast * fastDisplacement,
  };
}
