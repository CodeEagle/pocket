// JS-owned stream reconnection. The Dart provider ends or errors a stream on a
// service-side drop, a stream error or the framework quota (10000 items); the
// guest reopens it with backoff and then resynchronizes (re-list / re-status).
import type { Timers } from "./env.ts";
import type { StudioError, Subscription } from "../studio-client.ts";

export type StreamHandlers<E> = {
  onEvent(event: E): void;
  onError(error: StudioError): void;
  onEnd(): void;
};

export type ConnectionState = "connecting" | "open" | "retrying" | "closed";

export interface ResilientOptions<E> {
  timers: Timers;
  open(handlers: StreamHandlers<E>): Subscription;
  onEvent(event: E): void;
  /** Called with the first event of a connection that follows a drop, before that event is delivered. */
  onResync?(): void;
  onState?(state: ConnectionState, detail?: { attempt: number; delayMs: number; error?: string }): void;
  backoffMs?: readonly number[];
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 15000];

export function openResilient<E>(options: ResilientOptions<E>): { close(): void; reconnectNow(): void } {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  let closed = false;
  let attempt = 0;
  let needsResync = false;
  let sub: Subscription | undefined;
  let cancelTimer: (() => void) | undefined;
  let generation = 0;

  const teardown = (): void => {
    const current = sub;
    sub = undefined;
    try { current?.close(); } catch { /* already closed */ }
  };

  const retry = (error?: string): void => {
    if (closed) return;
    teardown();
    needsResync = true;
    const delayMs = backoff[Math.min(attempt, backoff.length - 1)] ?? 15000;
    attempt += 1;
    options.onState?.("retrying", { attempt, delayMs, ...(error ? { error } : {}) });
    cancelTimer?.();
    cancelTimer = options.timers.after(delayMs, () => { cancelTimer = undefined; connect(); });
  };

  const connect = (): void => {
    if (closed) return;
    const mine = ++generation;
    options.onState?.("connecting");
    let opened = false;
    try {
      sub = options.open({
        onEvent(event) {
          if (closed || mine !== generation) return;
          if (!opened) {
            opened = true;
            attempt = 0;
            options.onState?.("open");
            if (needsResync) { needsResync = false; options.onResync?.(); }
          }
          options.onEvent(event);
        },
        onError(error) { if (mine === generation) retry(error.message); },
        onEnd() { if (mine === generation) retry(); },
      });
    } catch (error) {
      retry(error instanceof Error ? error.message : String(error));
    }
  };

  connect();
  return {
    close() {
      closed = true;
      generation += 1;
      cancelTimer?.();
      cancelTimer = undefined;
      teardown();
      options.onState?.("closed");
    },
    reconnectNow() {
      if (closed) return;
      cancelTimer?.();
      cancelTimer = undefined;
      teardown();
      needsResync = true;
      connect();
    },
  };
}
