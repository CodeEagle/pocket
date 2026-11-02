import { createSignal, onCleanup, onMount } from "solid-js";
import {
  EMPTY_DISPLAY_GEOMETRY,
  parseDisplayGeometry,
  type DisplayGeometry,
} from "./responsive.ts";

export interface DisplayGeometryBridge {
  __pocketEvent?: (line: string) => void;
  ui?: { __viewport?: { w?: unknown; h?: unknown } };
}

export interface DisplayGeometryOptions {
  /** Existing host event bridge; defaults to the global PocketJS bridge. */
  bridge?: DisplayGeometryBridge;
  /** Used when an older host has not sent a display.viewport event yet. */
  fallback?: DisplayGeometry;
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
  onMount(() => {
    const previous = bridge.__pocketEvent;
    const receive = (line: string): void => {
      try {
        const message = JSON.parse(line) as {
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
          setGeometry((current) => parseDisplayGeometry(params, current));
        }
      } catch {
        // A malformed unrelated host line must not break the existing lane.
      }
      previous?.(line);
    };
    bridge.__pocketEvent = receive;
    onCleanup(() => {
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
    });
  });
  return geometry;
}

