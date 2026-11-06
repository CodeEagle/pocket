/**
 * Pure TFTC wire protocol helpers.
 *
 * This module contains the byte-level parts of the TryFun controller protocol
 * shared by the native and Noble transports. It deliberately has no
 * DOM, BLE, timer, or application-state dependency.  A transport owns message
 * id allocation and passes an id explicitly to `buildProtocolFrame`.
 */

export const SERVICE_UUID = '0000ffac-0000-1000-8000-00805f9b34fb';
export const SERVICE_SHORT_UUID = 'ffac';
export const CHAR_READ = 'ffb4';
export const CHAR_WRITE_RESPONSE = 'ffb5';
export const CHAR_WRITE_NO_RESPONSE = 'ffb7';
export const CHAR_NOTIFY = 'ffb8';

export const YXL_ONE_WRITE_SERVICE_UUID = '0000ff10-0000-1000-8000-00805f9b34fb';
export const YXL_ONE_NOTIFY_SERVICE_UUID = '0000ff12-0000-1000-8000-00805f9b34fb';
export const YXL_ONE_CHAR_WRITE = 'fff1';
export const YXL_ONE_CHAR_NOTIFY = 'ff14';

export const CMD_APP_REQUEST = 0x02;
export const CMD_MCU_REPLY = 0x03;
export const CMD_SECURITY_CHALLENGE = 0x0a;
export const CMD_SECURITY_DATA = 0x0b;
export const CMD_MANUFACTURER_QUERY = 0x0c;
export const CMD_MANUFACTURER_REPLY = 0x0d;
export const CMD_PROTOCOL_ERROR = 0x0f;
export const CMD_VIBRATION = 0x08;
export const CMD_LINEAR = 0x0b;
export const CMD_ROTARY = 0x0e;
export const CMD_HEAT = 0x05;
export const CMD_HEARTBEAT = 0xef;
export const CMD_STOP = 0xff;
export const YXL_ONE_CMD_WORK_CONTROL = 0x03;
export const YXL_ONE_CMD_TELESCOPIC = 0x07;
export const YXL_ONE_CMD_ROTATING = 0x08;
export const YXL_ONE_STOP_COMMAND_DELAY_MS = 140;

export const DEVICE_PREFIXES = Object.freeze(['TF-', 'DK-', 'TRYFUN-']);
export const DEFAULT_DEVICE_NAME = 'DK-META2';
export const DEFAULT_MOTION_OPTIONS = Object.freeze({
  maxOutput: 80,
  sensitivity: 1,
  minInterval: 170,
  minDelta: 4,
});
export const GATT_CONNECT_ATTEMPTS = 4;
export const GATT_SERVICE_ATTEMPTS = 4;
export const YXL_ONE_ACK_TIMEOUT_MS = 800;
export const YXL_ONE_STOP_ATTEMPTS = 3;
export const MANUFACTURER_QUERY_TIMEOUT_MS = 3000;
export const SECURITY_CHALLENGE_TIMEOUT_MS = 3000;
export const STANDARD_RESPONSE_TIMEOUT_MS = 3000;
export const ACTIONS_TO_ZERO = Object.freeze([
  Object.freeze(['linear', 0]),
  Object.freeze(['rotary', 0]),
  Object.freeze(['vibration', 0]),
  Object.freeze(['suction', 0]),
  Object.freeze(['heat', 0]),
]);

/** Return true only for an integer octet. */
export function isByte(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xff;
}

/**
 * Convert an iterable of octets into a fresh array and validate every value.
 * `Uint8Array`, DataView-backed slices, and normal arrays are all accepted.
 */
export function byteArray(value, label = 'byte array') {
  let bytes;
  try {
    if (value instanceof DataView) {
      bytes = Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    } else {
      bytes = Array.from(value ?? []);
    }
  } catch {
    throw new TypeError(`${label} must be an iterable byte array`);
  }
  if (bytes.some((byte) => !isByte(byte))) {
    throw new RangeError(`${label} contains a value outside 0..255`);
  }
  return bytes;
}

