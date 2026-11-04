/**
 * Shared display-geometry contract for adaptive PocketJS layouts.
 *
 * `PocketView` publishes the logical guest viewport plus UIKit ReservedRegion
 * frames through `display.viewport`. This module keeps the interpretation in
 * the public JS UI package so individual apps do not invent Duo/foldable
 * heuristics. Frames are already in guest-canvas coordinates; no DPR or
 * Flutter-safe-area conversion belongs here.
 */

export type DisplayRegionKind = "division" | "occlusion";

export interface DisplayInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface DisplayRegionFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayRegion {
  id: string;
  kind: DisplayRegionKind;
  frame: DisplayRegionFrame;
  margins: DisplayInsets;
  active: boolean;
}

export interface DisplayGeometry {
  width: number;
  height: number;
  safeArea: DisplayInsets;
  keyboardInset: number;
  reservedRegions: readonly DisplayRegion[];
}

export interface ResponsiveLayout {
  mode: "narrow" | "wide";
  navigation: "bottom" | "rail";
  railSide: "left" | "right";
  insets: DisplayInsets;
  division?: DisplayRegion;
}

export interface DisplayPane extends DisplayRegionFrame {
  side: "left" | "right";
}

const EMPTY_INSETS: DisplayInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export const EMPTY_DISPLAY_GEOMETRY: DisplayGeometry = {
  width: 390,
  height: 669,
  safeArea: EMPTY_INSETS,
  keyboardInset: 0,
  reservedRegions: [],
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback = 0): number {
  return Math.max(0, finite(value, fallback));
}

function insets(value: unknown): DisplayInsets {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_INSETS };
  const record = value as Record<string, unknown>;
  return {
    top: nonNegative(record.top),
    right: nonNegative(record.right),
    bottom: nonNegative(record.bottom),
    left: nonNegative(record.left),
  };
}

/** Parse a complete safe-area field while preserving fallback on partial data. */
function completeInsets(value: unknown): DisplayInsets | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const values = [record.top, record.right, record.bottom, record.left];
  if (!values.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)) return undefined;
  return {
    top: values[0] as number,
    right: values[1] as number,
    bottom: values[2] as number,
    left: values[3] as number,
  };
}

function frame(value: unknown): DisplayRegionFrame | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const width = nonNegative(record.width);
  const height = nonNegative(record.height);
  const left = finite(record.left);
  const top = finite(record.top);
  if (width <= 0 || height <= 0) return undefined;
  return { left, top, width, height };
}

function parseRegion(value: unknown): DisplayRegion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "division" && kind !== "occlusion") return undefined;
  const parsedFrame = frame(record.frame);
  if (!parsedFrame) return undefined;
  return {
    id: typeof record.id === "string" ? record.id : "",
    kind,
    frame: parsedFrame,
    margins: insets(record.margins),
    active: record.active === true,
  };
}

/** Parse a host `display.viewport` payload without throwing on old hosts. */
export function parseDisplayGeometry(value: unknown, fallback: DisplayGeometry = EMPTY_DISPLAY_GEOMETRY): DisplayGeometry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const width = finite(record.width, fallback.width);
  const height = finite(record.height, fallback.height);
  const nextWidth = width > 0 ? width : fallback.width;
  const nextHeight = height > 0 ? height : fallback.height;
  const widthChanged = nextWidth !== fallback.width;
  // The native resize ABI deliberately emits only width/height. Keep the
  // last complete geometry for same-width updates, including keyboard-driven
  // height changes. When the real window width changes, discard coordinates
  // that belong to the old window until the host publishes its matching full
  // snapshot. An explicit [] still clears regions on either path.
  const rawRegions = Array.isArray(record.reservedRegions)
    ? record.reservedRegions
    : widthChanged ? [] : fallback.reservedRegions;
  const reservedRegions = rawRegions.map(parseRegion).filter((region): region is DisplayRegion => region !== undefined);
  const safeArea = record.safeArea === undefined
    ? fallback.safeArea
    : completeInsets(record.safeArea) ?? fallback.safeArea;
  const keyboardInset = record.keyboardInset === undefined
    ? fallback.keyboardInset
    : nonNegative(record.keyboardInset, fallback.keyboardInset);
  return {
    width: nextWidth,
    height: nextHeight,
    safeArea,
    keyboardInset,
    reservedRegions,
  };
}

