import { validateCubismAssetReference, type CubismModel3Manifest } from "./manifest.ts";

export const pocketLive2dPluginId = "dart.live2d";
export const pocketLive2dLoadCapability = "media.live2d.model.load";
export const pocketLive2dUpdateCapability = "media.live2d.model.update";
export const pocketLive2dReleaseCapability = "media.live2d.model.release";
export const pocketLive2dMaxTextures = 16;
export const pocketLive2dMaxNativeBytes = 128 * 1024 * 1024;

export interface PocketLive2dHost {
  request(capability: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface PocketLive2dPlacement {
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
  readonly opacity?: number;
}

export interface PocketLive2dDrawableFrame {
  readonly id: string;
  readonly textureIndex: number;
  readonly drawOrder: number;
  readonly renderOrder: number;
  readonly blendMode: number;
  readonly constantFlags: number;
  readonly dynamicFlags: number;
  readonly opacity: number;
  readonly meshBytes: Uint8Array;
  readonly maskIndices: readonly number[];
  readonly multiplyColorRgba: readonly number[];
  readonly screenColorRgba: readonly number[];
}

export interface PocketLive2dModelInfo {
  readonly modelId: string;
  readonly drawableCount: number;
  readonly mocVersion: number;
  /** Host accounting basis for nativeBytes when Core does not expose its
   * complete model allocation. Absent preserves providers with exact native
   * allocation accounting. */
  readonly memoryAccounting?: "core-visible-buffers";
  readonly nativeBytes: number;
  readonly parameterCount: number;
  readonly parameterDefaults: readonly Live2dParameterValue[];
  /** Core ranges used by the official Cubism Physics solver. */
  readonly parameterMetadata?: readonly Live2dParameterMetadata[];
  /** Core part IDs and defaults used by official Cubism Pose. */
  readonly parts?: readonly Live2dPartDefault[];
  readonly canvas: {
    readonly widthPixels: number;
    readonly heightPixels: number;
    readonly originXPixels: number;
    readonly originYPixels: number;
    readonly pixelsPerUnit: number;
  };
}

export interface PocketLive2dFrame {
  readonly modelId: string;
  readonly drawables: readonly PocketLive2dDrawableFrame[];
}

export interface Live2dParameterValue {
  readonly id: string;
  readonly value: number;
}

export interface Live2dParameterMetadata {
  readonly id: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly defaultValue: number;
}

export interface Live2dPartDefault {
  readonly id: string;
  readonly defaultOpacity: number;
}

export interface Live2dLoadRequest {
  readonly id: string;
  readonly assetPrefix: string;
  readonly manifest: CubismModel3Manifest;
}

export interface PocketLive2dClient {
  load(request: Live2dLoadRequest): Promise<PocketLive2dModelInfo>;
  update(
    modelId: string,
    parameters?: readonly Live2dParameterValue[],
    partOpacities?: readonly Live2dParameterValue[],
    placement?: PocketLive2dPlacement,
  ): Promise<PocketLive2dFrame>;
  release(modelId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface PocketLive2dClientOptions {
  onStatus?(status: "ready" | "unavailable" | "error", detail?: string): void;
  /**
   * Opt into the versioned sparse response for Cubism's static UV/index/mask
   * topology. The public update result remains a complete PocketLive2dFrame.
   * Defaults off so older native providers receive the original cache shape;
   * the client always negotiates PMS1 and accepts a legacy host response.
   */
  cacheStaticTopology?: boolean;
}

/**
 * Thin JS request client for the native Core provider. It owns no animation
 * clock or model state beyond native handles and serializes updates per model.
 */
export function createPocketLive2dClient(
  host: PocketLive2dHost,
  options: PocketLive2dClientOptions = {},
): PocketLive2dClient {
  const models = new Map<string, PocketLive2dModelInfo>();
  const topologies = new Map<string, readonly CachedDrawableTopology[]>();
  const tails = new Map<string, Promise<unknown>>();
  const releases = new Map<string, Promise<void>>();
  const pendingLoads = new Set<Promise<PocketLive2dModelInfo>>();
  let disposed = false;

  const report = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    options.onStatus?.(/unavailable|unconfigured|unsupported/i.test(detail) ? "unavailable" : "error", detail);
  };
  const serialize = <T>(modelId: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(modelId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    tails.set(modelId, next);
    void next.then(
      () => { if (tails.get(modelId) === next) tails.delete(modelId); },
      () => { if (tails.get(modelId) === next) tails.delete(modelId); },
    );
    return next;
  };
  const releaseModel = (modelId: string): Promise<void> => {
    if (!models.has(modelId)) return Promise.resolve();
    const existing = releases.get(modelId);
    if (existing) return existing;
    const pending = serialize(modelId, async () => {
      await invoke(pocketLive2dReleaseCapability, { modelId });
      models.delete(modelId);
      topologies.delete(modelId);
    });
    releases.set(modelId, pending);
    void pending.then(
      () => { if (releases.get(modelId) === pending) releases.delete(modelId); },
      () => { if (releases.get(modelId) === pending) releases.delete(modelId); },
    );
    return pending;
  };
  const invoke = async (capability: string, params: Record<string, unknown>): Promise<unknown> => {
    try {
      const result = await host.request(capability, params);
      options.onStatus?.("ready");
      return result;
    } catch (error) {
      report(error);
      throw error;
    }
  };

  return {
    load(request): Promise<PocketLive2dModelInfo> {
      if (disposed) return Promise.reject(new Error("Live2D client is disposed"));
      const pending = (async (): Promise<PocketLive2dModelInfo> => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.id)) throw new Error("Live2D model id must be a short identifier");
        const prefix = validatePrefix(request.assetPrefix);
        if (request.manifest.textures.length > pocketLive2dMaxTextures) {
          throw new RangeError(`Live2D models may reference at most ${pocketLive2dMaxTextures} textures`);
        }
        const mocAsset = joinAsset(prefix, request.manifest.moc);
        const result = parseModelInfo(await invoke(pocketLive2dLoadCapability, {
          id: request.id,
          mocAsset,
          textures: request.manifest.textures.map((texture) => joinAsset(prefix, texture)),
        }));
        if (models.has(result.modelId)) throw new Error(`Native Live2D model handle '${result.modelId}' is already in use`);
        if (disposed) {
          await invoke(pocketLive2dReleaseCapability, { modelId: result.modelId });
          throw new Error("Live2D client was disposed while a model was loading");
        }
        models.set(result.modelId, result);
        return result;
      })();
      pendingLoads.add(pending);
      void pending.then(
        () => pendingLoads.delete(pending),
        () => pendingLoads.delete(pending),
      );
      return pending;
    },
    update(modelId, parameters = [], partOpacities = [], placement): Promise<PocketLive2dFrame> {
      if (disposed) return Promise.reject(new Error("Live2D client is disposed"));
      if (!models.has(modelId)) return Promise.reject(new Error(`Unknown Live2D model handle '${modelId}'`));
      validateParameterValues(parameters, "parameters");
      validateParameterValues(partOpacities, "partOpacities");
      if (placement !== undefined) validatePlacement(placement);
      return serialize(modelId, async () => {
        const request: Record<string, unknown> = {
          modelId,
          parameters,
          partOpacities,
          meshFormat: "pms1",
        };
        if (placement !== undefined) {
          request.placement = placement;
        }
        if (options.cacheStaticTopology === true) {
          request.cacheStaticTopology = true;
        }
        return parseFrame(
          await invoke(pocketLive2dUpdateCapability, request),
          modelId,
          options.cacheStaticTopology === true ? topologies : undefined,
          placement,
        );
      });
    },
    release: releaseModel,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await Promise.allSettled([...pendingLoads]);
      const ids = [...models.keys()];
      const results = await Promise.allSettled(ids.map(releaseModel));
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    },
  };
}

