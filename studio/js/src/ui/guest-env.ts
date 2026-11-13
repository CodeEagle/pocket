// Guest-side time source: the framework's frame-driven timers. Frames are
// only produced while the guest is active, which is the behavior wanted for
// debounce and reconnect backoff.
import { after } from "@pocketjs/framework/clock";
import type { Timers } from "../state/env.ts";

export const guestTimers: Timers = {
  after: (ms, fn) => after(ms / 1000, fn),
  now: () => Date.now(),
};

/** Continues in a later guest turn (next frame), resetting the 250 ms per-turn interrupt budget. */
export const yieldTurn = (): Promise<void> => new Promise((resolve) => { after(0.001, () => resolve()); });