/** Validate and copy an array with an exact length. */
export function validateByteArray(value, expectedLength, label = 'byte array') {
  const bytes = byteArray(value, label);
  if (bytes.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
  return bytes;
}

/** Two's-complement additive checksum used by TFTC command frames. */
export function calculateChecksum(payload) {
  return (0 - byteArray(payload, 'checksum payload').reduce((sum, byte) => (sum + byte) & 0xff, 0)) & 0xff;
}

/**
 * Allocate message ids in the range 1..15 without sharing mutable module
 * state.  The returned closure is useful for a single client/connection.
 */
export function createMessageIdAllocator(start = 0) {
  if (!Number.isInteger(start) || start < 0 || start > 15) {
    throw new RangeError('message id seed must be an integer from 0 to 15');
  }
  let current = start;
  return () => {
    current = current >= 15 ? 1 : current + 1;
    return current;
  };
}

/**
 * Build a standard 4-byte-header TFTC frame.
 *
 * Message ids are intentionally explicit. Omitting `msgId` is deterministic
 * (`0`) and keeps this pure; connection clients should pass an id from their
 * own `createMessageIdAllocator`.
 */
export function buildProtocolFrame(command, payload = [], {
  contentType = 0,
  msgId = 0,
  totalFrames = 1,
  currentFrame = 0,
  includeChecksum = false,
} = {}) {
  if (!isByte(command)) throw new RangeError('protocol command must be a byte');
  const body = byteArray(payload, 'protocol payload');
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 15 ||
      !Number.isInteger(contentType) || contentType < 0 || contentType > 3 ||
      !Number.isInteger(totalFrames) || totalFrames < 1 || totalFrames > 16 ||
      !Number.isInteger(currentFrame) || currentFrame < 0 || currentFrame >= totalFrames) {
    throw new RangeError('protocol frame header parameters are invalid');
  }
  const wirePayload = includeChecksum ? [...body, calculateChecksum(body)] : body;
  if (wirePayload.length > 255) throw new RangeError('protocol payload cannot exceed 255 bytes');
  return new Uint8Array([
    ((contentType & 0x0f) << 4) | (msgId & 0x0f),
    command,
    (((totalFrames - 1) & 0x0f) << 4) | (currentFrame & 0x0f),
    wirePayload.length,
    ...wirePayload,
  ]);
}

/** Parse and strictly validate a standard TFTC frame. */
export function parseProtocolFrame(raw) {
  const bytes = byteArray(raw, 'protocol frame');
  if (bytes.length < 4) throw new RangeError('protocol frame header is truncated');
  const contentType = (bytes[0] >> 4) & 0x0f;
  if (contentType > 3) throw new RangeError('protocol frame content type is invalid');
  const frameLength = bytes[3];
  if (bytes.length !== frameLength + 4) {
    throw new RangeError(`protocol frame length mismatch: declared ${frameLength}, got ${bytes.length - 4}`);
  }
  const totalFrames = ((bytes[2] >> 4) & 0x0f) + 1;
  const currentFrame = bytes[2] & 0x0f;
  if (currentFrame >= totalFrames) throw new RangeError('protocol frame sequence is invalid');
  return {
    msgId: bytes[0] & 0x0f,
    contentType,
    command: bytes[1],
    totalFrames,
    currentFrame,
    frameLength,
    payload: bytes.slice(4),
    raw: new Uint8Array(bytes),
  };
}

/** Check a checksum byte appended to a payload. Invalid inputs return false. */
export function hasValidChecksum(payload) {
  try {
    const bytes = byteArray(payload, 'checksum payload');
    return bytes.length >= 1 && calculateChecksum(bytes.slice(0, -1)) === bytes[bytes.length - 1];
  } catch {
    return false;
  }
}

/** Decode the 15-byte Manufacturer Specific Data payload used by DokiDoki. */
export function parseManufacturerDataPayload(payload) {
  const bytes = validateByteArray(payload, 15, 'Manufacturer Specific Data');
  if (bytes[0] !== 0xff) throw new RangeError('Manufacturer Specific Data Type must be 0xFF');
  const cid = bytes[1] | (bytes[2] << 8);
  if (cid !== 0x5fc5 && cid !== 0x4fa1) {
    throw new RangeError(`unsupported Manufacturer CID: 0x${cid.toString(16).padStart(4, '0')}`);
  }
  const versionSubtype = bytes[3];
  const version = versionSubtype & 0x0f;
  const subtype = (versionSubtype >> 4) & 0x0f;
  if (version < 1 || subtype !== 0x0b) throw new RangeError('Manufacturer Specific Data version/subtype is invalid');
  const fmsk = bytes[4];
  const productBytes = bytes.slice(5, 9);
  const wireProductId = productBytes.reduce((value, byte) => ((value << 8) | byte) >>> 0, 0);
  // funapp TFProductInfo.from reverses v3+ wire fields before fullPid's
  // little-endian semantic packing. The resulting numeric PID is big-endian
  // on the v3+ wire, and little-endian on historical v1/v2 advertisements.
  const productId = version >= 3 ? wireProductId
    : (productBytes[0] | (productBytes[1] << 8) | (productBytes[2] << 16) | (productBytes[3] << 24)) >>> 0;
  const mac = bytes.slice(9, 15);
  return {
    raw: bytes,
    type: bytes[0],
    cid,
    version,
    subtype,
    fmsk,
    requiresSecurity: Boolean(fmsk & 0x08),
    supportsOta: Boolean(fmsk & 0x04),
    productId,
    wireProductId,
    wireProductIdBytes: productBytes,
    mac,
    macString: mac.map((byte) => byte.toString(16).padStart(2, '0')).join(':').toUpperCase(),
  };
}

