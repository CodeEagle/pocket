import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { parseHostFontMetrics, previewOpSummaryForTest, transformedChildOpForTest } from "../preview.ts";

const sdkRoot = resolve(import.meta.dir, "../..");

test("previewOpSummary preserves text tracking and affine fields matching Dart _opSummary", () => {
  const plain = previewOpSummaryForTest({
    type: "text",
    x: 10,
    y: 20,
    w: 80,
    h: 18,
    text: "Plain",
    size: 14,
    color: 0xff112233,
    fontSlot: 1,
    align: 0,
  });
  expect(plain.tracking).toBeUndefined();
  expect(plain.affine).toBeUndefined();

  const transformed = previewOpSummaryForTest({
    type: "text",
    x: 12.5,
    y: 24,
    w: 96,
    h: 22,
    text: "Tracked",
    size: 18,
    color: 0xff445566,
    fontSlot: 3,
    align: 1,
    tracking: 2.5,
    affine: [0.866, 0.5, -0.5, 0.866],
  });
  expect(transformed.tracking).toEqual(expect.objectContaining({ value: 2.5 }));
  expect(Array.isArray(transformed.affine)).toBe(true);
  expect((transformed.affine as Array<{ value: number }>).map((v) => v.value)).toEqual([
    0.866,
    0.5,
    -0.5,
    0.866,
  ]);
});

test("transformedChildOp scales plain text size/tracking and composes affine text in local space", () => {
  const slot = { appId: "child.app", surfaceHandle: 2, x: 40, y: 50, w: 180, h: 160, clip: { x: 40, y: 50, w: 180, h: 160 }, focused: false };
  const childFrame = { width: 360, height: 320, ops: [], events: [], resources: [] };

  const scaledPlain = transformedChildOpForTest(
    {
      type: "text",
      x: 20,
      y: 30,
      w: 100,
      h: 24,
      text: "Hello",
      size: 20,
      tracking: 4,
      fontSlot: 4,
      align: 0,
    },
    slot,
    childFrame,
  );
  expect(scaledPlain.x).toBe(50);
  expect(scaledPlain.y).toBe(65);
  expect(scaledPlain.w).toBe(50);
  expect(scaledPlain.h).toBe(12);
  expect(scaledPlain.size).toBe(10);
  expect(scaledPlain.tracking).toBe(2);

  const composedAffine = transformedChildOpForTest(
    {
      type: "text",
      x: 20,
      y: 30,
      w: 100,
      h: 24,
      text: "Rotated",
      size: 20,
      tracking: 3,
      fontSlot: 4,
      align: 1,
      affine: [0, 1, -1, 0],
    },
    slot,
    childFrame,
  );
  expect(composedAffine.x).toBe(50);
  expect(composedAffine.y).toBe(65);
  // Local text box dimensions, size, and tracking stay unscaled while affine absorbs slot scale.
  expect(composedAffine.w).toBe(100);
  expect(composedAffine.h).toBe(24);
  expect(composedAffine.size).toBe(20);
  expect(composedAffine.tracking).toBe(3);
  expect(composedAffine.affine).toEqual([0, 0.5, -0.5, 0]);
});

