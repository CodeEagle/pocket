import { strict as assert } from "node:assert";

type DrawOp = {
  type?: string;
  text?: string;
  y?: number;
  points?: Array<{ x: number; y: number }>;
};

/** Target the painted chevron, rather than an invisible text test label. */
export function backIconPoint(frame: { ops?: DrawOp[] }): { x: number; y: number } {
  assert.equal((frame.ops ?? []).some((op) => op.type === "text" && op.text === "Back"), false, "Back must be an icon, without a painted text label");
  const titleY = Math.min(...(frame.ops ?? []).filter((op) => op.type === "text").map((op) => op.y ?? Infinity));
  const triangles = (frame.ops ?? []).filter((op) =>
    (op.type === "triangle" || op.type === "textureTriangle") &&
    op.points?.length === 3 &&
    op.points.every((point) => point.x > 0 && point.x < 88 && point.y >= titleY - 24 && point.y <= titleY + 40),
  );
  assert.ok(triangles.length >= 4, "secondary app bar must paint the two-stroke back chevron");
  const points = triangles.flatMap((op) => op.points!);
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  assert.ok(right - left > 5 && right - left < 32 && bottom - top > 10 && bottom - top < 36, "back icon must have visible chevron geometry");
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
