import { test, describe } from "bun:test";
import { strict as assert } from "node:assert";
import {
  avoidDisplayOcclusions,
  DISPLAY_CONTOUR_BOTTOM_TRIM_PX,
  DISPLAY_CONTOUR_CLEARANCE_PX,
  DISPLAY_CONTOUR_RAMP_PX,
  DISPLAY_UI_SAFETY_GAP,
  hasLocalLeftOcclusionInset,
  hasLocalRightOcclusionInset,
  hasLocalTopRightOcclusionInset,
  leftOcclusionFrames,
  pageInsets,
  parseDisplayGeometry,
  reservedInsets,
  rightOcclusionFrames,
  sideContourReservesForBand,
  topRightContourReserveForBand,
  topRightOcclusionFrame,
  type DisplayGeometry,
} from "../src/responsive.ts";

const duoCorner = (safeRight = 0): DisplayGeometry => parseDisplayGeometry({
  width: 951,
  height: 669,
  safeArea: { top: 0, right: safeRight, bottom: 34, left: 0 },
  reservedRegions: [{
    id: "status-icons",
    kind: "occlusion",
    frame: { left: 867, top: 0, width: 84, height: 124 },
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
    active: true,
  }],
});

describe("display occlusion target avoidance", () => {
  test("moves an intersecting top-right target horizontally without adding top inset", () => {
    const geometry = duoCorner();
    const result = avoidDisplayOcclusions(geometry, { left: 899, top: 8, width: 44, height: 44 });
    assert.deepEqual(result, {
      offsetX: -76,
      offsetY: 0,
      rect: { left: 823, top: 8, width: 44, height: 44 },
    });
    assert.equal(reservedInsets(geometry).top, 0);
  });

  test("does not duplicate an existing right safe area", () => {
    const geometry = duoCorner(84);
    const result = avoidDisplayOcclusions(geometry, { left: 815, top: 8, width: 44, height: 44 });
    assert.deepEqual(result, {
      offsetX: 0,
      offsetY: 0,
      rect: { left: 815, top: 8, width: 44, height: 44 },
    });
    assert.equal(reservedInsets(geometry).right, 84);
  });

  test("releases only the open-Duo conservative right projection", () => {
    const open = (divisionActive: boolean) => parseDisplayGeometry({
      width: 951,
      height: 669,
      safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
      reservedRegions: [
        {
          id: "hinge",
          kind: "division",
          frame: { left: 455.5, top: 0, width: 40, height: 669 },
          margins: { top: 0, right: 20, bottom: 0, left: 20 },
          active: divisionActive,
        },
        {
          id: "status-icons",
          kind: "occlusion",
          frame: { left: 867, top: 0, width: 84, height: 124 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        },
      ],
    });
    assert.equal(pageInsets(open(true)).right, 0);
    assert.equal(pageInsets(open(false)).right, 0, "inactive open seam still identifies the two-pane topology");
    assert.equal(pageInsets(duoCorner(84)).right, 84, "without division topology, right remains global");

    for (const left of [0, 1000]) {
      const invalid = open(true);
      const regions = invalid.reservedRegions.map(region => region.kind === "division"
        ? { ...region, frame: { ...region.frame, left } }
        : region);
      assert.equal(pageInsets({ ...invalid, reservedRegions: regions }).right, 84,
        "an edge or out-of-window division must not relax the host safe area");
    }
    assert.equal(pageInsets(parseDisplayGeometry({ ...open(true), safeArea: { top: 0, right: 100, bottom: 34, left: 0 } })).right, 100, "a mismatched safe area is not localized by topology alone");
  });

  test("ignores divisions, inactive regions, and non-overlapping body rectangles", () => {
    const geometry = parseDisplayGeometry({
      width: 951,
      height: 669,
      reservedRegions: [
        {
          id: "hinge",
          kind: "division",
          frame: { left: 455.5, top: 0, width: 40, height: 669 },
          margins: { top: 0, right: 20, bottom: 0, left: 20 },
          active: true,
        },
        {
          id: "inactive-icons",
          kind: "occlusion",
          frame: { left: 867, top: 0, width: 84, height: 124 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: false,
        },
      ],
    });
    for (const target of [
      { left: 455, top: 8, width: 44, height: 44 },
      { left: 0, top: 200, width: 951, height: 400 },
    ]) {
      assert.equal(avoidDisplayOcclusions(geometry, target).offsetX, 0);
      assert.equal(avoidDisplayOcclusions(geometry, target).offsetY, 0);
    }
  });

  test("follows rotated geometry and current regions", () => {
    const folded = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
      reservedRegions: [{
        id: "status-icons-folded",
        kind: "occlusion",
        frame: { left: 382, top: 0, width: 84, height: 174 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    assert.equal(avoidDisplayOcclusions(folded, { left: 330, top: 8, width: 44, height: 44 }).offsetX, 0);
    // Feed the rotated snapshot through the same fallback state a display
    // signal uses, rather than constructing a second unrelated geometry.
    const unfolded = parseDisplayGeometry({
      width: 951,
      height: 669,
      safeArea: { top: 0, right: 0, bottom: 34, left: 0 },
      reservedRegions: [],
    }, folded);
    assert.deepEqual(avoidDisplayOcclusions(unfolded, { left: 899, top: 8, width: 44, height: 44 }), {
      offsetX: 0,
      offsetY: 0,
      rect: { left: 899, top: 8, width: 44, height: 44 },
    });
  });

  test("clears the measured top-right contour below the status strip", () => {
    const openPlacement = avoidDisplayOcclusions(
      duoCorner(84),
      { left: 899, top: 8, width: 44, height: 44 },
      { prefer: "vertical" },
    );
    assert.deepEqual(topRightOcclusionFrame(duoCorner(84)), { left: 867, top: 0, width: 84, height: 124 });
    assert.equal(openPlacement.offsetX, 0);
    assert.equal(openPlacement.offsetY, 116, "right-rail close target clears the full measured open contour");

    const marginGeometry = parseDisplayGeometry({
      ...duoCorner(84),
      reservedRegions: [{
        id: "status-icons-with-margin",
        kind: "occlusion",
        frame: { left: 867, top: 0, width: 84, height: 124 },
        margins: { top: 4, right: 2, bottom: 12, left: 3 },
        active: true,
      }],
    });
    assert.deepEqual(topRightOcclusionFrame(marginGeometry), { left: 864, top: -4, width: 89, height: 140 });

    const folded = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
      reservedRegions: [{
        id: "status-icons-folded",
        kind: "occlusion",
        frame: { left: 382, top: 0, width: 84, height: 174 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    const foldedPlacement = avoidDisplayOcclusions(folded, { left: 414, top: 8, width: 44, height: 44 }, { prefer: "vertical" });
    assert.equal(foldedPlacement.offsetX, 0);
    assert.equal(foldedPlacement.offsetY, 166);
    assert.equal(8 + foldedPlacement.offsetY, 174, "folded close sits directly below the measured contour; no duplicate UI gap");
  });

  test("computes progressive smoothstep width reservation across the top-right contour band", () => {
    const folded = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
      reservedRegions: [{
        id: "status-icons-folded",
        kind: "occlusion",
        frame: { left: 382, top: 0, width: 84, height: 174 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    assert.equal(hasLocalTopRightOcclusionInset(folded), true);
    assert.equal(hasLocalTopRightOcclusionInset(duoCorner(0)), false);
    assert.equal(DISPLAY_CONTOUR_CLEARANCE_PX, 5);
    assert.equal(DISPLAY_CONTOUR_BOTTOM_TRIM_PX, 14);
    assert.equal(DISPLAY_CONTOUR_RAMP_PX, 5);
    const maxReserve = 84 + DISPLAY_CONTOUR_CLEARANCE_PX;
    const cutoutBottom = 174 - DISPLAY_CONTOUR_BOTTOM_TRIM_PX;
    // Items inside or scrolled above the contour band keep full reserve.
    assert.equal(topRightContourReserveForBand(folded, 0, 56), maxReserve);
    assert.equal(topRightContourReserveForBand(folded, 120, 180), maxReserve);
    assert.equal(topRightContourReserveForBand(folded, cutoutBottom, 240), maxReserve);
    assert.equal(topRightContourReserveForBand(folded, -80, -20), maxReserve, "offscreen above-viewport items retain reserve to prevent reflow jumps");
    // Items below the ramp stay full-width.
    assert.equal(topRightContourReserveForBand(folded, cutoutBottom + DISPLAY_CONTOUR_RAMP_PX, 260), 0);
    assert.equal(topRightContourReserveForBand(folded, 300, 380), 0);
    // Mid-ramp (t = 0.5) on smoothstep (3t^2 - 2t^3 = 0.5) yields half of maxReserve (rounded to 0.5pt).
    const midTop = cutoutBottom + DISPLAY_CONTOUR_RAMP_PX / 2;
    assert.equal(topRightContourReserveForBand(folded, midTop, midTop + 60), Math.round(maxReserve * 0.5 * 2) / 2);
    // Reserve increases monotonically as visualTop scrolls upward through the ramp.
    let previous = 0;
    for (let y = cutoutBottom + DISPLAY_CONTOUR_RAMP_PX; y >= cutoutBottom; y -= 1) {
      const current = topRightContourReserveForBand(folded, y, y + 60);
      assert.ok(current >= previous, `reserve must grow monotonically as y decreases (${y}: ${current} < ${previous})`);
      previous = current;
    }
    assert.equal(previous, maxReserve);

    // Left-column items whose unreserved right boundary already clears the contour keep 0 reserve.
    assert.equal(topRightContourReserveForBand(folded, 20, 80, { itemRight: 220 }), 0);
    // Partially overlapping columns reserve only their horizontal protrusion into the contour.
    assert.equal(topRightContourReserveForBand(folded, 20, 80, { itemRight: 410 }), 410 - (466 - maxReserve));
  });

  test("handles overlapping multi-region top-right contours and preserves full-height right obstructions", () => {
    const stepped = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 140, bottom: 34, left: 0 },
      reservedRegions: [
        {
          id: "status-cluster-tall",
          kind: "occlusion",
          frame: { left: 382, top: 0, width: 84, height: 174 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        },
        {
          id: "status-strip-wide",
          kind: "occlusion",
          frame: { left: 326, top: 0, width: 140, height: 44 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        },
      ],
    });
    assert.equal(hasLocalTopRightOcclusionInset(stepped), true);
    assert.equal(topRightContourReserveForBand(stepped, 10, 40), 140 + DISPLAY_CONTOUR_CLEARANCE_PX);
    assert.equal(topRightContourReserveForBand(stepped, 120, 160), 84 + DISPLAY_CONTOUR_CLEARANCE_PX);

    const mixedFullHeight = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
      reservedRegions: [
        {
          id: "status-corner",
          kind: "occlusion",
          frame: { left: 382, top: 0, width: 84, height: 174 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        },
        {
          id: "right-bezel-obstruction",
          kind: "occlusion",
          frame: { left: 382, top: 0, width: 84, height: 678 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        },
      ],
    });
    assert.equal(
      hasLocalTopRightOcclusionInset(mixedFullHeight),
      false,
      "a full-height right-edge obstruction must never be released as a local corner inset",
    );

    const marginFullHeight = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 86, bottom: 34, left: 0 },
      reservedRegions: [
        {
          id: "status-corner",
          kind: "occlusion",
          frame: { left: 382, top: 0, width: 84, height: 174 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        },
        {
          id: "margin-bezel-obstruction",
          kind: "occlusion",
          frame: { left: 380, top: 0, width: 70, height: 678 },
          margins: { top: 0, right: 16, bottom: 0, left: 0 },
          active: true,
        },
      ],
    });
    assert.equal(
      hasLocalTopRightOcclusionInset(marginFullHeight),
      false,
      "a full-height obstruction touching the right edge via margins must not be released",
    );

    const tallExpandedOcclusion = parseDisplayGeometry({
      width: 466,
      height: 678,
      safeArea: { top: 0, right: 84, bottom: 34, left: 0 },
      reservedRegions: [{
        id: "tall-expanded",
        kind: "occlusion",
        frame: { left: 382, top: 0, width: 84, height: 390 },
        margins: { top: 0, right: 0, bottom: 20, left: 0 },
        active: true,
      }],
    });
    assert.equal(
      hasLocalTopRightOcclusionInset(tallExpandedOcclusion),
      false,
      "an occlusion whose expanded height reaches 60% of the viewport is not a local corner inset",
    );
  });

  test("computes progressive left and right contour reserves for landscape notches and single hole-punches", () => {
    const landscapeLeftNotch = parseDisplayGeometry({
      width: 844,
      height: 390,
      safeArea: { top: 0, right: 0, bottom: 21, left: 44 },
      reservedRegions: [{
        id: "landscape-notch-left",
        kind: "occlusion",
        frame: { left: 0, top: 120, width: 44, height: 150 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    assert.equal(hasLocalLeftOcclusionInset(landscapeLeftNotch), true, "landscape left notch is a local side occlusion");
    assert.equal(hasLocalRightOcclusionInset(landscapeLeftNotch), false);
    assert.equal(leftOcclusionFrames(landscapeLeftNotch).length, 1);

    const maxLeft = 44 + DISPLAY_CONTOUR_CLEARANCE_PX;
    assert.deepEqual(
      sideContourReservesForBand(landscapeLeftNotch, 276, 330),
      { left: 0, right: 0 },
      "items below `cutoutBottom + 5px` stay full-width in landscape",
    );
    const bottomMidRamp = sideContourReservesForBand(landscapeLeftNotch, 270 + DISPLAY_CONTOUR_RAMP_PX / 2, 320);
    assert.equal(bottomMidRamp.left, Math.round(maxLeft * 0.5 * 2) / 2, "bottom ramp midpoint uses smoothstep 0.5");
    assert.deepEqual(
      sideContourReservesForBand(landscapeLeftNotch, 160, 220),
      { left: maxLeft, right: 0 },
      "items overlapping the landscape left notch reserve `44 + 5 = 49px` on the left",
    );
    assert.deepEqual(
      sideContourReservesForBand(landscapeLeftNotch, 160, 220, { itemLeft: 16 }),
      { left: maxLeft - 16, right: 0 },
      "container left margin is subtracted so item left border sits 5px from the notch",
    );
    const topMidRamp = sideContourReservesForBand(landscapeLeftNotch, 60, 120 - DISPLAY_CONTOUR_RAMP_PX / 2);
    assert.equal(topMidRamp.left, Math.round(maxLeft * 0.5 * 2) / 2, "top exit ramp midpoint smoothly restores width above the notch");
    assert.deepEqual(
      sideContourReservesForBand(landscapeLeftNotch, 16, 120 - DISPLAY_CONTOUR_RAMP_PX),
      { left: 0, right: 0 },
      "items scrolled completely above a mid-edge landscape notch restore full width",
    );

    const landscapeRightPunchHole = parseDisplayGeometry({
      width: 800,
      height: 360,
      safeArea: { top: 0, right: 36, bottom: 16, left: 0 },
      reservedRegions: [{
        id: "single-hole-right",
        kind: "occlusion",
        frame: { left: 764, top: 166, width: 28, height: 28 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    assert.equal(hasLocalRightOcclusionInset(landscapeRightPunchHole), true, "inset single hole-punch matching safeArea.right is recognized");
    assert.equal(rightOcclusionFrames(landscapeRightPunchHole).length, 1);
    const holeMaxRight = (800 - 764) + DISPLAY_CONTOUR_CLEARANCE_PX;
    assert.deepEqual(
      sideContourReservesForBand(landscapeRightPunchHole, 200, 260),
      { left: 0, right: 0 },
      "cards below the 28px single hole-punch are full-width",
    );
    assert.deepEqual(
      sideContourReservesForBand(landscapeRightPunchHole, 170, 210),
      { left: 0, right: holeMaxRight },
      "card overlapping the 28px single hole-punch indents locally on the right",
    );
    assert.deepEqual(
      sideContourReservesForBand(landscapeRightPunchHole, 40, 160),
      { left: 0, right: 0 },
      "cards above the 28px single hole-punch are full-width",
    );

    const leftWithOutwardMarginAndTallTopCutout = parseDisplayGeometry({
      width: 844,
      height: 390,
      safeArea: { top: 0, right: 0, bottom: 0, left: 40 },
      reservedRegions: [{
        id: "top-left-tall-notch",
        kind: "occlusion",
        frame: { left: 0, top: 0, width: 40, height: 100 },
        margins: { top: 0, right: 0, bottom: 0, left: 4 },
        active: true,
      }],
    });
    assert.equal(
      hasLocalLeftOcclusionInset(leftWithOutwardMarginAndTallTopCutout),
      true,
      "left-edge occlusion with outward left margin is still recognized as a local left occlusion",
    );
    assert.deepEqual(
      sideContourReservesForBand(leftWithOutwardMarginAndTallTopCutout, 95, 130),
      { left: 40 + DISPLAY_CONTOUR_CLEARANCE_PX, right: 0 },
      "tall top-left cutout does not apply the 14px top-right status-cluster bottom trim",
    );

    const tallRightPhysicalNotchAtTop = parseDisplayGeometry({
      width: 640,
      height: 360,
      safeArea: { top: 0, right: 32, bottom: 0, left: 0 },
      reservedRegions: [{
        id: "landscape-right-notch-top",
        kind: "occlusion",
        frame: { left: 608, top: 0, width: 32, height: 150 },
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        active: true,
      }],
    });
    assert.deepEqual(
      sideContourReservesForBand(tallRightPhysicalNotchAtTop, 141, 253),
      { left: 0, right: 32 + DISPLAY_CONTOUR_CLEARANCE_PX },
      "tall right-edge physical notch at y=0 preserves full vertical protection at its bottom edge",
    );
  });
});
