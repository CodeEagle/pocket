import { strict as assert } from "node:assert";
import { test } from "bun:test";
import type { BridgeValue, HostBridge } from "../src/host.ts";
import {
  createPocketImagesClient,
  PocketImagesError,
  type PocketStoredImageData,
} from "../src/images.ts";

const id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeImage(width = 3, height = 2): PocketStoredImageData {
  const textureWidth = nextPowerOfTwo(width);
  const textureHeight = nextPowerOfTwo(height);
  const img = new Uint8Array(8 + textureWidth * textureHeight * 4);
  const header = new DataView(img.buffer);
  header.setUint16(0, textureWidth, true);
  header.setUint16(2, textureHeight, true);
  img[4] = 3; // PSM_8888
  img[5] = 2; // IMG_FLAG_LINEAR
  return { id, width, height, textureWidth, textureHeight, img };
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function fakeHost(responses: BridgeValue[]) {
  const calls: Array<{ capability: string; params: Record<string, unknown> }> = [];
  let index = 0;
  const host = {
    request: async <T extends BridgeValue = BridgeValue>(
      capability: string,
      params: Record<string, unknown> = {},
    ): Promise<T> => {
      calls.push({ capability, params });
      return responses[index++] as T;
    },
  } as Pick<HostBridge, "request">;
  return { host, calls };
}

test("capture sends bounded defaults and returns strict image metadata", async () => {
  const { host, calls } = fakeHost([{ id, width: 256, height: 256 }]);
  const images = createPocketImagesClient(host);
  const captured = await images.capture();
  assert.deepEqual(captured, { id, width: 256, height: 256 });
  assert.deepEqual(calls, [{
    capability: "platform.images.capture",
    params: { maxWidth: 256, maxHeight: 256, maxPixels: 65_536 },
  }]);
});

test("capture preserves caller bounds and rejects host results outside them", async () => {
  const { host, calls } = fakeHost([
    { id, width: 80, height: 40 },
    { id, width: 96, height: 48 },
  ]);
  const images = createPocketImagesClient(host);
  assert.deepEqual(await images.capture({ maxWidth: 80, maxHeight: 40, maxPixels: 3_200 }), {
    id, width: 80, height: 40,
  });
  assert.deepEqual(calls[0], {
    capability: "platform.images.capture",
    params: { maxWidth: 80, maxHeight: 40, maxPixels: 3_200 },
  });
  await assert.rejects(
    images.capture({ maxWidth: 80, maxHeight: 40, maxPixels: 3_200 }),
    error => error instanceof PocketImagesError && error.code === "invalid_image_dimensions",
  );
  await assert.rejects(images.capture({ maxWidth: 257 }), RangeError);
  assert.equal(calls.length, 2, "invalid limits must not cross the host bridge");
});

test("read returns the same raw Uint8Array IMG blob after validating its envelope", async () => {
  const resource = makeImage();
  const { host, calls } = fakeHost([resource as unknown as BridgeValue]);
  const image = await createPocketImagesClient(host).read(id);
  assert.equal(image.img, resource.img);
  assert.deepEqual({
    id: image.id,
    width: image.width,
    height: image.height,
    textureWidth: image.textureWidth,
    textureHeight: image.textureHeight,
  }, { id, width: 3, height: 2, textureWidth: 4, textureHeight: 2 });
  assert.deepEqual(calls, [{ capability: "platform.images.read", params: { id } }]);
});

test("read accepts an offset Uint8Array view without copying its pixel payload", async () => {
  const resource = makeImage(256, 256);
  const backing = new Uint8Array(resource.img.byteLength + 12);
  backing.set(resource.img, 6);
  const view = backing.subarray(6, 6 + resource.img.byteLength);
  const { host } = fakeHost([{ ...resource, img: view } as unknown as BridgeValue]);
  const loaded = await createPocketImagesClient(host).read(id);
  assert.equal(loaded.img, view);
  assert.equal(loaded.img.buffer, backing.buffer);
  assert.equal(loaded.img.byteOffset, 6);
});

test("list and remove keep the compact metadata contract", async () => {
  const reference = { id, width: 64, height: 32 };
  const { host, calls } = fakeHost([[reference], { removed: false }]);
  const images = createPocketImagesClient(host);
  assert.deepEqual(await images.list(), [reference]);
  assert.equal(await images.remove(id), false);
  assert.deepEqual(calls, [
    { capability: "platform.images.list", params: {} },
    { capability: "platform.images.remove", params: { id } },
  ]);
});

test("invalid ids, dimensions, byte encodings and IMG headers fail before upload", async () => {
  const valid = makeImage();
  const wrongPsm = makeImage();
  wrongPsm.img[4] = 0;
  const badPadding = { ...makeImage(), textureWidth: 8 };
  const base64Payload = { ...makeImage(), img: "AQIDBA==" };
  const truncated = { ...makeImage(), img: makeImage().img.subarray(0, 10) };
  const { host, calls } = fakeHost([
    valid as unknown as BridgeValue,
    wrongPsm as unknown as BridgeValue,
    badPadding as unknown as BridgeValue,
    base64Payload as unknown as BridgeValue,
    truncated as unknown as BridgeValue,
  ]);
  const images = createPocketImagesClient(host);

  await assert.rejects(images.read("../not-an-id"), PocketImagesError);
  assert.equal(calls.length, 0, "invalid ids must not cross the host bridge");
  assert.equal((await images.read(id)).img, valid.img);
  await assert.rejects(images.read(id), PocketImagesError);
  await assert.rejects(images.read(id), PocketImagesError);
  await assert.rejects(images.read(id), PocketImagesError);
  await assert.rejects(images.read(id), PocketImagesError);
  assert.equal(calls.length, 5);
});

test("host capability errors propagate unchanged", async () => {
  const failure = new Error("image store unavailable");
  const host = {
    request: async () => { throw failure; },
  } as Pick<HostBridge, "request">;
  await assert.rejects(createPocketImagesClient(host).list(), (error: unknown) => error === failure);
});
