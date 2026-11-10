import type { HostBridge } from "./host.ts";

export const POCKET_BACK_REQUEST_EVENT = "platform.back.request";
export const POCKET_BACK_RESPONSE_EVENT = "platform.back.response";

export type PocketBackRequestHandler = (requestId: string) => boolean | Promise<boolean>;

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
  const remove = host.onEvent?.((event) => {
    if (disposed || event.method !== POCKET_BACK_REQUEST_EVENT) return;
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      handler = undefined;
      remove?.();
    },
  };
}
