import { test, expect } from "bun:test";
import {
  aes128Ecb,
  createBleSecurityProvider,
  deriveV1Material,
} from "../src/security.js";

const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (part) => parseInt(part, 16));
const toHex = (value: ArrayLike<number>) => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const vector = {
  productSecret: "10101010101010101010101010101010",
  mac: "202122232425",
  appNonce: "3030303030303030",
  deviceNonce: "4040404040404040",
  deviceSecret: "a8754e346dab684299f9f0ef3f218867",
  base: "e67314c992c9bd9e39fe475957f93a8c",
  deviceProof: "67ecb3538eab",
  appAuth: "f2fc309a35c2",
  initPayload: "0101003030303030303030",
  challengePayload: "0100404040404040404067ecb3538eab",
  authPayload: "020100f2fc309a35c2",
  shiftSeed: "c98560960f65ca7fb34addcfb31510a0",
  shiftValue: 202,
  algorithmIndex: 1,
};

test("Web Crypto AES-128 ECB compatibility and v1 derivation match SyncDo", async () => {
  const encrypted = await aes128Ecb(
    fromHex("000102030405060708090a0b0c0d0e0f"),
    fromHex("00112233445566778899aabbccddeeff"),
  );
  expect(toHex(encrypted)).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");

  const material = await deriveV1Material({
    productSecret: vector.productSecret,
    mac: fromHex(vector.mac),
    appNonce: fromHex(vector.appNonce),
    deviceNonce: fromHex(vector.deviceNonce),
  });
  expect(toHex(material.deviceSecret)).toBe(vector.deviceSecret);
  expect(toHex(material.base)).toBe(vector.base);
  expect(toHex(material.deviceProof)).toBe(vector.deviceProof);
  expect(toHex(material.appAuth)).toBe(vector.appAuth);
  expect(toHex(material.shiftSeed)).toBe(vector.shiftSeed);
  expect(toHex(material.initPayload)).toBe(vector.initPayload);
  expect(toHex(material.challengePayload)).toBe(vector.challengePayload);
  expect(toHex(material.authPayload)).toBe(vector.authPayload);
  expect(material.shiftValue).toBe(vector.shiftValue);
  expect(material.algorithmIndex).toBe(vector.algorithmIndex);
});

test("injected provider accepts all legacy key derivations without embedding secrets", async () => {
  for (const keyDerivation of ["rawBytes", "legacyLowercaseHexPrefix", "legacyUppercaseHexPrefix"] as const) {
    const provider = createBleSecurityProvider({
      productSecretsByProductId: { "7": ["00112233445566778899aabbccddeeff", "abcdef0123456789abcdef0123456789"] },
    });
    const started = await provider.beginBleSecurity({ productId: 7, mac: fromHex("202122232425") });
    const startedMaterial = await deriveV1Material({
      productSecret: "abcdef0123456789abcdef0123456789",
      mac: fromHex("202122232425"),
      appNonce: started.initPayload.slice(3),
      deviceNonce: fromHex("4040404040404040"),
      keyDerivation,
    });
    const completed = await provider.completeBleSecurity({
      sessionId: started.sessionId,
      challengePayload: startedMaterial.challengePayload,
    });
    expect(completed).toEqual({
      authPayload: Array.from(startedMaterial.authPayload),
      shiftValue: startedMaterial.shiftValue,
      algorithmIndex: startedMaterial.algorithmIndex,
    });
  }
});

test("rejects malformed headers, proofs and unavailable Web Crypto explicitly", async () => {
  const provider = createBleSecurityProvider({
    productSecretsByProductId: { "7": [vector.productSecret] },
  });
  const mac = fromHex(vector.mac);

  const newer = await provider.beginBleSecurity({ productId: 7, mac });
  const newerChallenge = new Uint8Array(16);
  newerChallenge[0] = 2;
  await expect(provider.completeBleSecurity({
    sessionId: newer.sessionId,
    challengePayload: newerChallenge,
  })).rejects.toMatchObject({ code: "unsupported_security_version" });

  const flags = await provider.beginBleSecurity({ productId: 7, mac });
  const invalidFlags = new Uint8Array(16);
  invalidFlags[0] = 1;
  invalidFlags[1] = 1;
  await expect(provider.completeBleSecurity({
    sessionId: flags.sessionId,
    challengePayload: invalidFlags,
  })).rejects.toMatchObject({ code: "invalid_challenge" });

  const proof = await provider.beginBleSecurity({ productId: 7, mac });
  const invalidProof = new Uint8Array(16);
  invalidProof[0] = 1;
  invalidProof[15] = 1;
  await expect(provider.completeBleSecurity({
    sessionId: proof.sessionId,
    challengePayload: invalidProof,
  })).rejects.toMatchObject({ code: "device_proof_mismatch" });

  await expect(aes128Ecb(new Uint8Array(16), new Uint8Array(16), {} as Crypto)).rejects.toMatchObject({
    code: "security_error",
  });
  await expect(deriveV1Material({
    productSecret: "bad",
    mac,
    appNonce: new Uint8Array(8),
    deviceNonce: new Uint8Array(8),
  })).rejects.toMatchObject({ code: "invalid_product_secret_config" });
});

test("normalizes invalid maxSessions to a positive default and enforces the configured limit", async () => {
  const provider = createBleSecurityProvider({
    productSecretsByProductId: { "7": [vector.productSecret] },
    maxSessions: 1,
  });
  const first = await provider.beginBleSecurity({ productId: 7, mac: fromHex(vector.mac) });
  await expect(provider.beginBleSecurity({ productId: 7, mac: fromHex(vector.mac) })).rejects.toMatchObject({
    code: "session_limit",
  });
  await provider.clearBleSecurity(first.sessionId);

  const fallback = createBleSecurityProvider({
    productSecretsByProductId: { "7": [vector.productSecret] },
    maxSessions: 0,
  });
  const started = await fallback.beginBleSecurity({ productId: 7, mac: fromHex(vector.mac) });
  expect(started.sessionId).toHaveLength(32);
  await fallback.clearBleSecurity(started.sessionId);
});

test("in-flight completion cannot return auth material after clear revokes its session", async () => {
  const nativeCrypto = globalThis.crypto;
  let enteredResolve: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  let releaseResolve: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  let blockFirstEncrypt = true;
  const cryptoImpl = {
    getRandomValues(target: Uint8Array) {
      return nativeCrypto.getRandomValues(target);
    },
    subtle: {
      importKey(...args: Parameters<SubtleCrypto["importKey"]>) {
        return nativeCrypto.subtle.importKey(...args);
      },
      async encrypt(...args: Parameters<SubtleCrypto["encrypt"]>) {
        if (blockFirstEncrypt) {
          blockFirstEncrypt = false;
          enteredResolve?.();
          await release;
        }
        return nativeCrypto.subtle.encrypt(...args);
      },
    },
  } as unknown as Crypto;

  const provider = createBleSecurityProvider({
    productSecretsByProductId: { "7": [vector.productSecret] },
    cryptoImpl,
  });
  const started = await provider.beginBleSecurity({ productId: 7, mac: fromHex(vector.mac) });
  const challenge = new Uint8Array(16);
  challenge[0] = 1;
  const completing = provider.completeBleSecurity({
    sessionId: started.sessionId,
    challengePayload: challenge,
  });
  await entered;
  expect(await provider.clearBleSecurity(started.sessionId)).toEqual({ ok: true });
  releaseResolve?.();
  await expect(completing).rejects.toMatchObject({ code: "session_not_found" });
});
