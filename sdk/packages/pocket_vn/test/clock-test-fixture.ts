import { mock } from "bun:test";

let now = 0;
const timers = new Set<{ due: number; callback(): void }>();

mock.module("@pocketjs/framework/clock", () => ({
  simulationHz: () => 60,
  virtualNow: () => now,
  after: (seconds: number, callback: () => void) => {
    const timer = { due: now + seconds, callback };
    timers.add(timer);
    return () => timers.delete(timer);
  },
}));

export function resetClockFixture(): void {
  now = 0;
  timers.clear();
}

export function clockFixtureTimerCount(): number {
  return timers.size;
}

export function pumpClockFixture(frames: number): void {
  for (let i = 0; i < frames; i++) {
    now += 1 / 60;
    for (const timer of [...timers]) {
      if (timer.due <= now + 1e-9) {
        timers.delete(timer);
        timer.callback();
      }
    }
  }
}
