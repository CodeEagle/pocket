import { createSignal, onCleanup, onMount } from "solid-js";
import {
  forwardHostPacket,
  type BridgeObject,
  type HostDisplayViewportSnapshot,
  type HostEvent,
} from "./host.ts";
import {
  EMPTY_DISPLAY_GEOMETRY,
  parseDisplayGeometry,
  type DisplayGeometry,
} from "./responsive.ts";

export type DisplayEventHandler = ((packet: Record<string, unknown>) => void) & {
  __binaryCapable?: boolean;
};

export interface DisplayGeometryBridge {
  __pocketEvent?: DisplayEventHandler;
  onEvent?: (listener: (event: HostEvent) => void) => () => void;
  getLatestDisplayViewport?: () => HostDisplayViewportSnapshot | undefined;
  __pocketHostBridge?: {
    onEvent?: (listener: (event: HostEvent) => void) => () => void;
    getLatestDisplayViewport?: () => HostDisplayViewportSnapshot | undefined;
  };
  ui?: { __viewport?: { w?: unknown; h?: unknown } };
}

export interface DisplayGeometryOptions {
  /** Existing host event bridge; defaults to the global PocketJS bridge. */
  bridge?: DisplayGeometryBridge;
  /** Used when an older host has not sent a display.viewport event yet. */
  fallback?: DisplayGeometry;
  /**
   * Synchronous notification for resize-sensitive consumers. The callback is
   * invoked in the existing display.viewport event lane, immediately after
   * the parsed signal is updated and before the native resize call returns.
   * It is intentionally a side effect hook, not a second transport.
   */
  onChange?: (geometry: DisplayGeometry) => void;
}

type DisplayListener = (event: HostEvent) => void;

interface DisplayBridgeState {
  readonly previous?: DisplayEventHandler;
  readonly receive?: DisplayEventHandler;
  readonly listeners: Set<DisplayListener>;
  readonly removeHostEvent?: () => void;
}

interface LatestDisplayFact {
  readonly event: HostEvent;
  /** Canonical state after applying partial viewport updates. */
  readonly geometry: DisplayGeometry;
}

// Keep the latest complete display fact independently of the current listener
// set. Mini-app surfaces can mount after the root shell has already consumed a
// viewport event; replaying this fact avoids admitting their first frame with
// the EMPTY safe area (and therefore briefly putting the close action under a
// camera/status cluster). This is a cache of the existing event lane, not a
// second transport or a poller.
const latestDisplayFacts = new WeakMap<object, LatestDisplayFact>();

// Keep one wrapper per host bridge. A page can be replaced while another
// subscriber (for example the app shell) remains mounted; a wrapper-per-page
// chain would retain disposed callbacks in `previous` and grow on every route.
const displayBridgeStates = new WeakMap<object, DisplayBridgeState>();

function subscribeDisplayBridge(
  bridge: DisplayGeometryBridge,
  listener: DisplayListener,
  alreadyApplied?: HostEvent,
  initialGeometry: DisplayGeometry = EMPTY_DISPLAY_GEOMETRY,
): () => void {
  let state = displayBridgeStates.get(bridge);
  if (!state) {
    const listeners = new Set<DisplayListener>();
    const dispatch = (event: HostEvent): void => {
      if (event.method === "display.viewport") {
        // Modern HostBridge owns this fact at ingress so it is available even
        // before the first display subscriber mounts. Keep the old local cache
        // only for custom/legacy event sources without that capability.
        if (typeof bridge.getLatestDisplayViewport !== "function") {
          const previous = latestDisplayFacts.get(bridge)?.geometry ?? initialGeometry;
          const geometry = parseDisplayGeometry(event.params, previous);
          latestDisplayFacts.set(bridge, { event, geometry });
        }
      }
      for (const current of [...listeners]) {
        try { current(event); } catch { /* keep the display event lane live */ }
      }
    };
    const hostEventSource = typeof bridge.onEvent === "function"
      ? bridge
      : bridge.__pocketHostBridge && typeof bridge.__pocketHostBridge.onEvent === "function"
        ? bridge.__pocketHostBridge
        : undefined;
    if (hostEventSource) {
      state = {
        listeners,
        removeHostEvent: hostEventSource.onEvent!(dispatch),
      };
    } else {
      const previous = bridge.__pocketEvent;
      const receive: DisplayEventHandler = (packet): void => {
        const message = packet;
        const method = typeof message.method === "string"
          ? message.method
          : typeof message.name === "string" ? message.name : "";
        const params = message.params ?? message.payload;
        const event: HostEvent | undefined = method ? {
          id: typeof message.id === "string" ? message.id : "",
          method,
          params: params && typeof params === "object" && !Array.isArray(params)
            ? params as BridgeObject
            : {},
          raw: message,
        } : undefined;
        if (event) dispatch(event);
        try { forwardHostPacket(previous, packet); } catch { /* isolate legacy previous sinks */ }
      };
      receive.__binaryCapable = true;
      state = { previous, receive, listeners };
      bridge.__pocketEvent = receive;
    }
    displayBridgeStates.set(bridge, state);
  }
  const currentState = state;
  currentState.listeners.add(listener);
  const latestFact = latestDisplayFact(bridge);
  if (latestFact && latestFact.event !== alreadyApplied) {
    const latest = {
      ...latestFact.event,
      params: displayGeometryBridgeObject(latestFact.geometry),
    };
    try { listener(latest); } catch { /* keep subscription setup non-throwing */ }
  }
  return () => {
    const active = displayBridgeStates.get(bridge);
    if (!active) return;
    active.listeners.delete(listener);
    if (active.listeners.size !== 0) return;
    active.removeHostEvent?.();
    if (active.receive && bridge.__pocketEvent === active.receive) bridge.__pocketEvent = active.previous;
    displayBridgeStates.delete(bridge);
  };
}