/** CoreBluetooth manufacturer data includes CID but excludes AD length/type.
 * Source: funapp ManufacturerData._fromScanPayload; duplicate complete records
 * are accepted only when all copies are identical. No security flag is inferred.
 */
export function parseManufacturerAdvertisement(raw) {
  const bytes = Array.from(raw || []);
  if (bytes.length < 14 || bytes.length % 14 !== 0) throw new RangeError('Manufacturer advertisement must contain complete 14-byte records');
  for (let index = 0; index < bytes.length; index++) {
    if (!isByte(bytes[index]) || bytes[index] !== bytes[index % 14]) throw new RangeError('Conflicting manufacturer advertisement records');
  }
  return { ...parseManufacturerDataPayload([0xff, ...bytes.slice(0, 14)]), source: 'advertisement' };
}

export function reverseUint32Bytes(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError('value must be an unsigned 32-bit integer');
  }
  const number = value >>> 0;
  return (((number & 0xff) << 24) |
    ((number & 0xff00) << 8) |
    ((number >>> 8) & 0xff00) |
    (number >>> 24)) >>> 0;
}

/** Build an application command frame with an appended additive checksum. */
export function buildFrame(cmdType, payload, options = {}) {
  return buildProtocolFrame(cmdType, payload, { ...options, includeChecksum: true });
}

export function buildCommandFrame(cmd, value, options = {}) {
  return buildFrame(CMD_APP_REQUEST, [cmd, value], options);
}

export function buildMultiCommandFrame(...args) {
  let options = {};
  if (args.length && !Array.isArray(args.at(-1)) && args.at(-1) && typeof args.at(-1) === 'object') {
    options = args.pop();
  }
  return buildFrame(CMD_APP_REQUEST, args.flat(), options);
}

/** Build the compact 0xAA-prefixed YXL-ONE frame. */
export function buildYxlOneFrame(cmd, ...params) {
  const payload = byteArray([cmd, ...params], 'YXL-ONE payload');
  if (payload.length > 255) throw new RangeError('YXL-ONE payload cannot exceed 255 bytes');
  return new Uint8Array([0xaa, payload.length, ...payload, calculateChecksum(payload)]);
}

