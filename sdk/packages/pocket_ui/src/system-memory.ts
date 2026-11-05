// Shared by build-time manifest validation and the runtime kernel.
// Keep this data independent of guest clock/runtime imports.

/** Compatibility names retained from the original mini-app memory tiers. */
export const POCKET_MEMORY_POLICIES = [
  "UI_MINI",
  "GAME_STANDARD",
  "VIDEO_GAME_PRO",
  "VIDEO_GAME_ULTRA",
] as const;
export type PocketMemoryPolicy = (typeof POCKET_MEMORY_POLICIES)[number];

/** A SystemUI budget request; the trusted host still owns the final grant. */
export interface PocketMemoryBudget {
  heapLimitBytes?: number;
  maxPakBytes?: number;
}

export const POCKET_MEMORY_POLICY_BUDGETS: Readonly<Record<PocketMemoryPolicy, PocketMemoryBudget>> = Object.freeze({
  // The legacy native/VRAM numbers are intentionally not projected into
  // maxPakBytes: the host cannot promise those old off-heap semantics.
  UI_MINI: Object.freeze({ heapLimitBytes: 128 * 1024 * 1024 }),
  GAME_STANDARD: Object.freeze({ heapLimitBytes: 512 * 1024 * 1024 }),
  VIDEO_GAME_PRO: Object.freeze({ heapLimitBytes: 1024 * 1024 * 1024 }),
  VIDEO_GAME_ULTRA: Object.freeze({ heapLimitBytes: 2 * 1024 * 1024 * 1024 }),
});
