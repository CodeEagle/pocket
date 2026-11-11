import type { HostBridge } from "./host.ts";

export const POCKET_BACK_REQUEST_EVENT = "platform.back.request";
export const POCKET_BACK_RESPONSE_EVENT = "platform.back.response";
export const POCKET_BACK_GESTURE_EVENT = "platform.back.gesture";
export const POCKET_BACK_GESTURE_RESPONSE_EVENT = "platform.back.gesture.response";
export const POCKET_BACK_GESTURE_READY_EVENT = "platform.back.gesture.ready";

export type PocketBackRequestHandler = (requestId: string) => boolean | Promise<boolean>;

export type PocketBackGesturePhase = "start" | "update" | "end" | "cancel";

export interface PocketBackGestureEvent {
  gestureId: string;
  phase: PocketBackGesturePhase;
  dx: number;
  width: number;
  velocity: number;
  progress: number;
}

/** Return true only for a synchronously accepted start; later phases are notifications. */
export type PocketBackGestureHandler = (event: PocketBackGestureEvent) => boolean | void;

/** Pocket's distance rule: commit only when the latest terminal progress is over half. */
export function shouldCommitPocketBackGesture(event: PocketBackGestureEvent): boolean {
  return event.phase === "end" && event.progress > 0.5;
}

/**
 * Respond to a native back request through the existing Pocket host event lane.
 * The host addresses the request to the currently focused guest and falls back
 * to SystemUI when that guest reports `handled: false`.
 */
export function createPocketBackNavigation(
  host: Pick<HostBridge, "onEvent" | "emit">,
) {
  let disposed = false;
  let handler: PocketBackRequestHandler | undefined;
  let gestureHandler: PocketBackGestureHandler | undefined;
  let gestureReady = false;
  let activeGestureId: string | undefined;
  let lastGesture: PocketBackGestureEvent | undefined;

  const emitGestureResponse = (gestureId: string, handled: boolean): void => {
    try {
      host.emit?.(POCKET_BACK_GESTURE_RESPONSE_EVENT, { gestureId, handled });
    } catch {
      // A disconnected or older host cannot prevent local cleanup.
    }
  };

  const setGestureReady = (ready: boolean): void => {
    if (gestureReady === ready) return;
    gestureReady = ready;
    try {
      host.emit?.(POCKET_BACK_GESTURE_READY_EVENT, { ready });
    } catch {
      // Readiness is advisory to the native recognizer; disposal still succeeds.
    }
  };

  const clearGesture = (notifyCancel: boolean): void => {
    const last = lastGesture;
    activeGestureId = undefined;
    lastGesture = undefined;
    if (!notifyCancel || !last || !gestureHandler) return;
    try {
      gestureHandler({ ...last, phase: "cancel" });
    } catch {
      // Cancellation is best effort and must not strand a native gesture ID.
    }
  };

  const parseGesture = (value: Record<string, unknown>): PocketBackGestureEvent | undefined => {
    const { gestureId, phase, dx, width, velocity, progress } = value;
    if (
      typeof gestureId !== "string" || gestureId.length === 0 ||
      (phase !== "start" && phase !== "update" && phase !== "end" && phase !== "cancel") ||
      typeof dx !== "number" || !Number.isFinite(dx) ||
      typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
      typeof velocity !== "number" || !Number.isFinite(velocity) ||
      typeof progress !== "number" || !Number.isFinite(progress)
    ) return undefined;
    return { gestureId, phase, dx, width, velocity, progress };
  };

  const remove = host.onEvent?.((event) => {
    if (disposed) return;
    if (event.method === POCKET_BACK_GESTURE_EVENT) {
      const raw = event.params as Record<string, unknown>;
      if (raw.phase === "start") {
        clearGesture(true);
        const gestureId = typeof raw.gestureId === "string" ? raw.gestureId : "";
        const gesture = parseGesture(raw);
        let handled = false;
        if (gesture && gestureHandler) {
          try {
            handled = gestureHandler(gesture) === true;
          } catch {
            handled = false;
          }
        }
        if (handled && gesture) {
          activeGestureId = gesture.gestureId;
          lastGesture = gesture;
        }
        if (gestureId.length > 0) emitGestureResponse(gestureId, handled);
        return;
      }

      const gesture = parseGesture(raw);
      if (!gesture || gesture.gestureId !== activeGestureId) return;
      lastGesture = gesture;
      try {
        gestureHandler?.(gesture);
      } catch {
        // A failed consumer callback cannot leave this gesture active.
      }
      if (gesture.phase === "end" || gesture.phase === "cancel") clearGesture(false);
      return;
    }

    if (event.method !== POCKET_BACK_REQUEST_EVENT) return;
    clearGesture(true);
    const requestId = event.params.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) return;
    void Promise.resolve().then(() => handler?.(requestId) ?? false).then(
      (handled) => {
        if (!disposed) host.emit?.(POCKET_BACK_RESPONSE_EVENT, {
          requestId,
          handled: handled === true,
        });
      },
      () => {
        if (!disposed) host.emit?.(POCKET_BACK_RESPONSE_EVENT, {
          requestId,
          handled: false,
        });
      },
    );
  });

  return {
    setHandler(next: PocketBackRequestHandler | undefined): void {
      if (!disposed) handler = next;
    },
    setGestureHandler(next: PocketBackGestureHandler | undefined): void {
      if (disposed || next === gestureHandler) return;
      clearGesture(true);
      gestureHandler = next;
      setGestureReady(typeof next === "function");
    },
    dispose(): void {
      if (disposed) return;
      clearGesture(true);
      setGestureReady(false);
      disposed = true;
      handler = undefined;
      gestureHandler = undefined;
      remove?.();
    },
  };
}
