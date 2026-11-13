import type { CubismHitArea } from "./manifest.ts";
import type { Live2dParameterMetadata, Live2dParameterValue, PocketLive2dDrawableFrame, PocketLive2dPlacement } from "./transport.ts";

const pms1Magic = 0x31534d50;

export interface CubismPoint {
  readonly x: number;
  readonly y: number;
}

export interface CubismInteractionCanvas {
  readonly widthPixels: number;
  readonly heightPixels: number;
  readonly originXPixels: number;
  readonly originYPixels: number;
}

export interface CubismInteractionControllerOptions {
  readonly hitAreas: readonly CubismHitArea[];
  readonly parameters: readonly Live2dParameterMetadata[];
  readonly canvas: CubismInteractionCanvas;
  /** Same transform used to place Core canvas pixels into the retained mesh. */
  readonly placement: Pick<PocketLive2dPlacement, "dx" | "dy" | "scale">;
}

/**
 * Stateless helpers for consumer-owned Live2D pointer gestures. Hit regions
 * use the current Core drawable mesh, and drag targets use actual Core
 * parameter ranges; this module owns no clock, touch state or native handle.
 */
export function createCubismInteractionController(options: CubismInteractionControllerOptions) {
  const { hitAreas, parameters, canvas, placement } = options;
  if (!(canvas.widthPixels > 0 && canvas.heightPixels > 0 && placement.scale > 0)) {
    throw new RangeError("Cubism interaction requires a positive canvas and placement scale");
  }
  const parameterById = new Map(parameters.map(parameter => [parameter.id, parameter]));

  return {
    /** Return the first declared hit area whose Core drawable geometry contains the point. */
    hitAreaAt(drawables: readonly Pick<PocketLive2dDrawableFrame, "id" | "meshBytes" | "dynamicFlags" | "opacity">[], point: CubismPoint): CubismHitArea | undefined {
      for (const area of hitAreas) {
        // model3.HitAreas is authoritative even when the referenced helper
        // drawable is visually hidden. Its geometry still defines the touch
        // region, just as Cubism's model-level hit-area contract does.
        const drawable = drawables.find(value => value.id === area.id);
        if (drawable && meshContainsPoint(drawable.meshBytes, point)) return area;
      }
      return undefined;
    },

    /** Map a model-local point to standard Cubism tracking parameters. */
    dragParameters(point: CubismPoint): readonly Live2dParameterValue[] {
      const canvasX = (point.x - placement.dx) / placement.scale;
      const canvasY = (point.y - placement.dy) / placement.scale;
      const x = clamp((canvasX - canvas.originXPixels) / (canvas.widthPixels / 2), -1, 1);
      const y = clamp((canvasY - canvas.originYPixels) / (canvas.heightPixels / 2), -1, 1);
      const targets: Readonly<Record<string, number>> = {
        ParamAngleX: x,
        ParamAngleY: -y,
        ParamAngleZ: -x * y,
        ParamBodyAngleX: x * 0.35,
        ParamBodyAngleY: -y * 0.35,
        ParamBodyAngleZ: -x * y * 0.35,
        ParamEyeBallX: x,
        ParamEyeBallY: -y,
      };
      const result: Live2dParameterValue[] = [];
      for (const [id, normalized] of Object.entries(targets)) {
        const parameter = parameterById.get(id);
        if (!parameter) continue;
        const span = normalized < 0
          ? parameter.defaultValue - parameter.minimum
          : parameter.maximum - parameter.defaultValue;
        result.push({ id, value: clamp(parameter.defaultValue + normalized * span, parameter.minimum, parameter.maximum) });
      }
      return result;
    },
  };
}

function meshContainsPoint(bytes: Uint8Array, point: CubismPoint): boolean {
  if (bytes.byteLength === 0) return false;
  if (bytes.byteLength < 16 || bytes.byteLength % 4 !== 0) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const verticesOffset = 16;
  const indicesOffset = verticesOffset + vertexCount * 16;
  if (view.getUint32(0, true) !== pms1Magic || indexCount < 3 || indexCount % 3 !== 0 ||
      vertexCount > 16_384 || indexCount > 98_304 || bytes.byteLength !== indicesOffset + indexCount * 4) {
    return false;
  }

  for (let index = 0; index < indexCount; index += 3) {
    const ia = view.getUint32(indicesOffset + index * 4, true);
    const ib = view.getUint32(indicesOffset + (index + 1) * 4, true);
    const ic = view.getUint32(indicesOffset + (index + 2) * 4, true);
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue;
    const ax = view.getFloat32(verticesOffset + ia * 16, true);
    const ay = view.getFloat32(verticesOffset + ia * 16 + 4, true);
    const bx = view.getFloat32(verticesOffset + ib * 16, true);
    const by = view.getFloat32(verticesOffset + ib * 16 + 4, true);
    const cx = view.getFloat32(verticesOffset + ic * 16, true);
    const cy = view.getFloat32(verticesOffset + ic * 16 + 4, true);
    if ([ax, ay, bx, by, cx, cy].every(Number.isFinite) && pointInTriangle(point.x, point.y, ax, ay, bx, by, cx, cy)) return true;
  }
  return false;
}

function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const abx = bx - ax, aby = by - ay;
  const bcx = cx - bx, bcy = cy - by;
  const cax = ax - cx, cay = ay - cy;
  if (Math.abs(abx * (cy - ay) - aby * (cx - ax)) <= 1e-8) return false;
  const apx = px - ax, apy = py - ay;
  const bpx = px - bx, bpy = py - by;
  const cpx = px - cx, cpy = py - cy;
  const ab = abx * apy - aby * apx;
  const bc = bcx * bpy - bcy * bpx;
  const ca = cax * cpy - cay * cpx;
  const epsilon = 1e-4;
  return (ab >= -epsilon && bc >= -epsilon && ca >= -epsilon) || (ab <= epsilon && bc <= epsilon && ca <= epsilon);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