test("client preview.js renders text size overrides, letterSpacing tracking, and 2x2 affine transforms", () => {
  const calls: Array<{ op: string; args: unknown[]; font?: string; letterSpacing?: string }> = [];
  const canvas = { width: 320, height: 240, style: {}, addEventListener() {} };
  const context = {
    canvas,
    font: "",
    fillStyle: "",
    textBaseline: "alphabetic",
    letterSpacing: "0px",
    globalAlpha: 1,
    clearRect(...args: unknown[]) {
      calls.push({ op: "clearRect", args });
    },
    fillRect(...args: unknown[]) {
      calls.push({ op: "fillRect", args });
    },
    save() {
      calls.push({ op: "save", args: [] });
    },
    restore() {
      calls.push({ op: "restore", args: [] });
    },
    translate(...args: unknown[]) {
      calls.push({ op: "translate", args });
    },
    transform(...args: unknown[]) {
      calls.push({ op: "transform", args });
    },
    measureText(text: string) {
      const spacing = Number.parseFloat(this.letterSpacing || "0") || 0;
      return { width: Array.from(text).length * (8 + spacing) };
    },
    fillText(text: string, x: number, y: number) {
      calls.push({
        op: "fillText",
        args: [text, x, y],
        font: this.font,
        letterSpacing: this.letterSpacing,
      });
    },
  };

  const sandbox: Record<string, unknown> = {
    window: undefined,
    document: {
      getElementById: () => null,
      createElement: () => ({ getContext: () => context }),
    },
    addEventListener() {},
    postMessage() {},
    ResizeObserver: class {
      observe() {}
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const script = readFileSync(join(sdkRoot, "editor/client/preview.js"), "utf8");
  vm.runInNewContext(script, sandbox);

  const api = (sandbox as { PocketEditorPreview?: { drawFrame: (ctx: unknown, frame: unknown, res: Map<string, unknown>) => void } }).PocketEditorPreview;
  expect(api).toBeDefined();
  api!.drawFrame(
    context,
    {
      width: 320,
      height: 240,
      ops: [
        {
          type: "text",
          x: 40,
          y: 60,
          w: 120,
          h: 24,
          text: "HOST",
          size: 21,
          fontSlot: 17,
          color: 0xff112233,
          align: 1,
          tracking: 2,
          affine: [0.866, 0.5, -0.5, 0.866],
        },
      ],
    },
    new Map(),
  );

  const translateCall = calls.find((item) => item.op === "translate");
  const transformCall = calls.find((item) => item.op === "transform");
  const fillTextCall = calls.find((item) => item.op === "fillText");
  expect(translateCall?.args).toEqual([40, 60]);
  expect(transformCall?.args).toEqual([0.866, 0.5, -0.5, 0.866, 0, 0]);
  expect(fillTextCall).toBeDefined();
  expect(fillTextCall?.font).toContain("21px");
  expect(fillTextCall?.font).toContain("monospace");
  expect(fillTextCall?.letterSpacing).toBe("2px");
  // Centered inside local boxW=120 with measured=4*(8+2)=40 -> local offset=(120-40)/2=40.
  expect(fillTextCall?.args).toEqual(["HOST", 40, 0]);
});

test("client preview.js measures 21x95 ASCII and CJK host font table and parseHostFontMetrics validates it", () => {
  const seenFonts: string[] = [];
  const context = {
    font: "",
    letterSpacing: "0px",
    measureText(text: string) {
      seenFonts.push(this.font);
      const pxMatch = /(\d+)px/.exec(this.font);
      const px = pxMatch ? Number(pxMatch[1]) : 14;
      const isMono = this.font.includes("monospace");
      const cp = text.codePointAt(0) ?? 0x20;
      const width = cp >= 0x3000 ? px : px * (isMono ? 0.62 : 0.52);
      return {
        width: Array.from(text).length === 1 ? width : width * Array.from(text).length,
        fontBoundingBoxAscent: px * 0.9,
        fontBoundingBoxDescent: px * 0.25,
      };
    },
  };
  const sandbox: Record<string, unknown> = {
    window: undefined,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ getContext: () => context }),
    },
    addEventListener() {},
    postMessage() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const script = readFileSync(join(sdkRoot, "editor/client/preview.js"), "utf8");
  vm.runInNewContext(script, sandbox);

  const api = sandbox.PocketEditorPreview as { measureHostFontMetrics: () => unknown };
  const measured = api.measureHostFontMetrics();
  const validated = parseHostFontMetrics(measured);
  expect(validated.lineHeights.length).toBe(21);
  expect(validated.cjkAdvances.length).toBe(21);
  expect(validated.asciiAdvances.length).toBe(21 * 95);
  expect(validated.cjkAdvances[0]).toBe(12);
  expect(validated.asciiAdvances[16 * 95 + ("M".charCodeAt(0) - 0x20)]).toBeCloseTo(12 * 0.62, 5);
  expect(seenFonts.some((f) => f.includes("ui-monospace"))).toBe(true);
  expect(() => parseHostFontMetrics({ ...validated, lineHeights: [0, ...validated.lineHeights.slice(1)] })).toThrow(/positive/);
});
