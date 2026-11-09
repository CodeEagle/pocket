import { expect, test } from "bun:test";
import { createNovelViewportLayout, novelCharacterBounds, novelImageContainBounds, novelImageCoverBounds } from "../src/viewport.ts";

test("VN layout fills safe viewports while bounding panels and keeping touch controls natural-sized", () => {
  const phone = createNovelViewportLayout({ width: 360, height: 640 }, { top: 0, right: 0, bottom: 0, left: 0 });
  expect(phone).toMatchObject({ insetL: 0, insetT: 0, width: 360, height: 640, dialogueWidth: 336, dialogueHeight: 164, toolbarHeight: 48 });
  expect(phone.titleMenuLeft).toBe(16);
  expect(phone.titleMenuWidth).toBe(328);
  expect(phone.titleMenuLeft + phone.titleMenuWidth).toBeLessThanOrEqual(phone.width);
  expect(phone.toolbarButtonWidth).toBe(78);

  const desktop = createNovelViewportLayout({ width: 1280, height: 720 }, { top: 0, right: 0, bottom: 0, left: 0 });
  expect(desktop).toMatchObject({ width: 1280, height: 720, dialogueWidth: 960, dialogueLeft: 160, dialogueTextWidth: 720, panelWidth: 640, panelLeft: 320, toolbarWidth: 520, toolbarLeft: 380, toolbarButtonWidth: 124, titleMenuWidth: 360, titleMenuLeft: 48 });
  expect(desktop.artScale).toBe(1.125);
  expect(desktop.dialogueBottom).toBe(60);

  const short = createNovelViewportLayout({ width: 844, height: 340 }, { top: 0, right: 0, bottom: 0, left: 0 });
  expect(short.dialogueBottom + short.dialogueHeight + short.toolbarHeight).toBeLessThanOrEqual(short.height);
  expect(short.inputTop + short.inputHeight + short.inputBottom).toBeLessThanOrEqual(short.height);
  expect(short.titleMenuMaxHeight).toBeLessThan(short.height);
  expect(short.endingTop + short.endingHeight + short.endingBottom).toBeLessThanOrEqual(short.height);
  expect(short.toolbarHeight).toBeLessThanOrEqual(48);

  const safeKeyboard = createNovelViewportLayout({ width: 390, height: 844, keyboardInset: 200 }, { top: 44, right: 12, bottom: 24, left: 28 });
  expect(safeKeyboard).toMatchObject({ insetL: 28, insetT: 44, width: 350, height: 576 });
  expect(safeKeyboard.panelLeft).toBeGreaterThanOrEqual(0);
  expect(safeKeyboard.panelLeft + safeKeyboard.panelWidth).toBeLessThanOrEqual(350);
});

test("authored characters spread across large stages and keep explicit positions in the centered 360 design space", () => {
  const leftPhone = novelCharacterBounds("left", { x: -24, y: 116, width: 240, height: 350 }, 360, 1);
  const rightPhone = novelCharacterBounds("right", { x: 144, y: 116, width: 240, height: 350 }, 360, 1);
  expect(leftPhone.insetL).toBe(-24);
  expect(rightPhone.insetL).toBe(144);

  const leftDesktop = novelCharacterBounds("left", { x: -24, y: 116, width: 240, height: 350 }, 1280, 1.125);
  const centerDesktop = novelCharacterBounds("center", { x: 60, y: 116, width: 240, height: 350 }, 1280, 1.125);
  const rightDesktop = novelCharacterBounds("right", { x: 144, y: 116, width: 240, height: 350 }, 1280, 1.125);
  expect(centerDesktop.insetL - leftDesktop.insetL).toBeGreaterThan(300);
  expect(rightDesktop.insetL - centerDesktop.insetL).toBeGreaterThan(300);

  const authored = novelCharacterBounds({ x: 42, y: 91 }, { x: 42, y: 91, width: 240, height: 350 }, 1280, 1.125);
  expect(authored).toMatchObject({ insetL: (1280 - 360 * 1.125) / 2 + 42 * 1.125, insetT: 91 * 1.125 });
});

test("declared image dimensions preserve aspect ratio for cover and contain; missing dimensions keep legacy box bounds", () => {
  expect(novelImageCoverBounds(360, 640, { width: 512, height: 512 })).toEqual({ insetL: -140, insetT: 0, width: 640, height: 640 });
  const wideCover = novelImageCoverBounds(1280, 720, { width: 1536, height: 1024 });
  expect(wideCover.insetL).toBe(0);
  expect(wideCover.insetT).toBeCloseTo(-66.667, 2);
  expect(wideCover.width).toBe(1280);
  expect(wideCover.height).toBeCloseTo(853.333, 2);
  const characterContain = novelImageContainBounds(240, 350, { width: 1024, height: 1536 });
  expect(characterContain.insetL).toBeCloseTo(3.333, 2);
  expect(characterContain.insetT).toBe(0);
  expect(characterContain.width).toBeCloseTo(233.333, 2);
  expect(characterContain.height).toBe(350);
  expect(novelImageCoverBounds(390, 844)).toEqual({ insetL: 0, insetT: 0, width: 390, height: 844 });
  expect(novelImageContainBounds(240, 350)).toEqual({ insetL: 0, insetT: 0, width: 240, height: 350 });
});
