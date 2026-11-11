/**
 * Explicit semantic controls for the Apple public control set.
 *
 * This is intentionally a small bridge around the existing native-tree
 * mirror. It does not infer labels from debug names, create a second layout
 * tree, or install semantics on every Focusable. Callers opt a control in,
 * bind its existing NodeMirror, and the host receives the committed absolute
 * rectangle on a passive frame callback with a bounded initial admission hint.
 */

import {
  createContext,
  onCleanup,
  useContext,
  type JSX,
} from "solid-js";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import type { NodeMirror } from "@pocketjs/framework/solid/components";
import type { BridgeObject, HostEvent } from "./host.ts";

export const ACCESSIBILITY_SNAPSHOT_EVENT = "accessibility.snapshot";
export const ACCESSIBILITY_ACTION_EVENT = "accessibility.action";
export const MAX_APPLE_SEMANTIC_CONTROLS = 128;
const INITIAL_MEASUREMENT_FRAMES = 3;

export type AppleSemanticRole = "button" | "tab";
export type SemanticValue<T> = T | (() => T);

/** A control is semantic only when an Apple public component registers it. */
export interface AppleSemanticControl {
  /** Stable guest id. This must not be a native NodeMirror id. */
  readonly id: string;
  readonly label: SemanticValue<string>;
  readonly role?: AppleSemanticRole;
  readonly selected?: SemanticValue<boolean>;
  readonly disabled?: SemanticValue<boolean>;
  readonly checked?: SemanticValue<boolean>;
  /** Optional per-control route membership; defaults to the provider gate. */
  readonly routeActive?: SemanticValue<boolean>;
  /** Optional nearest-scroll visual transform; overrides provider geometry. */
  readonly visualRect?: (node: NodeMirror, committed: AppleSemanticRect) => AppleSemanticRect | undefined;
  /** Optional nearest-scroll clip; overrides provider geometry. */
  readonly clipRect?: SemanticValue<AppleSemanticRect | undefined>;
  /** JS-owned activation callback. Dart never owns this business action. */
  readonly onActivate?: () => void;
}

export type AppleSemanticNodeRef = (node: NodeMirror | null | undefined) => void;

export interface AppleSemanticsBridge {
  emit?: (method: string, params?: BridgeObject) => boolean;
  onEvent?: (listener: (event: HostEvent) => void) => () => void;
  __pocketHostBridge?: AppleSemanticsBridge;
}

export interface AppleSemanticsStore {
  /** Register a control and receive the callback for its existing nodeRef. */
  register(control: AppleSemanticControl): AppleSemanticNodeRef;
  /** Explicit cleanup for callers that do not have a Solid owner scope. */
  unregister(id: string): void;
  /** Clear the native semantic overlay and detach the host event listener. */
  dispose(): void;
  /** Last successfully published generation, starting at zero. */
  readonly generation: number;
}

export interface AppleSemanticsOptions {
  /** Existing HostBridge; defaults to the global PocketJS bridge. */
  readonly bridge?: AppleSemanticsBridge;
  /** App/route visibility gate. Hidden routes are removed from snapshots. */
  readonly routeActive?: SemanticValue<boolean>;
  readonly maxControls?: number;
  /**
   * Optional existing scroll/paint transform. `getLayout` reports flex
   * geometry and deliberately excludes paint transforms, so a page scroller
   * may translate that committed rect here without introducing a layout
   * engine. Return `undefined` when the control is outside the visual page.
   */
  readonly visualRect?: (node: NodeMirror, committed: AppleSemanticRect) => AppleSemanticRect | undefined;
  /** Optional visual viewport clip in the same coordinates as `visualRect`. */
  readonly clipRect?: SemanticValue<AppleSemanticRect | undefined>;
}

export interface AppleSemanticsProviderProps extends AppleSemanticsOptions {
  readonly children: JSX.Element;
  /** Pass an app-owned store when the app already created its one provider. */
  readonly store?: AppleSemanticsStore;
}

export const AppleSemanticsContext = createContext<AppleSemanticsStore | undefined>(undefined);

interface SemanticEntry {
  readonly control: AppleSemanticControl;
  node: NodeMirror | undefined;
  routeActive: boolean | undefined;
  needsInitialMeasurement: boolean;
  initialMeasurementFrames: number;
}

export interface AppleSemanticRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SemanticSnapshotNode {
  readonly guestId: string;
  readonly nativeId: number;
  readonly label: string;
  readonly role: AppleSemanticRole;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly rect: AppleSemanticRect;
  readonly checked?: boolean;
}