export function clampPercent(value) {
  if (!Number.isFinite(Number(value))) throw new TypeError('percent must be a finite number');
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

export function rotaryToBLE(value) {
  const number = clampPercent(Math.abs(Number(value))) * (Number(value) < 0 ? -1 : 1);
  if (number >= 0) return Math.min(Math.round(number), 100);
  return (255 + Math.max(Math.round(number), -100)) & 0xff;
}

export function rockVibrationSequence(value) {
  const level = clampPercent(value);
  return level === 0 ? [[0x07, 0x02]] : [[0x09, Math.min(50, Math.floor(level / 2))]];
}

export function springVibrationSequence(value) {
  const level = clampPercent(value);
  return level === 0 ? [[0x07, 0x02]] : [[0x08, 0x0b], [0x09, level]];
}

export const DEVICE_PROFILES = Object.freeze([
  Object.freeze({
    name: 'TRYFUN-ONE', protocol: 'yxlone',
    commands: Object.freeze({ linear: YXL_ONE_CMD_TELESCOPIC, rotary: YXL_ONE_CMD_ROTATING, stop: YXL_ONE_CMD_WORK_CONTROL }),
    capabilities: Object.freeze(['linear', 'rotary']),
    stopSequence: Object.freeze([
      Object.freeze([YXL_ONE_CMD_TELESCOPIC, 0x00]),
      Object.freeze([YXL_ONE_CMD_ROTATING, 0x00]),
      Object.freeze([YXL_ONE_CMD_WORK_CONTROL, 0x00]),
    ]),
  }),
  Object.freeze({ name: 'DK-META2', protocol: 'dokidoki', productId: 0x00011401, commands: Object.freeze({ vibration: CMD_VIBRATION, linear: CMD_LINEAR, rotary: CMD_ROTARY }) }),
  Object.freeze({ name: 'DK-PTPRO', protocol: 'dokidoki', productId: 0x00011501, commands: Object.freeze({ vibration: 0x09, suction: 0x12, stop: CMD_STOP }), actionSequences: Object.freeze({ vibration: Object.freeze([[0x07, 0x01], [0x09, 'value']]), suction: Object.freeze([[0x10, 0x01], [0x12, 'value']]) }), stopSequence: Object.freeze([[0x07, 0x00], [0x10, 0x00], [0x09, 0x00], [0x12, 0x00]]) }),
  Object.freeze({ name: 'DK-BH2PRO', protocol: 'dokidoki', productId: 0x00011601, commands: Object.freeze({ vibration: 0x09, linear: 0x0c, stop: CMD_STOP }) }),
  Object.freeze({ name: 'DK-BHPRO', protocol: 'dokidoki', productId: 0x00011701, commands: Object.freeze({ linear: 0x27, stop: CMD_STOP }) }),
  Object.freeze({ name: 'DK-BHSE', protocol: 'dokidoki', productId: 0x00011801, commands: Object.freeze({ linear: 0x0c, stop: CMD_STOP }) }),
  Object.freeze({ name: 'DK-BHMAX', protocol: 'dokidoki', productId: 0x00011901, commands: Object.freeze({ linear: 0x0c, stop: CMD_STOP }) }),
  Object.freeze({ name: 'DK-META2SE', protocol: 'dokidoki', productId: 0x00011a01, commands: Object.freeze({ linear: CMD_LINEAR, rotary: CMD_ROTARY }) }),
  Object.freeze({ name: 'DK-PT3', protocol: 'dokidoki', productId: 0x00011b01, commands: Object.freeze({ rotary: 0x0f, suction: 0x10, stop: CMD_STOP }), actionSequences: Object.freeze({ suction: (value) => value === 0 ? [[0x10, 0x00]] : [[0x0f, 0x00], [0x10, 0x01]] }) }),
  Object.freeze({ name: 'DK-ROCK', protocol: 'dokidoki', productId: 0x01040100, commands: Object.freeze({ heat: CMD_HEAT, vibration: 0x09 }), actionSequences: Object.freeze({ vibration: rockVibrationSequence }), stopSequence: Object.freeze([[0x07, 0x02], [CMD_HEAT, 0x00]]) }),
  Object.freeze({ name: 'DK-SPRING', protocol: 'dokidoki', productId: 0x01080100, commands: Object.freeze({ vibration: 0x09 }), actionSequences: Object.freeze({ vibration: springVibrationSequence }), stopSequence: Object.freeze([[0x07, 0x02], [0x09, 0x00]]) }),
  Object.freeze({ name: 'DK-BHPLUS', protocol: 'dokidoki', productId: 0x00011f01, commands: Object.freeze({ vibration: 0x09, linear: 0x0c, stop: CMD_STOP }) }),
  Object.freeze({ name: 'DK-SOULMT', protocol: 'dokidoki', productId: 0x00012001, commands: Object.freeze({ vibration: 0x09, suction: 0x12, stop: CMD_STOP }) }),
]);

export const DEVICE_PROFILE_BY_NAME = new Map(DEVICE_PROFILES.map((profile) => [profile.name, profile]));

export function normalizeProfileName(deviceName) {
  const name = String(deviceName ?? '').toUpperCase();
  return name.startsWith('TF-') ? `DK-${name.slice(3)}` : name;
}

export function getDeviceProfile(deviceName = DEFAULT_DEVICE_NAME) {
  return DEVICE_PROFILE_BY_NAME.get(deviceName ? normalizeProfileName(deviceName) : DEFAULT_DEVICE_NAME);
}

export function isBluetoothUuid(uuid, shortUuid) {
  const normalized = String(uuid ?? '').toLowerCase();
  const short = String(shortUuid ?? '').toLowerCase();
  return normalized === short || normalized.startsWith(`0000${short}-`);
}

export function isGattDisconnectedError(error) {
  return /gatt server is disconnected|\(re\)connect first|reconnect first|networkerror|disconnected/i.test(error?.message || '');
}

export function getErrorDetail(error) {
  return { name: error?.name || 'Error', message: error?.message || String(error || 'unknown') };
}

export async function writeCharacteristicValue(characteristic, frame, withoutResponse = false) {
  if (!characteristic || typeof characteristic !== 'object') throw new TypeError('characteristic is required');
  const bytes = byteArray(frame, 'characteristic frame');
  const wire = new Uint8Array(bytes);
  if (withoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') {
    await characteristic.writeValueWithoutResponse(wire);
    return;
  }
  if (!withoutResponse && typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(wire);
    return;
  }
  if (typeof characteristic.writeValue !== 'function') throw new TypeError('characteristic has no write method');
  await characteristic.writeValue(wire);
}
