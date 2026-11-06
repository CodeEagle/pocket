/**
 * TFTC v1 BLE security primitives for browser/PocketJS guests.
 *
 * Product secrets are deliberately supplied by the caller. This module does
 * not contain a product-secret table and does not use Node built-ins. It
 * requires Web Crypto in a browser/PocketJS runtime. If keys remain owned by
 * the host, inject the host's begin/complete/clear bridge into TftcClient;
 * callers that intentionally provide keys may use createBleSecurityProvider.
 */

export const SECURITY_VERSION = 0x01;
export const SECURITY_INIT_PHASE = 0x01;
export const SECURITY_AUTH_PHASE = 0x02;
export const RESERVED_FLAGS = 0x00;
export const DEVICE_PROOF_PURPOSE = 0xd1;
export const APP_AUTH_PURPOSE = 0xa1;
export const SHIFT_PURPOSE = 0x51;
export const MAX_SESSIONS = 32;
export const KEY_DERIVATIONS = Object.freeze([
  "rawBytes",
  "legacyLowercaseHexPrefix",
  "legacyUppercaseHexPrefix",
]);

const HEX_RE = /^[0-9a-fA-F]{32}$/;
const ZERO_IV = new Uint8Array(16);

export class BleSecurityError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "BleSecurityError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new BleSecurityError(code, message);
}

function bytes(value, expectedLength, fieldName) {
  if (typeof value === "string") {
    fail("invalid_input", `${fieldName} must be a byte array`);
  }
  if (!value || typeof value.length !== "number" || value.length !== expectedLength) {
    fail("invalid_input", `${fieldName} must contain ${expectedLength} bytes`);
  }
  const result = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const byte = Number(value[index]);
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      fail("invalid_input", `${fieldName} contains an invalid byte`);
    }
    result[index] = byte;
  }
  return result;
}

