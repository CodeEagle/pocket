import { encodeNovelMesh } from "./mesh.ts";

/** Cosmetic stage layers, keyed by background in the shared asset registry. */
export interface NovelAtmosphere {
  readonly mist?: string;
  readonly rain?: string;
  readonly intensity?: number;
  readonly lightning?: boolean;
}

export function novelAtmosphereIssue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "atmosphere must be an object";
  const config = value as Record<string, unknown>;
  for (const key of ["mist", "rain"]) {
    const path = config[key];
    if (path !== undefined && (typeof path !== "string" || !/^[\w./-]+\.(png|svg)$/.test(path) || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === ".."))) return `atmosphere.${key} must be a project image path`;
  }
  if (config.intensity !== undefined && (typeof config.intensity !== "number" || !Number.isFinite(config.intensity) || config.intensity < 0 || config.intensity > 1)) return "atmosphere.intensity must be between 0 and 1";
  if (config.lightning !== undefined && typeof config.lightning !== "boolean") return "atmosphere.lightning must be boolean";
  return null;
}

/** One bounded retained mesh for all drops; buffers are reused across frames. */
export function createNovelRainMesh(count = 40) {
  if (!Number.isInteger(count) || count < 1 || count > 64) throw new Error("Rain is limited to 1–64 drops");
  const vertices = new Float32Array(count * 16);
  const indices = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  let bytes: Uint8Array | undefined;
  return (width: number, height: number, elapsedMs: number): Uint8Array => {
    if (![width, height, elapsedMs].every(Number.isFinite) || width <= 0 || height <= 0 || elapsedMs < 0 || width > 16384 || height > 16384) throw new Error("Invalid rain viewport or time");
    const time = elapsedMs / 1000;
    for (let i = 0; i < count; i++) {
      const depth = (i % 3 + 1) / 3;
      const y = ((i * 71.3 + time * (130 + depth * 210)) % (height + 80)) - 40;
      const x = ((i * 137.7 - time * (25 + depth * 55)) % (width + 100) + width + 100) % (width + 100) - 50;
      const length = 12 + depth * 24;
      const half = .4 + depth * .6;
      vertices.set([x-half,y,0,0, x+half,y,1,0, x-length*.24+half,y+length,1,1, x-length*.24-half,y+length,0,1], i * 16);
    }
    bytes = encodeNovelMesh({ vertices, indices, color: 0x55eadfc8 }, bytes);
    return bytes;
  };
}