function validatePrefix(value: string): string {
  if (value.length === 0) return "";
  const normalized = value.replace(/\/+$/, "");
  if (normalized.length === 0) throw new Error("Live2D assetPrefix must be a safe relative path or empty");
  return validateCubismAssetReference(normalized, "assetPrefix");
}

function joinAsset(prefix: string, reference: string): string {
  const safeReference = validateCubismAssetReference(reference);
  return validateCubismAssetReference(prefix.length === 0 ? safeReference : `${prefix}/${safeReference}`, "resolved asset");
}

function validateParameterValues(values: readonly Live2dParameterValue[], label: string): void {
  for (const [index, entry] of values.entries()) {
    if (typeof entry.id !== "string" || entry.id.trim().length === 0 || !Number.isFinite(entry.value)) {
      throw new TypeError(`${label}[${index}] must have a non-empty id and finite value`);
    }
  }
}

function validatePlacement(placement: PocketLive2dPlacement): void {
  if (
    typeof placement !== "object" ||
    placement === null ||
    !Number.isFinite(placement.dx) ||
    !Number.isFinite(placement.dy) ||
    !Number.isFinite(placement.scale) ||
    placement.scale <= 0 ||
    (placement.opacity !== undefined && !Number.isFinite(placement.opacity))
  ) {
    throw new TypeError("placement must have finite dx, dy, positive scale and optional finite opacity");
  }
}

