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

export type WindowSizeClass = "compact" | "medium" | "expanded";
export type DesignDensity = "touch" | "desktop";

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

export interface DisplayOcclusionAvoidance {
  /** Translation to apply to the target in the same logical coordinate space. */
  offsetX: number;
  offsetY: number;
  /** The translated target rectangle selected by the helper. */
  rect: DisplayRegionFrame;
}

export interface DisplayOcclusionAvoidanceOptions {
  /** Which axis should win when a corner occlusion can be cleared either way. */
  prefer?: "horizontal" | "vertical";
}

function expandedRegionFrame(region: DisplayRegion): DisplayRegionFrame {
  return {
    left: region.frame.left - region.margins.left,
    top: region.frame.top - region.margins.top,
    width: region.frame.width + region.margins.left + region.margins.right,
    height: region.frame.height + region.margins.top + region.margins.bottom,
  };
}

function rectsIntersect(left: DisplayRegionFrame, right: DisplayRegionFrame): boolean {
  return left.left < right.left + right.width
    && left.left + left.width > right.left
    && left.top < right.top + right.height
    && left.top + left.height > right.top;
}

function translatedRect(rect: DisplayRegionFrame, offsetX: number, offsetY: number): DisplayRegionFrame {
  return { ...rect, left: rect.left + offsetX, top: rect.top + offsetY };
}

function fitsDisplay(rect: DisplayRegionFrame, geometry: DisplayGeometry): boolean {
  return rect.left >= 0
    && rect.top >= 0
    && rect.left + rect.width <= geometry.width
    && rect.top + rect.height <= geometry.height;
}

/**
 * Move one local control out of active occlusion rectangles.
 *
 * `target` and ReservedRegion frames are already in the guest logical
 * coordinate space. The caller applies its page/host edge insets first; this helper
 * therefore never clears or reinterprets the host safe area and cannot add a
 * second copy of an existing edge inset. Divisions are deliberately ignored.
 * A non-overlapping target is a zero-offset no-op, so full-width body/canvas
 * layout is unchanged. This is especially important on Duo: the top-right
 * system icons are a local corner obstruction, not a reason for full-top
 * blank space.
 */