function activeRegions(geometry: DisplayGeometry): readonly DisplayRegion[] {
  return geometry.reservedRegions.filter((region) => region.active);
}

/** Return edge insets from active occlusions and the host safe area. */
export function reservedInsets(geometry: DisplayGeometry): DisplayInsets {
  const result = { ...geometry.safeArea };
  for (const region of activeRegions(geometry)) {
    // A division is a layout landmark, not an edge-safe-area inset.  Applying
    // its full-height frame to top/bottom would make a folded display lose
    // the complete canvas height.  Only occlusions that cover most of the
    // perpendicular edge can safely become a global inset; a small camera
    // cutout is handled by the host safeArea or its side inset instead of
    // shrinking the whole page.
    if (region.kind !== "occlusion") continue;
    const right = geometry.width - (region.frame.left + region.frame.width);
    const bottom = geometry.height - (region.frame.top + region.frame.height);
    const coversHorizontalEdge = region.frame.width >= geometry.width * 0.6;
    const coversVerticalEdge = region.frame.height >= geometry.height * 0.6;
    if (region.frame.top <= 1 && coversHorizontalEdge) {
      result.top = Math.max(result.top, region.frame.height + region.margins.top);
    }
    if (region.frame.left <= 1 && coversVerticalEdge) {
      result.left = Math.max(result.left, region.frame.width + region.margins.left);
    }
    if (right <= 1 && coversVerticalEdge) {
      result.right = Math.max(result.right, region.frame.width + region.margins.right);
    }
    if (bottom <= 1 && coversHorizontalEdge) {
      result.bottom = Math.max(result.bottom, region.frame.height + region.margins.bottom);
    }
  }
  return result;
}

/**
 * Insets for a full-width horizontal bottom TabBar / NavigationBar.
 *
 * Matching the retained parent's BottomNavigationBar contract, the bar spans
 * the full bottom width and consumes `bottom` safe-area padding for the home
 * indicator. Top-corner occlusions (such as Duo's top-right status cluster,
 * which UIKit conservatively projects into `safeArea.right`) do not reach the
 * bottom edge and must not shift or squish the bottom tabs horizontally. Only
 * an active occlusion that actually intersects the bottom bar band reserves
 * horizontal space in the bottom bar.
 */
export function bottomBarInsets(geometry: DisplayGeometry): DisplayInsets {
  const base = reservedInsets(geometry);
  const bottomBandTop = Math.max(0, geometry.height - (64 + base.bottom));
  let left = 0;
  let right = 0;
  for (const region of activeRegions(geometry)) {
    if (region.kind !== "occlusion") continue;
    const expandedLeft = region.frame.left - region.margins.left;
    const expandedTop = region.frame.top - region.margins.top;
    const expandedWidth = region.frame.width + region.margins.left + region.margins.right;
    const expandedHeight = region.frame.height + region.margins.top + region.margins.bottom;
    const intersectsBottomBand = expandedTop + expandedHeight > bottomBandTop;
    if (!intersectsBottomBand) continue;
    if (expandedLeft <= 1 && expandedWidth < geometry.width * 0.6) {
      left = Math.max(left, expandedLeft + expandedWidth);
    }
    const rightDistance = geometry.width - (expandedLeft + expandedWidth);
    if (rightDistance <= 1 && expandedWidth < geometry.width * 0.6) {
      right = Math.max(right, geometry.width - expandedLeft);
    }
  }
  return {
    top: 0,
    right,
    bottom: base.bottom,
    left,
  };
}