function latestDisplayFact(bridge: DisplayGeometryBridge): LatestDisplayFact | HostDisplayViewportSnapshot | undefined {
  if (typeof bridge.getLatestDisplayViewport === "function") return bridge.getLatestDisplayViewport();
  return latestDisplayFacts.get(bridge);
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function globalDisplayBridge(): DisplayGeometryBridge {
  return globalThis as typeof globalThis & DisplayGeometryBridge;
}

function resolvedDisplayBridge(bridge: DisplayGeometryBridge): DisplayGeometryBridge {
  // Resolve the modern bridge at mount time: app shells commonly construct
  // their display signal before creating the bridge during the same render.
  if (typeof bridge.onEvent === "function") return bridge;
  if (bridge.__pocketHostBridge && typeof bridge.__pocketHostBridge.onEvent === "function") {
    return bridge.__pocketHostBridge;
  }
  const globalBridge = globalDisplayBridge();
  if (typeof globalBridge.onEvent === "function") return globalBridge;
  return globalBridge.__pocketHostBridge && typeof globalBridge.__pocketHostBridge.onEvent === "function"
    ? globalBridge.__pocketHostBridge
    : bridge;
}

/** Subscribe to the guest's existing host event lane. This shares the single
 * bridge wrapper used by display geometry and keeps SDK consumers from
 * creating parallel `__pocketEvent` chains for non-display events. */
export function subscribeHostEvents(
  listener: (event: HostEvent) => void,
  bridge: DisplayGeometryBridge = globalDisplayBridge(),
): () => void {
  const resolved = resolvedDisplayBridge(bridge);
  return subscribeDisplayBridge(
    resolved,
    listener,
    undefined,
    initialDisplayGeometry(resolved, EMPTY_DISPLAY_GEOMETRY, bridge),
  );
}

function initialDisplayGeometry(
  bridge: DisplayGeometryBridge,
  fallback: DisplayGeometry,
  viewportBridge: DisplayGeometryBridge = bridge,
): DisplayGeometry {
  const latest = latestDisplayFact(bridge);
  if (latest) {
    // The canonical host snapshot is more authoritative than the
    // width/height-only ui.__viewport fallback. It includes reserved regions
    // and margins needed for a first-frame close placement, even if the most
    // recent packet was a partial keyboard/resize update.
    return latest.geometry;
  }
  // The modern event source may be nested under the global adapter; retain
  // the canonical ui.__viewport fallback from that adapter when no event fact
  // has arrived yet.
  const viewport = bridge.ui?.__viewport ?? viewportBridge.ui?.__viewport;
  const width = finite(viewport?.w, fallback.width);
  const height = finite(viewport?.h, fallback.height);
  return parseDisplayGeometry({
    width: width > 0 ? width : fallback.width,
    height: height > 0 ? height : fallback.height,
    safeArea: fallback.safeArea,
    keyboardInset: fallback.keyboardInset,
    reservedRegions: fallback.reservedRegions,
  }, fallback);
}

/**
 * Subscribe to the host's existing `display.viewport` event lane.
 *
 * This is a Solid signal plus bridge chaining, not a second event transport:
 * an existing `globalThis.__pocketEvent` callback is called after the adapter
 * observes the event, and cleanup restores it only when this subscriber still
 * owns the slot. External apps can use the same hook without copying the
 * showcase's event handler or polling the viewport every frame.
 */
export function createDisplayGeometry(options: DisplayGeometryOptions = {}): () => DisplayGeometry {
  const bridge = options.bridge ?? globalDisplayBridge();
  const fallback = options.fallback ?? EMPTY_DISPLAY_GEOMETRY;
  const initialBridge = resolvedDisplayBridge(bridge);
  const initialGeometry = initialDisplayGeometry(initialBridge, fallback, bridge);
  const initialEvent = latestDisplayFact(initialBridge)?.event;
  const [geometry, setGeometry] = createSignal<DisplayGeometry>(initialGeometry);
  let disposed = false;
  onMount(() => {
    const receive = (event: HostEvent): void => {
      if (disposed || event.method !== "display.viewport") return;
      const next = parseDisplayGeometry(event.params, geometry());
      setGeometry(next);
      try {
        options.onChange?.(next);
      } catch {
        // A resize observer must not break the existing host event lane.
      }
    };
    // Resolve again at mount: the root can create its signal before the host
    // bridge is installed, while child surfaces normally see the existing
    // modern bridge and its cached latest fact immediately.
    const unsubscribe = subscribeDisplayBridge(resolvedDisplayBridge(bridge), receive, initialEvent, initialGeometry);
    onCleanup(() => {
      disposed = true;
      unsubscribe();
    });
  });
  return geometry;
}

function displayGeometryBridgeObject(geometry: DisplayGeometry): BridgeObject {
  return {
    width: geometry.width,
    height: geometry.height,
    safeArea: { ...geometry.safeArea },
    keyboardInset: geometry.keyboardInset,
    reservedRegions: geometry.reservedRegions.map((region) => ({
      id: region.id,
      kind: region.kind,
      frame: { ...region.frame },
      margins: { ...region.margins },
      active: region.active,
    })),
  };
}

