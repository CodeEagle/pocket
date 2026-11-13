// Pure sizing rules of SplitPane (split-pane.tsx).
export type SplitFixed = "first" | "second";

export interface SplitLimits { min: number; max: number }

/** Clamp a pane size to [min, max]; a non-finite size falls back to `min`. */
export function clampSplit(size: number, limits: SplitLimits): number {
  if (!Number.isFinite(size)) return limits.min;
  const hi = Math.max(limits.min, limits.max);
  return Math.min(hi, Math.max(limits.min, Math.round(size)));
}

/**
 * New size of the fixed-size pane after the handle moved `delta` px to the right (or down).
 * Dragging towards a pane grows the other one: the first pane grows with +delta, the second shrinks.
 */
export function dragSplit(size: number, delta: number, fixed: SplitFixed, limits: SplitLimits): number {
  return clampSplit(fixed === "first" ? size + delta : size - delta, limits);
}
