/**
 * System accessibility facts supplied by the thin Flutter host.
 *
 * This module deliberately reports facts only. Motion, colour, transparency,
 * and text-layout policy remain owned by the JS guest. `reduceTransparency`
 * is nullable because Flutter has no cross-platform MediaQuery field for it;
 * null means that the host could not observe the platform preference.
 */

import { createContext, createSignal, onCleanup, onMount, useContext, type JSX } from "solid-js";
import type { BridgeObject, HostEvent } from "./host.ts";

export const ACCESSIBILITY_PREFERENCES_EVENT = "accessibility.preferences";

export interface AccessibilityPreferences {
  readonly reduceMotion: boolean;
  readonly increaseContrast: boolean;
  readonly textScale: number;
  readonly accessibleNavigation: boolean;
  /** `null` is an explicit unknown/unsupported value. */
  readonly reduceTransparency: boolean | null;
}

export const DEFAULT_ACCESSIBILITY_PREFERENCES: AccessibilityPreferences = {
  reduceMotion: false,
  increaseContrast: false,
  textScale: 1,
  accessibleNavigation: false,
  reduceTransparency: null,
};

export interface AccessibilityPreferencesBridge {
  onEvent?: (listener: (event: HostEvent) => void) => () => void;
  __pocketHostBridge?: {
    onEvent?: (listener: (event: HostEvent) => void) => () => void;
  };
}

export interface AccessibilityPreferencesOptions {
  /** Existing HostBridge; defaults to the global PocketJS bridge. */
  bridge?: AccessibilityPreferencesBridge;
  /** Used until the thin host publishes its first fact snapshot. */
  fallback?: AccessibilityPreferences;
}

export type AccessibilityPreferencesAccessor = () => AccessibilityPreferences;

/** One app-level provider keeps preference policy on the JS-owned tree. */
export const AccessibilityPreferencesContext = createContext<AccessibilityPreferencesAccessor>(
  () => DEFAULT_ACCESSIBILITY_PREFERENCES,
);

export function AccessibilityPreferencesProvider(props: {
  value: AccessibilityPreferencesAccessor;
  children: JSX.Element;
}): JSX.Element {
  return AccessibilityPreferencesContext.Provider({
    get value() { return props.value; },
    get children() { return props.children; },
  });
}

/** Read the nearest app-level preference signal, or the explicit defaults. */
export function useAccessibilityPreferences(): AccessibilityPreferencesAccessor {
  return useContext(AccessibilityPreferencesContext);
}

type AccessibilityListener = (preferences: AccessibilityPreferences) => void;

interface AccessibilityBridgeState {
  readonly listeners: Set<AccessibilityListener>;
  readonly removeHostEvent?: () => void;
}

const bridgeStates = new WeakMap<object, AccessibilityBridgeState>();
const latestPreferences = new WeakMap<object, AccessibilityPreferences>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finiteScale(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(8, Math.max(0.1, value));
}

function nullableBool(value: unknown, fallback: boolean | null): boolean | null {
  if (value === true || value === false) return value;
  return value === null ? null : fallback;
}

/** Parse a host snapshot without allowing malformed/legacy fields to throw. */
export function parseAccessibilityPreferences(
  value: unknown,
  fallback: AccessibilityPreferences = DEFAULT_ACCESSIBILITY_PREFERENCES,
): AccessibilityPreferences {
  if (!isRecord(value)) return fallback;
  const contrast = value.increaseContrast ?? value.highContrast;
  return {
    reduceMotion: bool(value.reduceMotion, fallback.reduceMotion),
    increaseContrast: bool(contrast, fallback.increaseContrast),
    textScale: finiteScale(value.textScale, fallback.textScale),
    accessibleNavigation: bool(value.accessibleNavigation, fallback.accessibleNavigation),
    reduceTransparency: Object.prototype.hasOwnProperty.call(value, "reduceTransparency")
      ? nullableBool(value.reduceTransparency, null)
      : fallback.reduceTransparency,
  };
}

function globalBridge(): AccessibilityPreferencesBridge {
  return globalThis as typeof globalThis & AccessibilityPreferencesBridge;
}

function resolvedBridge(bridge: AccessibilityPreferencesBridge): AccessibilityPreferencesBridge {
  if (typeof bridge.onEvent === "function") return bridge;
  if (bridge.__pocketHostBridge && typeof bridge.__pocketHostBridge.onEvent === "function") {
    return bridge.__pocketHostBridge;
  }
  const global = globalBridge();
  if (typeof global.onEvent === "function") return global;
  return global.__pocketHostBridge && typeof global.__pocketHostBridge.onEvent === "function"
    ? global.__pocketHostBridge
    : bridge;
}

function subscribe(
  bridge: AccessibilityPreferencesBridge,
  listener: AccessibilityListener,
  fallback: AccessibilityPreferences,
): () => void {
  let state = bridgeStates.get(bridge);
  if (!state) {
    const listeners = new Set<AccessibilityListener>();
    const dispatch = (event: HostEvent): void => {
      if (event.method !== ACCESSIBILITY_PREFERENCES_EVENT) return;
      const previous = latestPreferences.get(bridge) ?? fallback;
      const next = parseAccessibilityPreferences(event.params, previous);
      latestPreferences.set(bridge, next);
      for (const current of [...listeners]) {
        try { current(next); } catch { /* keep the shared event lane live */ }
      }
    };
    const source = typeof bridge.onEvent === "function"
      ? bridge
      : bridge.__pocketHostBridge && typeof bridge.__pocketHostBridge.onEvent === "function"
        ? bridge.__pocketHostBridge
        : undefined;
    state = {
      listeners,
      removeHostEvent: source?.onEvent?.(dispatch),
    };
    bridgeStates.set(bridge, state);
  }
  const currentState = state;
  currentState.listeners.add(listener);
  const latest = latestPreferences.get(bridge);
  if (latest) {
    try { listener(latest); } catch { /* keep subscription setup non-throwing */ }
  }
  return () => {
    const active = bridgeStates.get(bridge);
    if (!active) return;
    active.listeners.delete(listener);
    if (active.listeners.size !== 0) return;
    active.removeHostEvent?.();
    bridgeStates.delete(bridge);
  };
}

/**
 * Subscribe to the single host accessibility-preference event lane.
 *
 * The returned accessor is a Solid signal. Multiple guest components sharing
 * one bridge share one HostBridge listener and one cached latest snapshot.
 */
export function createAccessibilityPreferences(
  options: AccessibilityPreferencesOptions = {},
): () => AccessibilityPreferences {
  const bridge = options.bridge ?? globalBridge();
  const fallback = options.fallback ?? DEFAULT_ACCESSIBILITY_PREFERENCES;
  const [preferences, setPreferences] = createSignal<AccessibilityPreferences>(fallback);
  let disposed = false;
  onMount(() => {
    const unsubscribe = subscribe(resolvedBridge(bridge), (next) => {
      if (!disposed) setPreferences(next);
    }, fallback);
    onCleanup(() => {
      disposed = true;
      unsubscribe();
    });
  });
  return preferences;
}

/** Type guard useful to host adapters that need to forward a JSON payload. */
export function accessibilityPreferencesPayload(
  preferences: AccessibilityPreferences,
): BridgeObject {
  return {
    reduceMotion: preferences.reduceMotion,
    increaseContrast: preferences.increaseContrast,
    textScale: preferences.textScale,
    accessibleNavigation: preferences.accessibleNavigation,
    reduceTransparency: preferences.reduceTransparency,
  };
}
