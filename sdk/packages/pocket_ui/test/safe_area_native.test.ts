import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DISPLAY_CONTOUR_CLEARANCE_PX, DISPLAY_UI_SAFETY_GAP } from "../src/responsive.ts";

type JsonObject = Record<string, unknown>;
type DrawClip = { x?: number; y?: number; w?: number; h?: number };
type DrawOp = JsonObject & { type?: string; text?: string; x?: number; y?: number; w?: number; h?: number; clip?: DrawClip };
type ProbeResponse = { ok?: boolean; error?: string; frame?: { ops?: DrawOp[] } };

const testDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(testDir, "../../..");
const buildGuest = join(sdkRoot, "scripts/build_guest.ts");
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ].find(existsSync);

assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required; set POCKET_NATIVE_PROBE");

const project = mkdtempSync(join(tmpdir(), "pocket-ui-safe-area-native-"));
const output = join(project, "out");
cpSync(join(testDir, "safe_area_fixture"), project, { recursive: true });

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe!, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const outputText = String(result.stdout ?? "").trim();
  assert.ok(outputText, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return outputText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function frameOf(response: ProbeResponse[], index: number): { ops?: DrawOp[] } {
  const frames = response.flatMap((entry) => entry.frame ? [entry.frame] : []);
  assert.ok(frames[index], `missing safe-area frame ${index}`);
  return frames[index]!;
}

function textY(frame: { ops?: DrawOp[] }, value: string): number {
  const op = textOp(frame, value);
  assert.equal(typeof op.y, "number", `${value} must expose y`);
  return op.y!;
}

function textOp(frame: { ops?: DrawOp[] }, value: string, label = "frame"): DrawOp {
  const matches = (frame.ops ?? []).filter((entry) => entry.type === "text" && entry.text === value);
  assert.equal(
    matches.length,
    1,
    `${label} must contain exactly one ${value} slot (texts=${JSON.stringify((frame.ops ?? []).filter((e) => e.type === "text").map((e) => ({ text: e.text, x: e.x, y: e.y, w: e.w, clip: e.clip })))})`,
  );
  const op = matches[0];
  assert.ok(op, `frame is missing ${value}`);
  return op;
}

test("safe area scaffold, transparent mini-app bar, and 5px progressive scroll contour", () => {
  try {
    const build = spawnSync("bun", [buildGuest, `--project-root=${project}`, `--outdir=${output}`], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const bytecodePath = join(output, "app.qjbc");
    const pakPath = join(output, "app.pak");
    assert.ok(existsSync(bytecodePath), "safe-area fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "safe-area fixture PAK is missing");

    for (const width of [390, 320]) {
      const responses = runProbe([
        { op: "create", width, height: 640 },
        { op: "loadBytecode", bytecodePath, pakPath },
        { op: "frame", deltaMs: 16 },
        {
          op: "send",
          message: {
            type: "event",
            name: "display.viewport",
            payload: {
              width,
              height: 640,
              safeArea: { top: 24, right: 0, bottom: 18, left: 0 },
              keyboardInset: 0,
              reservedRegions: [],
            },
          },
        },
        { op: "frame", deltaMs: 16 },
        {
          op: "send",
          message: {
            type: "event",
            name: "display.viewport",
            payload: {
              width,
              height: 640,
              safeArea: { top: 0, right: 84, bottom: 18, left: 0 },
              keyboardInset: 0,
              reservedRegions: [
                {
                  id: "duo-hinge",
                  kind: "division",
                  frame: { left: width / 2 - 20, top: 0, width: 40, height: 640 },
                  margins: { top: 0, right: 20, bottom: 0, left: 20 },
                  active: false,
                },
                {
                  id: "duo-status-icons",
                  kind: "occlusion",
                  frame: { left: Math.max(0, width - 84), top: 0, width: 84, height: 124 },
                  margins: { top: 0, right: 0, bottom: 0, left: 0 },
                  active: true,
                },
              ],
            },
          },
        },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 100, y: 420 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "move", id: 0, x: 100, y: 238 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "move", id: 0, x: 100, y: 180 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "move", id: 0, x: 100, y: 420 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 100, y: 420 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 1, x: 80, y: 380 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 1, x: 80, y: 380 } } },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ]);
      const initial = frameOf(responses, 0);
      const inset = frameOf(responses, 1);
      const corner = frameOf(responses, 2);
      const rampFrame = frameOf(responses, 4);
      const narrowedFrame = frameOf(responses, 5);
      const restoredFrame = frameOf(responses, 6);
      const pressedFrame = frameOf(responses, 9);
      const initialHeaderY = textY(initial, "Safe Header");
      const insetHeaderY = textY(inset, "Safe Header");
      const initialBottomY = textY(initial, "Safe Bottom");
      const insetBottomY = textY(inset, "Safe Bottom");
      const appBarWhiteRect = (initial.ops ?? []).find(
        (entry) => entry.type === "rect" && Number(entry.y) === 0 && Number(entry.h) === 56,
      );
      assert.equal(appBarWhiteRect, undefined, `MobileAppBar must be transparent without a 56px background box at ${width}px`);
      const guest = textOp(inset, "Guest A");
      const subtitle = textOp(inset, "profile guest · shared identity");
      assert.ok(
        Math.abs((insetHeaderY - initialHeaderY) - 24) < 1.1,
        `top safe area must move the standalone app bar by 24 logical px at ${width}px (${initialHeaderY} -> ${insetHeaderY})`,
      );
      assert.ok(textY(inset, "Safe Body") > insetHeaderY, "body must remain below the inset-aware app bar");
      assert.ok(
        Math.abs(insetBottomY - initialBottomY) < 1.1,
        `bottom-bar slot must not receive a second parent bottom inset at ${width}px (${initialBottomY} -> ${insetBottomY})`,
      );
      assert.equal(typeof guest.x, "number", "reserved app-bar action must expose x");
      assert.equal(typeof guest.w, "number", "reserved app-bar action must expose w");
      assert.ok(guest.x! + guest.w! <= width - 60 + 1.1, `Guest A overlaps the 60px host action reserve at ${width}px: x=${guest.x} w=${guest.w}`);
      assert.ok(subtitle.x! + subtitle.w! <= width - 60 + 1.1, `app-bar subtitle overlaps the 60px host action reserve at ${width}px: x=${subtitle.x} w=${subtitle.w}`);
      const cornerGuest = textOp(corner, "Guest A");
      const cornerSubtitle = textOp(corner, "profile guest · shared identity");
      const cornerStatus = textOp(corner, "Choose Alex or Lin.");
      const tile2RightOp = textOp(corner, "Tile2R", "corner");
      const cornerHeaderRight = width - (144 + DISPLAY_UI_SAFETY_GAP);
      const cornerContourRight = width - (84 + DISPLAY_CONTOUR_CLEARANCE_PX);
      assert.ok(cornerGuest.x! + cornerGuest.w! <= cornerHeaderRight + 1.1, `corner action overlaps the translated close target reserve at ${width}px: x=${cornerGuest.x} w=${cornerGuest.w}`);
      assert.ok(cornerSubtitle.x! + cornerSubtitle.w! <= cornerHeaderRight + 1.1, `corner subtitle overlaps the translated close target reserve at ${width}px: x=${cornerSubtitle.x} w=${cornerSubtitle.w}`);
      assert.ok(cornerStatus.x! + cornerStatus.w! <= cornerContourRight + 1.1, `corner status detail overlaps the 5px contour clearance at ${width}px: x=${cornerStatus.x} w=${cornerStatus.w}`);
      assert.ok(
        tile2RightOp.x! + tile2RightOp.w! <= cornerContourRight + 1.1,
        `2-column grid right tile must clear the 5px contour boundary at ${width}px: right=${tile2RightOp.x! + tile2RightOp.w!} > ${cornerContourRight}`,
      );
      const edge2Initial = textOp(corner, "Edge 2", "corner");
      const edge2Ramp = textOp(rampFrame, "Edge 2", "rampFrame");
      const edge2Narrowed = textOp(narrowedFrame, "Edge 2", "narrowedFrame");
      const edge2Restored = textOp(restoredFrame, "Edge 2", "restoredFrame");
      const edge2Reflowed = textOp(pressedFrame, "Edge 2", "pressedFrame");
      const initialRight = edge2Initial.x! + edge2Initial.w!;
      const rampRight = edge2Ramp.x! + edge2Ramp.w!;
      const narrowedRight = edge2Narrowed.x! + edge2Narrowed.w!;
      const restoredRight = edge2Restored.x! + edge2Restored.w!;
      const reflowedRight = edge2Reflowed.x! + edge2Reflowed.w!;
      assert.ok(initialRight > cornerContourRight + 40, `lower card must start full-width below the contour at ${width}px: right=${initialRight}`);
      assert.ok(rampRight < initialRight - 4 && rampRight > narrowedRight + 4, `card in ramp must have progressive intermediate width at ${width}px (cardY=${edge2Initial.clip?.y}): initial=${initialRight}, ramp=${rampRight}, narrowed=${narrowedRight}`);
      assert.ok(narrowedRight <= cornerContourRight + 1.1, `card scrolled into contour band must clear the top-right occlusion at ${width}px: right=${narrowedRight} > ${cornerContourRight}`);
      assert.ok(
        edge2Narrowed.clip && Math.abs((edge2Narrowed.clip.x! + edge2Narrowed.clip.w!) - cornerContourRight) <= 1.1,
        `narrowed contour card right border must sit 5px from the real occlusion at ${width}px: clip=${JSON.stringify(edge2Narrowed.clip)} expectedRight=${cornerContourRight}`,
      );
      assert.ok(Math.abs(restoredRight - initialRight) < 1.1, `card scrolled back down must restore full width at ${width}px: ${initialRight} -> ${restoredRight}`);
      assert.ok(
        edge2Restored.clip && Math.abs((edge2Restored.clip.x! + edge2Restored.clip.w!) - (width - 16)) <= 1.1,
        `restoring full width must preserve declared overflow-hidden clipping at ${width}px: clip=${JSON.stringify(edge2Restored.clip)}`,
      );
      assert.ok(textOp(pressedFrame, "RefPressed"), `ScrollContourItem must assign object ref and forward onPress at ${width}px`);
      assert.ok(
        Math.abs(reflowedRight - narrowedRight) <= 1.1,
        `idle content reflow into the contour band must update reservation without scrolling at ${width}px: reflowed=${reflowedRight}, expected=${narrowedRight}`,
      );
      console.log(`safe_area_native.test: ${width}px top inset (${initialHeaderY} -> ${insetHeaderY}), bottom slot stable (${initialBottomY}), corner app-bar right <= ${cornerHeaderRight}, contour right <= ${cornerContourRight}, progressive scroll width (${initialRight} -> ${rampRight} -> ${narrowedRight} -> ${restoredRight}, reflow=${reflowedRight})`);
    }

    const landscapeResponses = runProbe([
      { op: "create", width: 640, height: 360 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      {
        op: "send",
        message: {
          type: "event",
          name: "display.viewport",
          payload: {
            width: 640,
            height: 360,
            safeArea: { top: 0, right: 0, bottom: 18, left: 32 },
            keyboardInset: 0,
            reservedRegions: [
              {
                id: "landscape-left-hole",
                kind: "occlusion",
                frame: { left: 0, top: 165, width: 32, height: 24 },
                margins: { top: 0, right: 0, bottom: 0, left: 0 },
                active: true,
              },
            ],
          },
        },
      },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 320, y: 280 } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "move", id: 0, x: 320, y: 250 } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "move", id: 0, x: 320, y: 156 } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 320, y: 156 } } },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]);
    const landscapeStep1 = frameOf(landscapeResponses, 3);
    const landscapeStep2 = frameOf(landscapeResponses, 4);
    const card2BelowHole = textOp(landscapeStep1, "Contour Card 2", "landscapeStep1");
    const card1OverHole = textOp(landscapeStep1, "Contour Card 1", "landscapeStep1");
    const card2OverHole = textOp(landscapeStep2, "Contour Card 2", "landscapeStep2");
    const card1AboveHole = textOp(landscapeStep2, "Contour Card 1", "landscapeStep2");
    const expectedHoleLeft = 32 + DISPLAY_CONTOUR_CLEARANCE_PX;
    assert.ok(
      card2BelowHole.clip && Math.abs(card2BelowHole.clip.x! - 16) <= 1.1,
      `card below landscape left hole-punch must stay full-width at x=16: clip=${JSON.stringify(card2BelowHole.clip)}`,
    );
    assert.ok(
      Math.abs(card1OverHole.x! - (expectedHoleLeft + 16)) <= 1.1,
      `card overlapping landscape left hole-punch must indent its left border to 37px (text x=53): op=${JSON.stringify(card1OverHole)}`,
    );
    assert.ok(
      card2OverHole.clip && Math.abs(card2OverHole.clip.x! - expectedHoleLeft) <= 1.1,
      `card scrolled into landscape left hole-punch must indent its left border to 37px: clip=${JSON.stringify(card2OverHole.clip)}`,
    );
    assert.ok(
      Math.abs(card1AboveHole.x! - 32) <= 1.1,
      `card scrolled above landscape left hole-punch must restore full width at text x=32: op=${JSON.stringify(card1AboveHole)}`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