function parseModelInfo(value: unknown): PocketLive2dModelInfo {
  const root = object(value, "load result");
  const canvas = object(root.canvas, "load result.canvas");
  let memoryAccounting: PocketLive2dModelInfo["memoryAccounting"];
  if (root.memoryAccounting !== undefined) {
    if (root.memoryAccounting !== "core-visible-buffers") {
      throw new TypeError("load result.memoryAccounting has an unsupported accounting basis");
    }
    memoryAccounting = root.memoryAccounting;
  }
  if (!Array.isArray(root.parameterDefaults)) throw new TypeError("load result.parameterDefaults must be an array");
  const parameterDefaults = root.parameterDefaults.map((entry, index): Live2dParameterValue => {
    const parameter = object(entry, `load result.parameterDefaults[${index}]`);
    const id = string(parameter.id, `load result.parameterDefaults[${index}].id`);
    if (typeof parameter.value !== "number" || !Number.isFinite(parameter.value)) {
      throw new TypeError(`load result.parameterDefaults[${index}].value must be finite`);
    }
    return { id, value: parameter.value };
  });
  const parameterMetadata = root.parameterMetadata === undefined
    ? undefined
    : parseParameterMetadata(root.parameterMetadata);
  const parts = root.parts === undefined ? undefined : parseParts(root.parts);
  const info: PocketLive2dModelInfo = {
    modelId: string(root.modelId, "load result.modelId"),
    drawableCount: integer(root.drawableCount, "load result.drawableCount"),
    mocVersion: integer(root.mocVersion, "load result.mocVersion"),
    ...(memoryAccounting === undefined ? {} : { memoryAccounting }),
    nativeBytes: integer(root.nativeBytes, "load result.nativeBytes"),
    parameterCount: integer(root.parameterCount, "load result.parameterCount"),
    parameterDefaults,
    ...(parameterMetadata === undefined ? {} : { parameterMetadata }),
    ...(parts === undefined ? {} : { parts }),
    canvas: {
      widthPixels: finiteNumber(canvas.widthPixels, "load result.canvas.widthPixels"),
      heightPixels: finiteNumber(canvas.heightPixels, "load result.canvas.heightPixels"),
      originXPixels: finiteNumber(canvas.originXPixels, "load result.canvas.originXPixels"),
      originYPixels: finiteNumber(canvas.originYPixels, "load result.canvas.originYPixels"),
      pixelsPerUnit: finiteNumber(canvas.pixelsPerUnit, "load result.canvas.pixelsPerUnit"),
    },
  };
  if (info.drawableCount < 0 || info.mocVersion < 0 || info.nativeBytes <= 0 || info.nativeBytes > pocketLive2dMaxNativeBytes || info.parameterCount < 0 || info.canvas.pixelsPerUnit <= 0) throw new TypeError("load result contains invalid counts, memory size or canvas scale");
  if (parameterMetadata !== undefined && parameterMetadata.length !== info.parameterCount) throw new TypeError("load result.parameterMetadata must match parameterCount");
  return info;
}