/**
 * Derive a navigation mode from both the viewport and ReservedRegion data.
 * A vertical active division opts into a rail even when a test window is
 * narrower than the ordinary 720px breakpoint. The rail is placed away from
 * the division so the app does not put controls under a hinge/seam.
 */
export function deriveResponsiveLayout(geometry: DisplayGeometry, wideBreakpoint = 720): ResponsiveLayout {
  const division = activeRegions(geometry).find((region) => {
    if (region.kind !== "division") return false;
    const vertical = region.frame.height >= geometry.height * 0.6;
    const horizontal = region.frame.width >= geometry.width * 0.6;
    return vertical && !horizontal;
  });
  const mode = geometry.width >= wideBreakpoint || division !== undefined ? "wide" : "narrow";
  const insets = reservedInsets(geometry);
  const railSide = division
    ? division.frame.left < geometry.width / 2 ? "right" : "left"
    // Treat an equal-inset window as the normal trailing-rail layout. UIKit
    // can briefly publish zero outer insets while the iOS keyboard animates;
    // choosing the leading rail on that tie makes the whole Duo page jump
    // across the hinge and back. A real leading occlusion still wins because
    // its inset is strictly larger than the trailing inset.
    : insets.left > insets.right ? "left" : "right";
  return { mode, navigation: mode === "wide" ? "rail" : "bottom", railSide, insets, division };
}

/** Keep a public helper for callers that need the current content rectangle. */
export function availableDisplayRect(geometry: DisplayGeometry): DisplayRegionFrame {
  const padding = reservedInsets(geometry);
  // PocketView reports keyboardInset only when the guest canvas remains at
  // its full logical height. When Flutter has already resized the runtime
  // frame, the host reports zero and this subtraction is not duplicated.
  return {
    left: padding.left,
    top: padding.top,
    width: Math.max(0, geometry.width - padding.left - padding.right),
    height: Math.max(0, geometry.height - padding.top - padding.bottom - geometry.keyboardInset),
  };
}

/**
 * Return content panes that do not cross an active vertical division.
 *
 * The host safe area trims the outer edges first; a central division then
 * splits the remaining rectangle. Apps can select one pane for a page and
 * reserve the other for a rail, rather than painting controls across a hinge.
 */
export function availableDisplayPanes(geometry: DisplayGeometry): DisplayPane[] {
  const rect = availableDisplayRect(geometry);
  const end = rect.left + rect.width;
  const divisions = activeRegions(geometry)
    .filter((region) => {
      if (region.kind !== "division") return false;
      const vertical = region.frame.height >= geometry.height * 0.6;
      const horizontal = region.frame.width >= geometry.width * 0.6;
      return vertical && !horizontal;
    })
    .sort((left, right) => left.frame.left - right.frame.left);
  if (divisions.length === 0) return [{ ...rect, side: "left" }];
  const panes: DisplayPane[] = [];
  let cursor = rect.left;
  for (const division of divisions) {
    const split = Math.max(rect.left, Math.min(end, division.frame.left));
    if (split > cursor) panes.push({ left: cursor, top: rect.top, width: split - cursor, height: rect.height, side: panes.length === 0 ? "left" : "right" });
    cursor = Math.max(cursor, Math.min(end, division.frame.left + division.frame.width));
  }
  if (end > cursor) panes.push({ left: cursor, top: rect.top, width: end - cursor, height: rect.height, side: panes.length === 0 ? "left" : "right" });
  return panes.length > 0 ? panes : [{ ...rect, side: "left" }];
}

/** Select the pane on the requested side, falling back to the full rectangle. */
export function displayPane(geometry: DisplayGeometry, side: "left" | "right"): DisplayPane {
  const panes = availableDisplayPanes(geometry);
  return side === "right" ? panes[panes.length - 1]! : panes[0]!;
}
