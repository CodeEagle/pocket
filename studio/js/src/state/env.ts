// Time source injected into every state module. The guest uses the framework's
// frame-driven `after`; unit tests use a manual clock.
export interface Timers {
  /** Runs `fn` once after about `ms`; returns a canceller. */
  after(ms: number, fn: () => void): () => void;
  now(): number;
}

export interface ManualTimers extends Timers {
  advance(ms: number): void;
  pending(): number;
}

export function createManualTimers(): ManualTimers {
  let time = 0;
  let seq = 0;
  let queue: { at: number; seq: number; fn: () => void }[] = [];
  return {
    now: () => time,
    after(ms, fn) {
      const entry = { at: time + Math.max(0, ms), seq: seq++, fn };
      queue.push(entry);
      return () => { queue = queue.filter((item) => item !== entry); };
    },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = queue[0];
        if (!next || next.at > target) break;
        queue.shift();
        time = next.at;
        next.fn();
      }
      time = target;
    },
    pending: () => queue.length,
  };
}