function productSecretBytes(value) {
  if (typeof value !== "string" || !HEX_RE.test(value)) {
    fail(
      "invalid_product_secret_config",
      "product secret entries must be 32 hexadecimal characters",
    );
  }
  const result = new Uint8Array(16);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function normalizeKeyDerivation(value) {
  if (value === "raw" || value === "rawBytes") return "rawBytes";
  if (value === "lowerhex" || value === "legacyLowercaseHexPrefix") {
    return "legacyLowercaseHexPrefix";
  }
  if (value === "upperhex" || value === "legacyUppercaseHexPrefix") {
    return "legacyUppercaseHexPrefix";
  }
  fail("invalid_input", "unknown product-secret derivation");
}

function candidateProductKey(secret, keyDerivation) {
  if (keyDerivation === "rawBytes") return new Uint8Array(secret);
  const alphabet = keyDerivation === "legacyLowercaseHexPrefix"
    ? "0123456789abcdef"
    : "0123456789ABCDEF";
  const key = new Uint8Array(16);
  // The legacy modes intentionally encode only the first eight secret bytes
  // as sixteen ASCII hex bytes, matching the historical app implementation.
  for (let index = 0; index < 8; index += 1) {
    const value = secret[index];
    key[index * 2] = alphabet.charCodeAt(value >> 4);
    key[index * 2 + 1] = alphabet.charCodeAt(value & 0x0f);
  }
  return key;
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Encrypt one block with AES-128 ECB using Web Crypto AES-CBC.
 *
 * Web Crypto does not expose AES-ECB, but AES-CBC's first block with a zero IV
 * is exactly AES-ECB.  The API applies PKCS#7 padding unconditionally; the
 * first sixteen bytes of the resulting two-block ciphertext are the desired
 * block and the padding block is discarded.
 */
export async function aes128Ecb(keyValue, blockValue, cryptoImpl = globalThis.crypto) {
  const key = bytes(keyValue, 16, "key");
  const block = bytes(blockValue, 16, "block");
  const subtle = cryptoImpl?.subtle;
  if (!subtle || typeof subtle.importKey !== "function" || typeof subtle.encrypt !== "function") {
    fail("security_error", "Web Crypto AES-CBC is unavailable");
  }
  try {
    const cryptoKey = await subtle.importKey(
      "raw",
      key,
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    );
    const encrypted = new Uint8Array(
      await subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, cryptoKey, block),
    );
    if (encrypted.length < 16) {
      fail("security_error", "AES-CBC returned an invalid block");
    }
    return encrypted.slice(0, 16);
  } catch (error) {
    if (error instanceof BleSecurityError) throw error;
    fail("security_error", `AES-128 ECB failed: ${error?.message || error}`);
  }
}

async function deriveDeviceSecret(candidateKey, mac, cryptoImpl) {
  return aes128Ecb(candidateKey, concatBytes(mac, new Uint8Array(10)), cryptoImpl);
}

async function deriveBase(deviceSecret, appNonce, deviceNonce, cryptoImpl) {
  return aes128Ecb(deviceSecret, concatBytes(appNonce, deviceNonce), cryptoImpl);
}

async function derivePurposeBlock(deviceSecret, base, purpose, cryptoImpl) {
  const input = new Uint8Array(16);
  input.set(base.slice(0, 14), 0);
  input[14] = SECURITY_VERSION;
  input[15] = purpose;
  return aes128Ecb(deviceSecret, input, cryptoImpl);
}

async function deriveCandidateMaterial(secret, mac, appNonce, deviceNonce, keyDerivation, cryptoImpl) {
  const candidateKey = candidateProductKey(secret, keyDerivation);
  const deviceSecret = await deriveDeviceSecret(candidateKey, mac, cryptoImpl);
  const base = await deriveBase(deviceSecret, appNonce, deviceNonce, cryptoImpl);
  const proofBlock = await derivePurposeBlock(deviceSecret, base, DEVICE_PROOF_PURPOSE, cryptoImpl);
  const authBlock = await derivePurposeBlock(deviceSecret, base, APP_AUTH_PURPOSE, cryptoImpl);
  const shiftSeed = await derivePurposeBlock(deviceSecret, base, SHIFT_PURPOSE, cryptoImpl);
  return { candidateKey, deviceSecret, base, proofBlock, authBlock, shiftSeed };
}

function clearBytes(material) {
  if (!material) return;
  for (const value of Object.values(material)) {
    if (value instanceof Uint8Array) value.fill(0);
  }
}

function constantTimeEquals(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function buildAuthPayload(authBlock) {
  return concatBytes(
    new Uint8Array([SECURITY_AUTH_PHASE, SECURITY_VERSION, RESERVED_FLAGS]),
    authBlock.slice(0, 6),
  );
}

/**
 * Derive the v1 handshake material for one candidate product secret.
 *
 * The returned byte arrays are new copies and are suitable for the TFTC
 * security provider contract.  This function is intentionally asynchronous so
 * it can use the browser's Web Crypto implementation rather than Node crypto.
 */
export async function deriveV1Material({
  productSecret,
  mac,
  appNonce,
  deviceNonce,
  keyDerivation = "rawBytes",
  cryptoImpl = globalThis.crypto,
}) {
  const secret = productSecretBytes(productSecret);
  const macBytes = bytes(mac, 6, "mac");
  const appNonceBytes = bytes(appNonce, 8, "appNonce");
  const deviceNonceBytes = bytes(deviceNonce, 8, "deviceNonce");
  const derivation = normalizeKeyDerivation(keyDerivation);
  const material = await deriveCandidateMaterial(
    secret,
    macBytes,
    appNonceBytes,
    deviceNonceBytes,
    derivation,
    cryptoImpl,
  );
  try {
    return {
      keyDerivation: derivation,
      deviceSecret: material.deviceSecret.slice(),
      base: material.base.slice(),
      deviceProof: material.proofBlock.slice(0, 6),
      appAuth: material.authBlock.slice(0, 6),
      shiftSeed: material.shiftSeed.slice(),
      shiftValue: (material.shiftSeed[0] % 255) + 1,
      algorithmIndex: material.shiftSeed[1] % 4,
      authPayload: buildAuthPayload(material.authBlock),
      initPayload: concatBytes(
        new Uint8Array([SECURITY_INIT_PHASE, SECURITY_VERSION, RESERVED_FLAGS]),
        appNonceBytes,
      ),
      challengePayload: concatBytes(
        new Uint8Array([SECURITY_VERSION, RESERVED_FLAGS]),
        deviceNonceBytes,
        material.proofBlock.slice(0, 6),
      ),
    };
  } finally {
    clearBytes(material);
    secret.fill(0);
    macBytes.fill(0);
    appNonceBytes.fill(0);
    deviceNonceBytes.fill(0);
  }
}

function randomBytes(cryptoImpl, length) {
  const result = new Uint8Array(length);
  if (typeof cryptoImpl?.getRandomValues !== "function") {
    fail("security_error", "secure random generation is unavailable");
  }
  try {
    cryptoImpl.getRandomValues(result);
  } catch (_) {
    fail("security_error", "random nonce generation failed");
  }
  return result;
}

function sessionId(cryptoImpl) {
  const bytesValue = randomBytes(cryptoImpl, 16);
  return Array.from(bytesValue, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeProductId(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    fail("invalid_input", "productId must be an unsigned 32-bit integer");
  }
  return value;
}

/**
 * Build an injected security backend for `TftcClient`.
 *
 * `productSecretsByProductId` may be a Map or a plain object whose values are
 * arrays of 32-character hexadecimal secrets.  Secrets are copied and cleared
 * when a session is completed or cleared; callers remain responsible for the
 * lifetime of the original configuration object.
 */
export function createBleSecurityProvider({
  productSecretsByProductId,
  cryptoImpl = globalThis.crypto,
  maxSessions = MAX_SESSIONS,
} = {}) {
  const sessionLimit = Number.isSafeInteger(maxSessions) && maxSessions > 0
    ? maxSessions
    : MAX_SESSIONS;
  const sessions = new Map();
  const getSecrets = (productId) => {
    const key = String(productId);
    const values = productSecretsByProductId instanceof Map
      ? productSecretsByProductId.get(productId) ?? productSecretsByProductId.get(key)
      : productSecretsByProductId?.[key];
    if (!Array.isArray(values) || values.length === 0) {
      fail("missing_product_secret", "BLE product secret is not configured for this product");
    }
    return values.map(productSecretBytes);
  };

  async function beginBleSecurity({ productId, mac }) {
    const normalizedProductId = normalizeProductId(productId);
    if (sessions.size >= sessionLimit) fail("session_limit", "too many unfinished BLE security sessions");
    const macBytes = bytes(mac, 6, "mac");
    const secrets = getSecrets(normalizedProductId);
    const appNonce = randomBytes(cryptoImpl, 8);
    let id = sessionId(cryptoImpl);
    for (let attempt = 0; sessions.has(id) && attempt < 8; attempt += 1) id = sessionId(cryptoImpl);
    if (sessions.has(id)) fail("security_error", "session id generation failed");
    const initPayload = concatBytes(
      new Uint8Array([SECURITY_INIT_PHASE, SECURITY_VERSION, RESERVED_FLAGS]),
      appNonce,
    );
    sessions.set(id, {
      productId: normalizedProductId,
      mac: macBytes,
      appNonce,
      secrets,
      revoked: false,
    });
    return { sessionId: id, initPayload: Array.from(initPayload) };
  }

  async function completeBleSecurity({ sessionId: id, challengePayload }) {
    if (typeof id !== "string" || id.length === 0) fail("invalid_input", "sessionId must be a non-empty string");
    const session = sessions.get(id);
    if (!session) fail("session_not_found", "BLE security session was not found");
    const challenge = bytes(challengePayload, 16, "challengePayload");
    try {
      if (challenge[0] > SECURITY_VERSION) fail("unsupported_security_version", "BLE security version is newer than this client");
      if (challenge[0] < SECURITY_VERSION || challenge[1] !== RESERVED_FLAGS) fail("invalid_challenge", "BLE security challenge header is invalid");
      const deviceNonce = challenge.slice(2, 10);
      const deviceProof = challenge.slice(10, 16);
      for (const secret of session.secrets) {
        for (const derivation of KEY_DERIVATIONS) {
          const material = await deriveCandidateMaterial(secret, session.mac, session.appNonce, deviceNonce, derivation, cryptoImpl);
          try {
            // clearBleSecurity may revoke this session while Web Crypto is in
            // flight. Never return auth material for a session removed from
            // the map, even when the proof was already computed.
            if (session.revoked || sessions.get(id) !== session) {
              fail("session_not_found", "BLE security session was revoked");
            }
            if (!constantTimeEquals(deviceProof, material.proofBlock.slice(0, 6))) continue;
            if (session.revoked || sessions.get(id) !== session) {
              fail("session_not_found", "BLE security session was revoked");
            }
            return {
              authPayload: Array.from(buildAuthPayload(material.authBlock)),
              shiftValue: (material.shiftSeed[0] % 255) + 1,
              algorithmIndex: material.shiftSeed[1] % 4,
            };
          } finally {
            clearBytes(material);
          }
        }
      }
      fail("device_proof_mismatch", "BLE security challenge proof did not match");
    } finally {
      challenge.fill(0);
      sessions.delete(id);
      session.mac.fill(0);
      session.appNonce.fill(0);
      session.secrets.forEach((secret) => secret.fill(0));
    }
  }

  async function clearBleSecurity(id) {
    if (typeof id !== "string" || id.length === 0) fail("invalid_input", "sessionId must be a non-empty string");
    const session = sessions.get(id);
    if (!session) return { ok: false };
    session.revoked = true;
    sessions.delete(id);
    session.mac.fill(0);
    session.appNonce.fill(0);
    session.secrets.forEach((secret) => secret.fill(0));
    return { ok: true };
  }

  return { beginBleSecurity, completeBleSecurity, clearBleSecurity };
}