function parseParameterMetadata(value: unknown): Live2dParameterMetadata[] {
  if (!Array.isArray(value)) throw new TypeError("load result.parameterMetadata must be an array");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `load result.parameterMetadata[${index}]`;
    const parameter = object(entry, path);
    const id = string(parameter.id, `${path}.id`);
    const minimum = finiteNumber(parameter.minimum, `${path}.minimum`);
    const maximum = finiteNumber(parameter.maximum, `${path}.maximum`);
    const defaultValue = finiteNumber(parameter.defaultValue, `${path}.defaultValue`);
    if (!id || ids.has(id)) throw new TypeError(`${path}.id must be unique and non-empty`);
    if (minimum > maximum || defaultValue < minimum || defaultValue > maximum) throw new TypeError(`${path} contains invalid Core parameter bounds`);
    ids.add(id);
    return { id, minimum, maximum, defaultValue };
  });
}

function parseParts(value: unknown): Live2dPartDefault[] {
  if (!Array.isArray(value)) throw new TypeError("load result.parts must be an array");
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const path = `load result.parts[${index}]`;
    const part = object(entry, path);
    const id = string(part.id, `${path}.id`);
    const defaultOpacity = finiteNumber(part.defaultOpacity, `${path}.defaultOpacity`);
    if (!id || ids.has(id) || defaultOpacity < 0 || defaultOpacity > 1) throw new TypeError(`${path} contains an invalid Core part fact`);
    ids.add(id);
    return { id, defaultOpacity };
  });
}

interface CachedDrawableTopology {
  readonly id: string;
  readonly format: "legacy" | "pms1";
  readonly vertexCount: number;
  readonly meshByteLength?: number;
  readonly uvs?: number[];
  readonly indices?: number[];
  readonly maskIndices: number[];
}

