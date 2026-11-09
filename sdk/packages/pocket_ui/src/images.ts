import type { HostBridge } from "./host.ts";

export const POCKET_IMAGE_MAX_WIDTH = 256;
export const POCKET_IMAGE_MAX_HEIGHT = 256;
export const POCKET_IMAGE_MAX_PIXELS = 65_536;
export const POCKET_IMAGE_MAX_TEXTURE_WIDTH = 256;
export const POCKET_IMAGE_MAX_TEXTURE_HEIGHT = 256;
export const POCKET_IMAGE_MAX_IMG_BYTES =
  8 + POCKET_IMAGE_MAX_TEXTURE_WIDTH * POCKET_IMAGE_MAX_TEXTURE_HEIGHT * 4;

export interface PocketImageCaptureOptions {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxPixels?: number;
}

export interface PocketImageReference {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** A native-created IMG entry ready for HostOps.uploadImgEntry(). */
export interface PocketStoredImageData extends PocketImageReference {
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly img: Uint8Array;
}

export interface PocketImagesClient {
  capture(options?: PocketImageCaptureOptions): Promise<PocketImageReference>;
  read(id: string): Promise<PocketStoredImageData>;
  list(): Promise<readonly PocketImageReference[]>;
  /** Returns false when the id was already absent. */
  remove(id: string): Promise<boolean>;
}

export class PocketImagesError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PocketImagesError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && !ArrayBuffer.isView(value);
}

function isPositiveIntegerAtMost(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value > 0 && value <= maximum;
}

function assertImageId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new PocketImagesError("invalid_image_id", "Image id must be a lowercase 64-character hex digest");
  }
}

function parseReference(value: unknown, label: string): PocketImageReference {
  if (!isRecord(value)) {
    throw new PocketImagesError("invalid_image_response", `${label} must be an image metadata object`);
  }
  const id = value.id;
  const width = value.width;
  const height = value.height;
  assertImageId(id);
  if (!isPositiveIntegerAtMost(width, POCKET_IMAGE_MAX_WIDTH) ||
      !isPositiveIntegerAtMost(height, POCKET_IMAGE_MAX_HEIGHT) ||
      width * height > POCKET_IMAGE_MAX_PIXELS) {
    throw new PocketImagesError("invalid_image_dimensions", `${label} dimensions are outside the thumbnail limits`);
  }
  return { id, width, height };
}

function normalizedCaptureOptions(options?: PocketImageCaptureOptions): Required<PocketImageCaptureOptions> {
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError("capture options must be an object");
  }
  const maxWidth = options?.maxWidth ?? POCKET_IMAGE_MAX_WIDTH;
  const maxHeight = options?.maxHeight ?? POCKET_IMAGE_MAX_HEIGHT;
  const maxPixels = options?.maxPixels ?? POCKET_IMAGE_MAX_PIXELS;
  if (!isPositiveIntegerAtMost(maxWidth, POCKET_IMAGE_MAX_WIDTH) ||
      !isPositiveIntegerAtMost(maxHeight, POCKET_IMAGE_MAX_HEIGHT) ||
      !isPositiveIntegerAtMost(maxPixels, POCKET_IMAGE_MAX_PIXELS)) {
    throw new RangeError("capture limits must be positive integers within the thumbnail bounds");
  }
  return { maxWidth, maxHeight, maxPixels };
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function parseStoredImage(value: unknown, requestedId: string): PocketStoredImageData {
  const reference = parseReference(value, "image read response");
  if (reference.id !== requestedId) {
    throw new PocketImagesError("image_id_mismatch", "Image read response did not match the requested id");
  }
  if (!isRecord(value)) {
    throw new PocketImagesError("invalid_image_response", "Image read response must be an object");
  }
  const textureWidth = value.textureWidth;
  const textureHeight = value.textureHeight;
  if (!isPositiveIntegerAtMost(textureWidth, POCKET_IMAGE_MAX_TEXTURE_WIDTH) ||
      !isPositiveIntegerAtMost(textureHeight, POCKET_IMAGE_MAX_TEXTURE_HEIGHT) ||
      textureWidth !== nextPowerOfTwo(reference.width) ||
      textureHeight !== nextPowerOfTwo(reference.height)) {
    throw new PocketImagesError("invalid_image_dimensions", "Image texture envelope is not the bounded power-of-two size");
  }
  const img = value.img;
  if (!(img instanceof Uint8Array) || img.byteLength < 8 || img.byteLength > POCKET_IMAGE_MAX_IMG_BYTES) {
    throw new PocketImagesError("invalid_image_payload", "Image read response must contain a bounded IMG Uint8Array");
  }
  const header = new DataView(img.buffer, img.byteOffset, img.byteLength);
  const width = header.getUint16(0, true);
  const height = header.getUint16(2, true);
  const psm = img[4];
  const flags = img[5];
  const reserved = header.getUint16(6, true);
  const expectedBytes = 8 + textureWidth * textureHeight * 4;
  if (width !== textureWidth || height !== textureHeight || psm !== 3 ||
      flags !== 2 || reserved !== 0 || img.byteLength !== expectedBytes) {
    throw new PocketImagesError("invalid_image_payload", "Image payload is not a raw bounded PSM_8888 IMG entry");
  }
  return {
    ...reference,
    textureWidth,
    textureHeight,
    img,
  };
}

/**
 * JS client for the existing per-child image capabilities. Binary pixels
 * remain Uint8Array values over Pocket's direct bridge; save records only need
 * to persist the opaque id and source dimensions.
 */
export function createPocketImagesClient(host: Pick<HostBridge, "request">): PocketImagesClient {
  return {
    async capture(options) {
      const limits = normalizedCaptureOptions(options);
      const result = await host.request("platform.images.capture", limits);
      const reference = parseReference(result, "image capture response");
      if (reference.width > limits.maxWidth || reference.height > limits.maxHeight ||
          reference.width * reference.height > limits.maxPixels) {
        throw new PocketImagesError("invalid_image_dimensions", "Captured image exceeds the requested limits");
      }
      return reference;
    },
    async read(id) {
      assertImageId(id);
      return parseStoredImage(await host.request("platform.images.read", { id }), id);
    },
    async list() {
      const result = await host.request("platform.images.list", {});
      if (!Array.isArray(result)) {
        throw new PocketImagesError("invalid_image_response", "Image list response must be an array");
      }
      return result.map((entry, index) => parseReference(entry, `image list entry ${index}`));
    },
    async remove(id) {
      assertImageId(id);
      const result = await host.request("platform.images.remove", { id });
      if (!isRecord(result) || typeof result.removed !== "boolean") {
        throw new PocketImagesError("invalid_image_response", "Image remove response must contain a boolean removed field");
      }
      return result.removed;
    },
  };
}
