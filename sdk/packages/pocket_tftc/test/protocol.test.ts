import { expect, test } from "bun:test";
import {
  CMD_APP_REQUEST,
  DEVICE_PROFILES,
  buildCommandFrame,
  buildMultiCommandFrame,
  buildProtocolFrame,
  buildYxlOneFrame,
  calculateChecksum,
  createMessageIdAllocator,
  getDeviceProfile,
  hasValidChecksum,
  parseManufacturerDataPayload,
  parseProtocolFrame,
  reverseUint32Bytes,
} from "../src/protocol.js";

test("standard TFTC frame round trips with an explicit message id", () => {
  const frame = buildProtocolFrame(CMD_APP_REQUEST, [0x0b, 0x2a], {
    msgId: 7,
    includeChecksum: true,
  });
  expect([...frame]).toEqual([0x07, 0x02, 0x00, 0x03, 0x0b, 0x2a, 0xcb]);
  const parsed = parseProtocolFrame(frame);
  expect(parsed).toMatchObject({
    msgId: 7,
    contentType: 0,
    command: CMD_APP_REQUEST,
    totalFrames: 1,
    currentFrame: 0,
    frameLength: 3,
    payload: [0x0b, 0x2a, 0xcb],
  });
  expect(hasValidChecksum(parsed.payload)).toBe(true);
});

test("frame parser rejects malformed length and sequence headers", () => {
  expect(() => parseProtocolFrame([0x01, CMD_APP_REQUEST, 0x00, 0x02, 0x01])).toThrow();
  expect(() => parseProtocolFrame([0x01, CMD_APP_REQUEST, 0x01, 0x00])).toThrow();
  expect(() => buildProtocolFrame(CMD_APP_REQUEST, [256], { msgId: 1 })).toThrow();
  expect(() => buildProtocolFrame(CMD_APP_REQUEST, [], { msgId: 16 })).toThrow();
});

test("message id allocator is isolated and wraps 15 to 1", () => {
  const first = createMessageIdAllocator(14);
  const second = createMessageIdAllocator(0);
  expect([first(), first(), first()]).toEqual([15, 1, 2]);
  expect([second(), second()]).toEqual([1, 2]);
});

test("application and YXL-ONE command vectors preserve the retained wire format", () => {
  expect([...buildCommandFrame(0x08, 0x64, { msgId: 1 })]).toEqual([0x01, 0x02, 0x00, 0x03, 0x08, 0x64, 0x94]);
  expect([...buildMultiCommandFrame([0x08, 0x64], [0x0b, 0x00], { msgId: 2 })]).toEqual([0x02, 0x02, 0x00, 0x05, 0x08, 0x64, 0x0b, 0x00, 0x89]);
  expect([...buildYxlOneFrame(0x07, 0x04)]).toEqual([0xaa, 0x02, 0x07, 0x04, 0xf5]);
  expect(calculateChecksum([0x07, 0x04])).toBe(0xf5);
});

test("manufacturer payload decodes product and security flags", () => {
  const payload = [0xff, 0xc5, 0x5f, 0xb1, 0x0c, 0x01, 0x14, 0x01, 0x00, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab];
  expect(parseManufacturerDataPayload(payload)).toMatchObject({
    cid: 0x5fc5,
    version: 1,
    subtype: 0x0b,
    fmsk: 0x0c,
    requiresSecurity: true,
    supportsOta: true,
    productId: 0x00011401,
    wireProductId: 0x01140100,
    macString: "01:23:45:67:89:AB",
  });
  expect(() => parseManufacturerDataPayload(payload.slice(0, 14))).toThrow();
});

test("profiles normalize TF aliases without mutating retained definitions", () => {
  expect(getDeviceProfile("TF-META2")?.name).toBe("DK-META2");
  expect(getDeviceProfile("tryfun-one")?.protocol).toBe("yxlone");
  expect(DEVICE_PROFILES.length).toBeGreaterThan(10);
  expect(reverseUint32Bytes(0x11223344)).toBe(0x44332211);
});