function parseFrame(
  value: unknown,
  modelId: string,
  topologies?: Map<string, readonly CachedDrawableTopology[]>,
  placement?: PocketLive2dPlacement,
): PocketLive2dFrame {
  const root = object(value, "frame result");
  if (root.modelId !== modelId || !Array.isArray(root.drawables)) throw new TypeError("frame result does not match requested model");
  const mode = root.topologyMode;
  if (mode !== undefined && mode !== "full" && mode !== "cached-v1") {
    throw new TypeError("frame result has an unsupported topology mode");
  }
  const cachedFrame = mode === "cached-v1";
  const cached = topologies?.get(modelId);
  if (cachedFrame && cached === undefined) {
    throw new TypeError("cached drawable topology arrived before its full frame");
  }
  if (cachedFrame && root.drawables.length !== cached!.length) {
    throw new TypeError("cached drawable topology count changed");
  }
  const nextTopology = topologies && !cachedFrame
    ? new Array<CachedDrawableTopology>(root.drawables.length)
    : undefined;
  const drawables = root.drawables.map((entry, index): PocketLive2dDrawableFrame => {
    const path = `drawables[${index}]`;
    const drawable = object(entry, `frame result.${path}`);
    const multiply = float32Array(drawable.multiplyColorRgba, `${path}.multiplyColorRgba`);
    const screen = float32Array(drawable.screenColorRgba, `${path}.screenColorRgba`);
    const id = string(drawable.id, `${path}.id`);
    const packed = Object.hasOwn(drawable, "meshBytes");
    const opacity = finiteNumber(drawable.opacity, `${path}.opacity`);
    let meshBytes: Uint8Array;
    let masks: number[];
    if (packed) {
      meshBytes = pms1Bytes(drawable.meshBytes, `${path}.meshBytes`);
      const vertexCount = pms1VertexCount(meshBytes, `${path}.meshBytes`);
      if (cachedFrame) {
        if (Object.hasOwn(drawable, "maskIndices")) {
          throw new TypeError(`frame result.${path} repeats cached topology`);
        }
        const topology = cached![index]!;
        if (topology.format !== "pms1" || id !== topology.id ||
            vertexCount !== topology.vertexCount || meshBytes.byteLength !== topology.meshByteLength) {
          throw new TypeError(`frame result.${path} changed cached drawable identity or vertex count`);
        }
        masks = topology.maskIndices;
      } else {
        masks = uint32Array(drawable.maskIndices, `${path}.maskIndices`, true);
        if (nextTopology) {
          nextTopology[index] = {
            id, format: "pms1", vertexCount,
            meshByteLength: meshBytes.byteLength, maskIndices: masks,
          };
        }
      }
    } else {
      const positions = float32Array(drawable.positionsXYPixels, `${path}.positionsXYPixels`, true);
      let uvs: number[];
      let indices: number[];
      if (cachedFrame) {
        if (Object.hasOwn(drawable, "uvs") || Object.hasOwn(drawable, "indices") || Object.hasOwn(drawable, "maskIndices")) {
          throw new TypeError(`frame result.${path} repeats cached topology`);
        }
        const topology = cached![index]!;
        if (topology.format !== "legacy" || id !== topology.id || positions.length !== topology.vertexCount * 2) {
          throw new TypeError(`frame result.${path} changed cached drawable identity or vertex count`);
        }
        uvs = topology.uvs!;
        indices = topology.indices!;
        masks = topology.maskIndices;
      } else {
        uvs = float32Array(drawable.uvs, `${path}.uvs`, true);
        indices = uint16Array(drawable.indices, `${path}.indices`, true);
        masks = uint32Array(drawable.maskIndices, `${path}.maskIndices`, true);
        const vertexCount = positions.length / 2;
        if (nextTopology) {
          nextTopology[index] = {
            id, format: "legacy", vertexCount, uvs, indices, maskIndices: masks,
          };
        }
      }
      meshBytes = packLegacyPms1(positions, uvs, indices, opacity, placement, path);
    }
    if (masks.some((value) => !Number.isInteger(value) || value < 0)) {
      throw new TypeError(`frame result.${path}.maskIndices must contain non-negative integers`);
    }
    if (multiply.length !== 4 || screen.length !== 4) {
      throw new TypeError(`frame result.${path} has inconsistent mesh buffers`);
    }
    return {
      id,
      textureIndex: integer(drawable.textureIndex, `drawables[${index}].textureIndex`),
      drawOrder: integer(drawable.drawOrder, `drawables[${index}].drawOrder`),
      renderOrder: integer(drawable.renderOrder, `drawables[${index}].renderOrder`),
      blendMode: integer(drawable.blendMode, `drawables[${index}].blendMode`),
      constantFlags: integer(drawable.constantFlags, `drawables[${index}].constantFlags`),
      dynamicFlags: integer(drawable.dynamicFlags, `drawables[${index}].dynamicFlags`),
      opacity,
      meshBytes,
      maskIndices: masks,
      multiplyColorRgba: multiply,
      screenColorRgba: screen,
    };
  });
  if (nextTopology) topologies!.set(modelId, nextTopology);
  return { modelId, drawables };
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
  return value;
}

function integer(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (!Number.isInteger(number)) throw new TypeError(`${path} must be an integer`);
  return number;
}