type PocketLayoutGlobal = {
  getLayout?: (id: number) => unknown;
  getLayouts?: (ids: readonly number[]) => unknown;
};

const layoutGlobal = globalThis as typeof globalThis & {
  pocket?: PocketLayoutGlobal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readValue<T>(value: SemanticValue<T> | undefined, fallback: T): T {
  try {
    const resolved = typeof value === "function" ? (value as () => T)() : value;
    return resolved === undefined ? fallback : resolved;
  } catch {
    return fallback;
  }
}

function readBoolean(value: SemanticValue<boolean> | undefined, fallback = false): boolean {
  const resolved = readValue(value, fallback);
  return typeof resolved === "boolean" ? resolved : fallback;
}

function readOptionalBoolean(value: SemanticValue<boolean> | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  try {
    const resolved = typeof value === "function" ? (value as () => boolean)() : value;
    return typeof resolved === "boolean" ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function readLabel(value: SemanticValue<string>): string {
  try {
    const resolved = typeof value === "function" ? (value as () => string)() : value;
    return typeof resolved === "string" ? resolved : "";
  } catch {
    return "";
  }
}

function readRouteActive(
  control: AppleSemanticControl,
  providerRouteActive: SemanticValue<boolean> | undefined,
): boolean {
  return readBoolean(control.routeActive ?? providerRouteActive, true);
}

function parseCommittedRect(raw: unknown): AppleSemanticRect | undefined {
  if (!isRecord(raw)) return undefined;
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const width = finiteNumber(raw.width ?? raw.w);
  const height = finiteNumber(raw.height ?? raw.h);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function readCommittedLayout(node: NodeMirror | undefined): AppleSemanticRect | undefined {
  const getLayout = layoutGlobal.pocket?.getLayout;
  if (!node || typeof getLayout !== "function") return undefined;
  try {
    return parseCommittedRect(getLayout(node.id));
  } catch {
    return undefined;
  }
}

function readCommittedLayoutsBatch(
  nodes: readonly (NodeMirror | undefined)[],
): readonly (AppleSemanticRect | undefined)[] {
  if (nodes.length === 0) return [];
  const getLayouts = layoutGlobal.pocket?.getLayouts;
  if (typeof getLayouts === "function") {
    try {
      const ids: number[] = [];
      const indexMap: number[] = [];
      for (let idx = 0; idx < nodes.length; idx++) {
        const node = nodes[idx];
        if (node) {
          ids.push(node.id);
          indexMap.push(idx);
        }
      }
      if (ids.length === 0) return new Array(nodes.length).fill(undefined);
      const rawBatch = getLayouts(ids);
      if (Array.isArray(rawBatch) && rawBatch.length === ids.length) {
        const out = new Array<AppleSemanticRect | undefined>(nodes.length).fill(undefined);
        for (let k = 0; k < ids.length; k++) {
          out[indexMap[k]!] = parseCommittedRect(rawBatch[k]);
        }
        return out;
      }
    } catch {
      // Fall back to individual getLayout reads when batch host call fails.
    }
  }
  return nodes.map((node) => readCommittedLayout(node));
}

function semanticSnapshotsEqual(
  left: readonly SemanticSnapshotNode[],
  right: readonly SemanticSnapshotNode[],
): boolean {
  if (left.length !== right.length) return false;
  for (let idx = 0; idx < left.length; idx++) {
    const a = left[idx]!;
    const b = right[idx]!;
    if (
      a.guestId !== b.guestId ||
      a.nativeId !== b.nativeId ||
      a.label !== b.label ||
      a.role !== b.role ||
      a.selected !== b.selected ||
      a.disabled !== b.disabled ||
      a.enabled !== b.enabled ||
      !Object.is(a.checked, b.checked) ||
      !Object.is(a.rect.x, b.rect.x) ||
      !Object.is(a.rect.y, b.rect.y) ||
      !Object.is(a.rect.width, b.rect.width) ||
      !Object.is(a.rect.height, b.rect.height)
    ) {
      return false;
    }
  }
  return true;
}

function globalBridge(): AppleSemanticsBridge {
  return globalThis as typeof globalThis & AppleSemanticsBridge;
}

function resolveBridge(bridge?: AppleSemanticsBridge): AppleSemanticsBridge {
  const supplied = bridge ?? {};
  if (typeof supplied.emit === "function" || typeof supplied.onEvent === "function") {
    return supplied;
  }
  if (supplied.__pocketHostBridge) return supplied.__pocketHostBridge;
  const global = globalBridge();
  if (typeof global.emit === "function" || typeof global.onEvent === "function") return global;
  return global.__pocketHostBridge ?? supplied;
}

function actionGuestId(params: Record<string, unknown>): string | undefined {
  const value = params.guestId ?? params.id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function actionGeneration(params: Record<string, unknown>): number | undefined {
  const value = params.generation;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function intersectRect(rect: AppleSemanticRect, clip: AppleSemanticRect): AppleSemanticRect | undefined {
  const left = Math.max(rect.x, clip.x);
  const top = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Create the one app-level Apple semantic store.
 *
 * The returned store observes only explicit registrations. Its normal frame
 * hook is passive (`continuous: false`), measures committed `pocket.getLayout`
 * on every already-delivered work frame, and deduplicates the snapshot. A
 * newly bound node gets at most three temporary continuous wake frames so a
 * static page cannot lose its first layout admission when the first read is
 * one commit too early; the hint parks immediately after that bound.
 */
export function createAppleSemanticsStore(options: AppleSemanticsOptions = {}): AppleSemanticsStore {
  const bridge = resolveBridge(options.bridge);
  const requestedMax = options.maxControls;
  const maxControls = Number.isFinite(requestedMax)
    ? Math.min(MAX_APPLE_SEMANTIC_CONTROLS, Math.max(1, Math.trunc(requestedMax!)))
    : MAX_APPLE_SEMANTIC_CONTROLS;
  const entries = new Map<string, SemanticEntry>();
  let disposed = false;
  let hasSnapshot = false;
  let lastNodes: readonly SemanticSnapshotNode[] = [];
  let lastGeneration = 0;

  const armInitialMeasurement = (entry: SemanticEntry): void => {
    entry.needsInitialMeasurement = true;
    entry.initialMeasurementFrames = INITIAL_MEASUREMENT_FRAMES;
  };

  const hasPendingInitialMeasurements = (): boolean => {
    for (const entry of entries.values()) {
      if (!entry.needsInitialMeasurement) continue;
      if (readRouteActive(entry.control, options.routeActive)) return true;
    }
    return false;
  };

  const emitPayload = (nodes: readonly SemanticSnapshotNode[], force = false): boolean => {
    if (disposed && !force) return false;
    if (typeof bridge.emit !== "function") return false;
    if (!force && hasSnapshot && semanticSnapshotsEqual(lastNodes, nodes)) {
      return true;
    }
    const generation = lastGeneration + 1;
    const controls = nodes.map((node) => ({
      guestId: node.guestId,
      nativeId: node.nativeId,
      label: node.label,
      role: node.role,
      selected: node.selected,
      disabled: node.disabled,
      enabled: node.enabled,
      ...(node.checked === undefined ? {} : { checked: node.checked }),
      rect: {
        x: node.rect.x,
        y: node.rect.y,
        width: node.rect.width,
        height: node.rect.height,
      },
    }));
    let accepted = false;
    try {
      accepted = bridge.emit?.(ACCESSIBILITY_SNAPSHOT_EVENT, {
        generation,
        controls,
      } as BridgeObject) === true;
    } catch {
      accepted = false;
    }
    if (accepted) {
      lastGeneration = generation;
      lastNodes = nodes;
      hasSnapshot = true;
    }
    return accepted;
  };

  const flush = (): void => {
    if (disposed) return;
    const activeEntries: SemanticEntry[] = [];
    for (const entry of entries.values()) {
      const routeActive = readRouteActive(entry.control, options.routeActive);
      if (entry.routeActive === false && routeActive) armInitialMeasurement(entry);
      entry.routeActive = routeActive;
      if (!routeActive) continue;
      activeEntries.push(entry);
    }
    const committedBatch = readCommittedLayoutsBatch(
      activeEntries.map((entry) => entry.node),
    );
    const nodes: SemanticSnapshotNode[] = [];
    let pendingAdmission = false;
    for (let idx = 0; idx < activeEntries.length; idx++) {
      const entry = activeEntries[idx]!;
      const committed = committedBatch[idx];
      if (!committed || !entry.node) {
        if (entry.needsInitialMeasurement) {
          entry.initialMeasurementFrames -= 1;
          if (entry.initialMeasurementFrames <= 0) entry.needsInitialMeasurement = false;
          else pendingAdmission = true;
        }
        continue;
      }
      entry.needsInitialMeasurement = false;
      entry.initialMeasurementFrames = 0;
      let rect: AppleSemanticRect | undefined = committed;
      const visualRect = entry.control.visualRect ?? options.visualRect;
      if (visualRect) {
        try {
          rect = visualRect(entry.node, committed) ?? undefined;
        } catch {
          rect = undefined;
        }
        if (!rect) continue;
      }
      const clip = readValue(entry.control.clipRect ?? options.clipRect, undefined);
      if (clip) {
        rect = intersectRect(rect, clip);
        if (!rect) continue;
      }
      const disabled = readBoolean(entry.control.disabled, false);
      const selected = readBoolean(entry.control.selected, false);
      const checked = readOptionalBoolean(entry.control.checked);
      const role: AppleSemanticRole = entry.control.role === "tab" ? "tab" : "button";
      nodes.push({
        guestId: entry.control.id,
        nativeId: entry.node!.id,
        label: readLabel(entry.control.label),
        role,
        selected,
        disabled,
        enabled: !disabled,
        rect,
        ...(checked === undefined ? {} : { checked }),
      });
      if (nodes.length >= maxControls) break;
    }
    // Do not publish a first partial/empty tree while a newly bound static
    // node still has its bounded committed-layout admission retries. Once an
    // earlier snapshot exists, retaining it avoids an accessibility flicker
    // while another control settles.
    if (pendingAdmission && !hasSnapshot) return;
    emitPayload(nodes);
  };

  const onHostEvent = (event: HostEvent): void => {
    if (disposed || event.method !== ACCESSIBILITY_ACTION_EVENT) return;
    const params = event.params as Record<string, unknown>;
    const action = params.action;
    if (action !== "activate") return;
    const generation = actionGeneration(params);
    if (generation !== undefined && generation !== lastGeneration) return;
    const id = actionGuestId(params);
    if (!id) return;
    const entry = entries.get(id);
    if (!entry || !readRouteActive(entry.control, options.routeActive)) return;
    if (readBoolean(entry.control.disabled, false)) return;
    try {
      entry.control.onActivate?.();
    } catch {
      // Keep the shared host event lane alive when a JS callback fails.
    }
  };

  const removeHostEvent = bridge.onEvent?.(onHostEvent);

  const unregister = (id: string): void => {
    entries.delete(id);
  };

  const register = (control: AppleSemanticControl): AppleSemanticNodeRef => {
    if (disposed) return () => {};
    if (typeof control.id !== "string" || control.id.length === 0) {
      throw new TypeError("Apple semantic control id must be a non-empty stable string");
    }
    if (entries.has(control.id)) {
      throw new Error(`Apple semantic control id is already registered: ${control.id}`);
    }
    if (entries.size >= maxControls) {
      throw new RangeError(`Apple semantic control limit reached (${maxControls})`);
    }
    const entry: SemanticEntry = {
      control,
      node: undefined,
      routeActive: undefined,
      needsInitialMeasurement: true,
      initialMeasurementFrames: INITIAL_MEASUREMENT_FRAMES,
    };
    entries.set(control.id, entry);
    try {
      onCleanup(() => unregister(control.id));
    } catch {
      // No owner scope: the explicit unregister/dispose API remains valid.
    }

    return (node) => {
      const current = entries.get(control.id);
      if (!current || current.node === node) return;
      current.node = node ?? undefined;
      armInitialMeasurement(current);
    };
  };

  try {
    onFrame(flush, {
      // Layout and paint transforms can change while a guest animation or
      // scroll already owns the frame. Keep normal observation passive. Only
      // the bounded initial-admission predicate below may briefly request
      // continuous frames, and it parks after three failed reads.
      active: () => !disposed,
      continuous: hasPendingInitialMeasurements,
    });
  } catch {
    // A store may be constructed before a Solid frame owner exists. The
    // provider path installs this hook normally.
  }

  const dispose = (): void => {
    if (disposed) return;
    // Publish an explicit empty snapshot before detaching the listener so the
    // Flutter overlay cannot retain controls from a removed route/provider.
    if (hasSnapshot || entries.size > 0) {
      emitPayload([], true);
    }
    disposed = true;
    removeHostEvent?.();
    entries.clear();
  };

  const store: AppleSemanticsStore = {
    register,
    unregister,
    dispose,
    get generation(): number { return lastGeneration; },
  };
  return store;
}

/** App-level provider. Root should create one and pass it to Apple controls. */
export function AppleSemanticsProvider(props: AppleSemanticsProviderProps): JSX.Element {
  const store = props.store ?? createAppleSemanticsStore(props);
  let ownsStore = props.store === undefined;
  try {
    onCleanup(() => {
      if (ownsStore) store.dispose();
      ownsStore = false;
    });
  } catch {
    // Explicitly supplied stores are owned by the caller.
  }
  return AppleSemanticsContext.Provider({
    get value() { return store; },
    get children() { return props.children; },
  });
}

export function useAppleSemantics(): AppleSemanticsStore | undefined {
  const store = useContext(AppleSemanticsContext);
  return store;
}
