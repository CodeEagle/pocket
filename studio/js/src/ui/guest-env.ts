// Guest-side time source: the framework's frame-driven timers. Frames are
// only produced while the guest is active, which is the behavior wanted for
// debounce and reconnect backoff.
import { after } from "@pocketjs/framework/clock";
import type { Timers } from "../state/env.ts";

export const guestTimers: Timers = {
  after: (ms, fn) => after(ms / 1000, fn),
  now: () => Date.now(),
};