function pms1Bytes(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${path} must be a packed PMS1 Uint8Array`);
  }
  if (value.byteLength === 0) return value;
  if (value.byteLength < 16 || value.byteLength % 4 !== 0) {
    throw new TypeError(`${path} must be an empty buffer or a 32-bit aligned PMS1 mesh`);
  }
  return value;
}

function pms1VertexCount(value: Uint8Array, path: string): number {
  if (value.byteLength === 0) return 0;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  if (view.getUint32(0, true) !== 0x31534d50 || vertexCount > 16_384 ||
      indexCount > 98_304 || value.byteLength !== 16 + vertexCount * 16 + indexCount * 4) {
    throw new TypeError(`${path} has an invalid PMS1 header`);
  }
  return vertexCount;
}

function float32Array(value: unknown, path: string, allowEmpty = false): number[] {
  return decodeNumericArray(value, path, 4, (view, offset) => view.getFloat32(offset, true), allowEmpty);
}

function uint32Array(value: unknown, path: string, allowEmpty = false): number[] {
  return decodeNumericArray(value, path, 4, (view, offset) => view.getUint32(offset, true), allowEmpty);
}

function uint16Array(value: unknown, path: string, allowEmpty = false): number[] {
  return decodeNumericArray(value, path, 2, (view, offset) => view.getUint16(offset, true), allowEmpty);
}

function packLegacyPms1(
  positions: readonly number[],
  uvs: readonly number[],
  indices: readonly number[],
  opacity: number,
  placement: PocketLive2dPlacement | undefined,
  path: string,
): Uint8Array {
  const vertexCount = positions.length / 2;
  if (positions.length % 2 !== 0 || uvs.length !== positions.length || indices.length % 3 !== 0 ||
      indices.some((value) => !Number.isInteger(value) || value < 0 || value >= vertexCount)) {
    throw new TypeError(`frame result.${path} has inconsistent mesh buffers`);
  }
  if (vertexCount === 0 || indices.length === 0) return new Uint8Array();
  if (vertexCount > 16_384 || indices.length > 98_304) {
    throw new RangeError(`${path} exceeds the PMS1 mesh limits`);
  }
  const bytes = new Uint8Array(16 + vertexCount * 16 + indices.length * 4);
  const view = new DataView(bytes.buffer);
  const alpha = Math.round(Math.max(0, Math.min(1, opacity * (placement?.opacity ?? 1))) * 255);
  view.setUint32(0, 0x31534d50, true);
  view.setUint32(4, vertexCount, true);
  view.setUint32(8, indices.length, true);
  view.setUint32(12, ((alpha << 24) | 0x00ffffff) >>> 0, true);
  const dx = placement?.dx ?? 0;
  const dy = placement?.dy ?? 0;
  const scale = placement?.scale ?? 1;
  let offset = 16;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const pair = vertex * 2;
    view.setFloat32(offset, dx + positions[pair]! * scale, true);
    view.setFloat32(offset + 4, dy + positions[pair + 1]! * scale, true);
    view.setFloat32(offset + 8, uvs[pair]!, true);
    view.setFloat32(offset + 12, 1 - uvs[pair + 1]!, true);
    offset += 16;
  }
  for (const index of indices) {
    view.setUint32(offset, index, true);
    offset += 4;
  }
  return bytes;
}

function decodeNumericArray(
  value: unknown,
  path: string,
  bytesPerItem: number,
  read: (view: DataView, offset: number) => number,
  allowEmpty: boolean,
): number[] {
  if (Array.isArray(value)) {
    if ((!allowEmpty && value.length === 0) || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new TypeError(`${path} must be an array of finite numbers`);
    }
    return value as number[];
  }
  if (!(value instanceof Uint8Array) || value.byteLength % bytesPerItem !== 0 || (!allowEmpty && value.byteLength === 0)) {
    throw new TypeError(`${path} must be an array or a valid packed numeric buffer`);
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const result = new Array<number>(value.byteLength / bytesPerItem);
  for (let index = 0; index < result.length; index++) {
    const decoded = read(view, index * bytesPerItem);
    if (!Number.isFinite(decoded)) throw new TypeError(`${path} contains a non-finite number`);
    result[index] = decoded;
  }
  return result;
}