export function avoidDisplayOcclusions(
  geometry: DisplayGeometry,
  target: DisplayRegionFrame,
  options: DisplayOcclusionAvoidanceOptions = {},
): DisplayOcclusionAvoidance {
  const normalized: DisplayRegionFrame = {
    left: finite(target.left),
    top: finite(target.top),
    width: nonNegative(target.width),
    height: nonNegative(target.height),
  };
  const zero = { offsetX: 0, offsetY: 0, rect: normalized };
  if (normalized.width <= 0 || normalized.height <= 0 || geometry.width <= 0 || geometry.height <= 0) return zero;

  const occlusions = activeRegions(geometry)
    .filter((region) => region.kind === "occlusion")
    .map(expandedRegionFrame);
  const intersecting = occlusions.filter((region) => rectsIntersect(normalized, region));
  if (intersecting.length === 0) return zero;

  // Candidate translations clear one edge of an intersecting region. Trying
  // all candidates then validates against every active occlusion, so nearby
  // camera/hinge rectangles cannot be cleared by moving under another one.
  const candidates: Array<{ offsetX: number; offsetY: number }> = [];
  for (const region of intersecting) {
    candidates.push(
      { offsetX: region.left - (normalized.left + normalized.width), offsetY: 0 },
      { offsetX: region.left + region.width - normalized.left, offsetY: 0 },
      { offsetX: 0, offsetY: region.top - (normalized.top + normalized.height) },
      { offsetX: 0, offsetY: region.top + region.height - normalized.top },
    );
  }
  const prefer = options.prefer ?? "horizontal";
  candidates.sort((left, right) => {
    const leftPreferred = prefer === "horizontal" ? Math.abs(left.offsetY) : Math.abs(left.offsetX);
    const rightPreferred = prefer === "horizontal" ? Math.abs(right.offsetY) : Math.abs(right.offsetX);
    return leftPreferred - rightPreferred
      || (Math.abs(left.offsetX) + Math.abs(left.offsetY)) - (Math.abs(right.offsetX) + Math.abs(right.offsetY));
  });
  for (const candidate of candidates) {
    const rect = translatedRect(normalized, candidate.offsetX, candidate.offsetY);
    if (!fitsDisplay(rect, geometry)) continue;
    if (occlusions.some((region) => rectsIntersect(rect, region))) continue;
    return { ...candidate, rect };
  }
  return zero;
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
    const expanded = expandedRegionFrame(region);
    const right = geometry.width - (expanded.left + expanded.width);
    const bottom = geometry.height - (expanded.top + expanded.height);
    const coversHorizontalEdge = expanded.width >= geometry.width * 0.6;
    const coversVerticalEdge = expanded.height >= geometry.height * 0.6;
    if (expanded.top <= 1 && coversHorizontalEdge) {
      result.top = Math.max(result.top, region.frame.height + region.margins.top);
    }
    if (expanded.left <= 1 && coversVerticalEdge) {
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

const DISPLAY_GEOMETRY_EPSILON = 1;

/** JS control-to-contour spacing; this is not an OS safe-area/margin fact. */
export const DISPLAY_UI_SAFETY_GAP = 12;

/** Horizontal clearance (in logical px) between contour-aware UI items and the real occlusion region. */
export const DISPLAY_CONTOUR_CLEARANCE_PX = 5;

/**
 * Vertical bottom trim (in logical px) for tall top-right status occlusions
 * whose OS frame includes extra bottom padding beyond the visual status pill,
 * keeping bottom clearance aligned with the left clearance.
 */
export const DISPLAY_CONTOUR_BOTTOM_TRIM_PX = 14;

/** Progressive transition ramp height (in logical px) below a top-right display contour. */
export const DISPLAY_CONTOUR_RAMP_PX = 5;

export interface DisplayContourBandOptions {
  /** Vertical trim applied to the occlusion bottom before `extraBottom`. Defaults to `DISPLAY_CONTOUR_BOTTOM_TRIM_PX` for tall corner contours. */
  bottomTrim?: number;
  /** Extra vertical reservation below the occlusion (for example a folded-rail close button). */
  extraBottom?: number;
  /** Extra horizontal reservation at the left edge. */
  extraLeft?: number;
  /** Extra horizontal reservation at the top-right/right edge (for example a top action target). */
  extraRight?: number;
  /** Unreserved left boundary of the item/container in guest-canvas coordinates. Defaults to `0`. */
  itemLeft?: number;
  /** Unreserved right boundary of the item/container in guest-canvas coordinates. Defaults to `geometry.width`. */
  itemRight?: number;
  /** Progressive transition zone height above/below the contour. */
  rampPx?: number;
  /** Clearance between UI content and the occlusion contour. Defaults to `DISPLAY_CONTOUR_CLEARANCE_PX` (5px). */
  safetyGap?: number;
}

export interface DisplaySideContourReserves {
  readonly left: number;
  readonly right: number;
}

function isVerticalDivision(region: DisplayRegion, geometry: DisplayGeometry): boolean {
  const frameRight = region.frame.left + region.frame.width;
  const frameBottom = region.frame.top + region.frame.height;
  return region.kind === "division"
    && region.frame.left > DISPLAY_GEOMETRY_EPSILON
    && region.frame.top >= 0
    && frameRight < geometry.width - DISPLAY_GEOMETRY_EPSILON
    && frameBottom <= geometry.height + DISPLAY_GEOMETRY_EPSILON
    && region.frame.top <= DISPLAY_GEOMETRY_EPSILON
    && frameBottom >= geometry.height - DISPLAY_GEOMETRY_EPSILON
    && region.frame.height >= geometry.height * 0.6
    && region.frame.width < geometry.width * 0.6
    && frameRight > 0;
}

function isCoveredByTopSafeAreaOnly(expanded: DisplayRegionFrame, geometry: DisplayGeometry): boolean {
  return geometry.safeArea.top > DISPLAY_GEOMETRY_EPSILON
    && expanded.top + expanded.height <= geometry.safeArea.top + DISPLAY_GEOMETRY_EPSILON
    && geometry.safeArea.left <= DISPLAY_GEOMETRY_EPSILON
    && geometry.safeArea.right <= DISPLAY_GEOMETRY_EPSILON;
}

function isLocalLeftOcclusion(region: DisplayRegion, geometry: DisplayGeometry): boolean {
  if (region.kind !== "occlusion") return false;
  const expanded = expandedRegionFrame(region);
  const frameRight = region.frame.left + region.frame.width;
  const expandedRight = expanded.left + expanded.width;
  if (isCoveredByTopSafeAreaOnly(expanded, geometry)) return false;
  const maxOuterGap = Math.max(DISPLAY_GEOMETRY_EPSILON, geometry.safeArea.left - expanded.width + DISPLAY_GEOMETRY_EPSILON, 24);
  return region.frame.top >= -DISPLAY_GEOMETRY_EPSILON
    && region.frame.top + region.frame.height <= geometry.height + DISPLAY_GEOMETRY_EPSILON
    && region.frame.left >= -DISPLAY_GEOMETRY_EPSILON
    && frameRight > 0
    && Math.max(0, expanded.left) <= maxOuterGap
    && expandedRight < geometry.width * 0.4
    && expanded.height < geometry.height * 0.6
    && expanded.width < geometry.width * 0.6;
}

function isLocalRightOcclusion(region: DisplayRegion, geometry: DisplayGeometry): boolean {
  if (region.kind !== "occlusion") return false;
  const expanded = expandedRegionFrame(region);
  const frameRight = region.frame.left + region.frame.width;
  const expandedRight = expanded.left + expanded.width;
  if (isCoveredByTopSafeAreaOnly(expanded, geometry)) return false;
  const outerDistance = Math.max(0, geometry.width - expandedRight);
  const maxOuterGap = Math.max(DISPLAY_GEOMETRY_EPSILON, geometry.safeArea.right - expanded.width + DISPLAY_GEOMETRY_EPSILON, 24);
  return region.frame.top >= -DISPLAY_GEOMETRY_EPSILON
    && region.frame.left >= -DISPLAY_GEOMETRY_EPSILON
    && frameRight <= geometry.width + DISPLAY_GEOMETRY_EPSILON
    && region.frame.top + region.frame.height <= geometry.height + DISPLAY_GEOMETRY_EPSILON
    && outerDistance <= maxOuterGap
    && expanded.left > geometry.width * 0.6
    && expanded.height < geometry.height * 0.6
    && expanded.width < geometry.width * 0.6;
}

function isLocalTopRightOcclusion(region: DisplayRegion, geometry: DisplayGeometry): boolean {
  if (!isLocalRightOcclusion(region, geometry)) return false;
  const expanded = expandedRegionFrame(region);
  const expandedRight = expanded.left + expanded.width;
  return expanded.top <= DISPLAY_GEOMETRY_EPSILON
    && geometry.width - expandedRight <= DISPLAY_GEOMETRY_EPSILON;
}

function matchesTopRightOcclusionSafeRight(geometry: DisplayGeometry, insets: DisplayInsets): boolean {
  const safeRight = geometry.safeArea.right;
  if (safeRight <= 0 || Math.abs(insets.right - safeRight) > DISPLAY_GEOMETRY_EPSILON) return false;
  let maxCornerRight = 0;
  for (const region of activeRegions(geometry)) {
    if (region.kind !== "occlusion") continue;
    const expanded = expandedRegionFrame(region);
    const expandedRight = expanded.left + expanded.width;
    const touchesRightEdge = geometry.width - expandedRight <= DISPLAY_GEOMETRY_EPSILON;
    if (!touchesRightEdge) continue;
    if (!isLocalTopRightOcclusion(region, geometry)) {
      // Another active right-edge obstruction (such as a full-height bezel or
      // lower-edge cutout) requires a right inset below the top corner.
      return false;
    }
    maxCornerRight = Math.max(maxCornerRight, region.frame.width + region.margins.right);
  }
  return maxCornerRight > 0 && Math.abs(safeRight - maxCornerRight) <= DISPLAY_GEOMETRY_EPSILON;
}

function matchesSideOcclusionSafeLeft(geometry: DisplayGeometry, insets: DisplayInsets): boolean {
  const safeLeft = geometry.safeArea.left;
  if (safeLeft <= 0 || Math.abs(insets.left - safeLeft) > DISPLAY_GEOMETRY_EPSILON) return false;
  let maxLocalLeft = 0;
  for (const region of activeRegions(geometry)) {
    if (region.kind !== "occlusion") continue;
    const expanded = expandedRegionFrame(region);
    const nearLeftEdge = expanded.left < geometry.width * 0.4;
    if (!nearLeftEdge) continue;
    if (!isLocalLeftOcclusion(region, geometry)) {
      return false;
    }
    maxLocalLeft = Math.max(maxLocalLeft, expanded.left + expanded.width);
  }
  return maxLocalLeft > 0 && Math.abs(safeLeft - maxLocalLeft) <= DISPLAY_GEOMETRY_EPSILON;
}

function matchesSideOcclusionSafeRight(geometry: DisplayGeometry, insets: DisplayInsets): boolean {
  const safeRight = geometry.safeArea.right;
  if (safeRight <= 0 || Math.abs(insets.right - safeRight) > DISPLAY_GEOMETRY_EPSILON) return false;
  let maxLocalRight = 0;
  for (const region of activeRegions(geometry)) {
    if (region.kind !== "occlusion") continue;
    const expanded = expandedRegionFrame(region);
    const nearRightEdge = expanded.left + expanded.width > geometry.width * 0.6;
    if (!nearRightEdge) continue;
    if (!isLocalRightOcclusion(region, geometry)) {
      return false;
    }
    maxLocalRight = Math.max(maxLocalRight, geometry.width - expanded.left, region.frame.width + region.margins.right);
  }
  return maxLocalRight > 0 && Math.abs(safeRight - maxLocalRight) <= DISPLAY_GEOMETRY_EPSILON;
}

function explainsConservativeRightInset(geometry: DisplayGeometry, insets: DisplayInsets): boolean {
  // A division is topology metadata, not an active layout reservation. Keep
  // inactive divisions in this test: open Duo can publish the seam inactive
  // while its right status-icon occlusion remains the same.
  const hasDivisionTopology = geometry.reservedRegions.some(region => isVerticalDivision(region, geometry));
  if (!hasDivisionTopology) return false;
  return matchesTopRightOcclusionSafeRight(geometry, insets);
}

/**
 * True when `safeArea.right` is solely a conservative projection of a local
 * top-right corner occlusion (such as iPhone Duo's camera/clock/status cluster)
 * rather than a full-height vertical edge obstruction.
 */
export function hasLocalTopRightOcclusionInset(geometry: DisplayGeometry): boolean {
  return matchesTopRightOcclusionSafeRight(geometry, reservedInsets(geometry));
}

/**
 * True when `safeArea.left` is solely a conservative projection of local
 * left-side occlusions (such as a landscape notch, Dynamic Island, or single
 * hole-punch) rather than a full-height left bezel.
 */
export function hasLocalLeftOcclusionInset(geometry: DisplayGeometry): boolean {
  return matchesSideOcclusionSafeLeft(geometry, reservedInsets(geometry));
}

/**
 * True when `safeArea.right` is solely a conservative projection of local
 * right-side occlusions (top-right status cluster, landscape notch, Dynamic
 * Island, or single hole-punch) rather than a full-height right bezel.
 */
export function hasLocalRightOcclusionInset(geometry: DisplayGeometry): boolean {
  return matchesSideOcclusionSafeRight(geometry, reservedInsets(geometry));
}

/**
 * Insets for an independent Page shell, retaining the conservative legacy
 * contract everywhere else. On open Duo only, native can conservatively
 * project a top-right icon occlusion into `safeArea.right` even though a
 * vertical division proves the page is a two-pane surface. When that inset
 * exactly matches the local occlusion width, release it for the body and let
 * app-bar/close targets use `avoidDisplayOcclusions` instead. Folded Duo has
 * no division topology, so its right safe area remains global.
 */
export function pageInsets(geometry: DisplayGeometry): DisplayInsets {
  const result = reservedInsets(geometry);
  if (explainsConservativeRightInset(geometry, result)) result.right = 0;
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
 * Return the expanded logical contours of active local left-side occlusions
 * (such as landscape notches, Dynamic Island, or single hole-punches).
 */
export function leftOcclusionFrames(geometry: DisplayGeometry): DisplayRegionFrame[] {
  return activeRegions(geometry)
    .filter(region => isLocalLeftOcclusion(region, geometry))
    .map(region => expandedRegionFrame(region))
    .sort((left, right) => right.height - left.height || right.width - left.width);
}

/**
 * Return the expanded logical contours of active local right-side occlusions
 * (such as top-right status clusters, landscape notches, or single hole-punches).
 */
export function rightOcclusionFrames(geometry: DisplayGeometry): DisplayRegionFrame[] {
  return activeRegions(geometry)
    .filter(region => isLocalRightOcclusion(region, geometry))
    .map(region => expandedRegionFrame(region))
    .sort((left, right) => right.height - left.height || right.width - left.width);
}

/**
 * Return the expanded logical contour of the active top-right occlusion.
 * Margins are part of UIKit's reserved geometry, so consumers must avoid the
 * expanded contour rather than only the raw icon frame. The result is
 * intentionally local; it is not a page-wide top inset.
 */
export function topRightOcclusionFrames(geometry: DisplayGeometry): DisplayRegionFrame[] {
  return rightOcclusionFrames(geometry).filter(region =>
    region.top <= DISPLAY_GEOMETRY_EPSILON
    && region.left + region.width >= geometry.width - DISPLAY_GEOMETRY_EPSILON);
}

export function topRightOcclusionFrame(geometry: DisplayGeometry): DisplayRegionFrame | undefined {
  return topRightOcclusionFrames(geometry)[0];
}

function contourBandFactor(
  top: number,
  bottom: number,
  cutoutTop: number,
  cutoutBottom: number,
  ramp: number,
): number {
  let bottomFactor = 0;
  if (top <= cutoutBottom) {
    bottomFactor = 1;
  } else if (ramp > 0 && top < cutoutBottom + ramp) {
    const linear = Math.max(0, Math.min(1, (cutoutBottom + ramp - top) / ramp));
    bottomFactor = linear * linear * (3 - 2 * linear);
  }
  if (bottomFactor <= 0) return 0;

  // For top-corner cutouts anchored at y=0, keep `topFactor = 1` even after
  // scrolling above the top edge so wrapped text never unwraps offscreen.
  // For mid-edge cutouts (such as landscape notches or single hole-punches
  // where `cutoutTop > 0`), visible screen space exists above the cutout, so
  // smoothly ramp back to full width across `[cutoutTop - ramp, cutoutTop]`.
  let topFactor = 1;
  if (cutoutTop > DISPLAY_GEOMETRY_EPSILON) {
    if (bottom >= cutoutTop) {
      topFactor = 1;
    } else if (ramp > 0 && bottom > cutoutTop - ramp) {
      const linear = Math.max(0, Math.min(1, (bottom - (cutoutTop - ramp)) / ramp));
      topFactor = linear * linear * (3 - 2 * linear);
    } else {
      topFactor = 0;
    }
  }
  return Math.min(bottomFactor, topFactor);
}

/**
 * Compute progressive `{ left, right }` horizontal reservations for a UI item
 * whose painted vertical span is `[visualTop, visualBottom]` in guest-canvas
 * coordinates. Supports top-right status clusters as well as landscape notches,
 * Dynamic Island, and single hole-punches on either the left or right edge.
 */
export function sideContourReservesForBand(
  geometry: DisplayGeometry,
  visualTop: number,
  visualBottom: number,
  options: DisplayContourBandOptions = {},
): DisplaySideContourReserves {
  const leftContours = leftOcclusionFrames(geometry);
  const rightContours = rightOcclusionFrames(geometry);
  if (leftContours.length === 0 && rightContours.length === 0) {
    return { left: 0, right: 0 };
  }
  const top = finite(visualTop);
  const bottom = Math.max(top, finite(visualBottom, top));
  const safetyGap = options.safetyGap !== undefined ? nonNegative(options.safetyGap) : DISPLAY_CONTOUR_CLEARANCE_PX;
  const extraLeft = nonNegative(options.extraLeft);
  const extraRight = nonNegative(options.extraRight);
  const extraBottom = nonNegative(options.extraBottom);
  const ramp = options.rampPx !== undefined ? nonNegative(options.rampPx) : DISPLAY_CONTOUR_RAMP_PX;
  const itemLeft = options.itemLeft !== undefined
    ? Math.min(geometry.width, nonNegative(options.itemLeft))
    : 0;
  const itemRight = options.itemRight !== undefined
    ? Math.min(geometry.width, nonNegative(options.itemRight))
    : geometry.width;

  let bestLeft = 0;
  for (const contour of leftContours) {
    if (bottom <= top && (top > contour.top + contour.height || bottom < contour.top)) continue;
    const requiredLeft = Math.min(geometry.width, contour.left + contour.width + safetyGap + extraLeft);
    const maxReserve = Math.max(0, Math.min(geometry.width, requiredLeft - itemLeft));
    if (maxReserve <= 0) continue;
    const rawBottom = contour.top + contour.height;
    const bottomTrim = options.bottomTrim !== undefined ? nonNegative(options.bottomTrim) : 0;
    const cutoutTop = Math.max(0, contour.top);
    const cutoutBottom = Math.max(cutoutTop, rawBottom - bottomTrim) + extraBottom;
    const factor = contourBandFactor(top, bottom, cutoutTop, cutoutBottom, ramp);
    const regionReserve = Math.round(maxReserve * factor * 2) / 2;
    if (regionReserve > bestLeft) bestLeft = regionReserve;
  }

  let bestRight = 0;
  const hasTopRightPhysicalCutout = activeRegions(geometry).some(
    region => isLocalTopRightOcclusion(region, geometry) && /^display-feature-/.test(region.id),
  );
  for (const contour of rightContours) {
    if (bottom <= top && (top > contour.top + contour.height || bottom < contour.top)) continue;
    const allowedRight = Math.max(0, contour.left - safetyGap - extraRight);
    const maxReserve = Math.max(0, Math.min(geometry.width, itemRight - allowedRight));
    if (maxReserve <= 0) continue;
    const rawBottom = contour.top + contour.height;
    // Only iPhone Duo's wide top-right status capsule (`width >= 60`,
    // `height > 60`) carries 14px of decorative bottom pill padding below the
    // status glyphs; physical right-edge cutouts/notches must keep their full
    // vertical protection.
    const isTopRightStatusCluster = !hasTopRightPhysicalCutout
      && contour.top <= DISPLAY_GEOMETRY_EPSILON
      && contour.left + contour.width >= geometry.width - DISPLAY_GEOMETRY_EPSILON
      && contour.width >= 60
      && contour.height > 60;
    const defaultBottomTrim = isTopRightStatusCluster ? DISPLAY_CONTOUR_BOTTOM_TRIM_PX : 0;
    const bottomTrim = options.bottomTrim !== undefined ? nonNegative(options.bottomTrim) : defaultBottomTrim;
    const cutoutTop = Math.max(0, contour.top);
    const cutoutBottom = Math.max(cutoutTop, rawBottom - bottomTrim) + extraBottom;
    const factor = contourBandFactor(top, bottom, cutoutTop, cutoutBottom, ramp);
    const regionReserve = Math.round(maxReserve * factor * 2) / 2;
    if (regionReserve > bestRight) bestRight = regionReserve;
  }

  return { left: bestLeft, right: bestRight };
}

/**
 * Compute the progressive right-side width reservation for a UI item whose
 * painted vertical span is `[visualTop, visualBottom]` in guest-canvas
 * coordinates.
 */
export function topRightContourReserveForBand(
  geometry: DisplayGeometry,
  visualTop: number,
  visualBottom: number,
  options: DisplayContourBandOptions = {},
): number {
  return sideContourReservesForBand(geometry, visualTop, visualBottom, options).right;
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

/**
 * Derive the Option C 3-tier Window Size Class from the logical guest viewport:
 * - `compact` (< 600px): Phone portrait / WeChat Mini-Program
 * - `medium` (600px..959px): Foldable / Tablet portrait / Two-pane Duo
 * - `expanded` (>= 960px): Desktop / Web / Large tablet
 */
export function deriveWindowSizeClass(geometry: DisplayGeometry): WindowSizeClass {
  const width = finite(geometry?.width, 390);
  if (width >= 960) return "expanded";
  if (width >= 600) return "medium";
  return "compact";
}

/**
 * Derive interactive control density from the viewport or an explicit override:
 * - `touch` (44px target height, 12-16px spacing) for compact/medium viewports
 * - `desktop` (36px target height, 8-12px spacing) for expanded desktop viewports
 */
export function deriveDesignDensity(
  geometry: DisplayGeometry,
  override?: DesignDensity | "auto",
): DesignDensity {
  if (override === "touch" || override === "desktop") return override;
  return deriveWindowSizeClass(geometry) === "expanded" ? "desktop" : "touch";
}
