import { createSignal, onCleanup, onMount } from "solid-js";
import {
  EMPTY_DISPLAY_GEOMETRY,
  parseDisplayGeometry,
  type DisplayGeometry,
} from "./responsive.ts";

export type DisplayEventHandler = ((packet: string | Record<string, unknown>) => void) & {
  __binaryCapable?: boolean;
};

export interface DisplayGeometryBridge {
  __pocketEvent?: DisplayEventHandler;
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

type DisplayListener = DisplayEventHandler;

interface DisplayBridgeState {
  readonly previous?: DisplayListener;
  readonly receive: DisplayListener;
  readonly listeners: Set<DisplayListener>;
}

// Keep one wrapper per host bridge. A page can be replaced while another
// subscriber (for example the app shell) remains mounted; a wrapper-per-page
// chain would retain disposed callbacks in `previous` and grow on every route.
const displayBridgeStates = new WeakMap<object, DisplayBridgeState>();

function subscribeDisplayBridge(bridge: DisplayGeometryBridge, listener: DisplayListener): () => void {
  let state = displayBridgeStates.get(bridge);
  if (!state) {
    const listeners = new Set<DisplayListener>();
    const previous = bridge.__pocketEvent;
    const receive: DisplayListener = (packet) => {
      for (const current of [...listeners]) {
        try {
          current(packet);
        } catch {
          // An observer must not prevent the remaining bridge subscribers.
        }
      }
      if (!previous) return;
      if (previous.__binaryCapable === true || typeof packet === "string") {
        previous(packet);
      } else {
        previous(JSON.stringify(packet));
      }
    };
    receive.__binaryCapable = true;
    state = { previous, receive, listeners };
    displayBridgeStates.set(bridge, state);
    bridge.__pocketEvent = receive;
  }
  const currentState = state;
  currentState.listeners.add(listener);
  return () => {
    const active = displayBridgeStates.get(bridge);
    if (!active) return;
    active.listeners.delete(listener);
    if (active.listeners.size !== 0) return;
    if (bridge.__pocketEvent === active.receive) bridge.__pocketEvent = active.previous;
    displayBridgeStates.delete(bridge);
  };
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function globalDisplayBridge(): DisplayGeometryBridge {
  return globalThis as typeof globalThis & DisplayGeometryBridge;
}

function initialDisplayGeometry(bridge: DisplayGeometryBridge, fallback: DisplayGeometry): DisplayGeometry {
  const viewport = bridge.ui?.__viewport;
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
  const [geometry, setGeometry] = createSignal<DisplayGeometry>(initialDisplayGeometry(bridge, fallback));
  let disposed = false;
  onMount(() => {
    const receive: DisplayListener = (packet): void => {
      if (disposed) return;
      try {
        const message = (typeof packet === "string" ? JSON.parse(packet) : packet) as {
          method?: unknown;
          name?: unknown;
          params?: unknown;
          payload?: unknown;
        };
        const method = typeof message.method === "string"
          ? message.method
          : typeof message.name === "string" ? message.name : "";
        if (method === "display.viewport") {
          const params = message.params ?? message.payload;
          const next = parseDisplayGeometry(params, geometry());
          setGeometry(next);
          try {
            options.onChange?.(next);
          } catch {
            // A resize observer must not break the existing host event lane.
          }
        }
      } catch {
        // A malformed unrelated host line must not break the existing lane.
      }
    };
    const unsubscribe = subscribeDisplayBridge(bridge, receive);
    onCleanup(() => {
      disposed = true;
      unsubscribe();
    });
  });
  return geometry;
}

