/**
 * Build a small, signed Pocket update directory.
 *
 * The runtime still consumes one complete PAK.  We therefore do not invent a
 * new package format here: the PAK is described as the exact sequence of
 * content-addressed ranges that make up the original file.  A client can
 * download each range once, write it at `offset`, and verify `pak.sha256`.
 * The ranges are made at PAK blob boundaries (and at the intervening
 * metadata/padding boundaries), rather than at arbitrary fixed-size chunks.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const PAK_MAGIC = 0x4b504344;
const PAK_VERSION = 1;
const PAK_HEADER_SIZE = 32;
const PAK_ENTRY_SIZE = 24;
const PAK_ALIGN = 16;
const PAK_FNV1A_OFFSET_BASIS = 0x811c9dc5;
const PAK_FNV1A_PRIME = 0x01000193;
const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DOS_DATE_1980 = 0x0021;
const SEVEN_ZIP_MAGIC = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const MIN_HEAP_LIMIT_BYTES = 64 * 1024;
const MAX_HEAP_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_PAK_BYTES = 1;
const MAX_PAK_BYTES = 512 * 1024 * 1024;

export type ContentFile = {
  sha256: string;
  size: number;
  url: string;
};

export type BundleFormat = "7z" | "zip";

/** One-shot archive (`.7z` or `.zip`) containing all content-addressed blobs for initial package download. */
export type BundleDescriptor = {
  format: BundleFormat;
  sha256: string;
  size: number;
  url: string;
};

/** A named external asset. The bytes themselves are in the shared `files` list. */
export type AssetFile = {
  sha256: string;
  size: number;
};

export type PakPart = {
  offset: number;
  sha256: string;
  size: number;
  kind?: "blob" | "metadata";
  key?: string;
  dtype?: number;
};

export type PakBlob = {
  key: string;
  dtype: number;
  data: Uint8Array;
};

export type PocketMemoryBudget = {
  heapLimitBytes?: number;
  maxPakBytes?: number;
};

export type PocketUpdatePayload = {
  schemaVersion: 1;
  appId: string;
  version: string;
  build: number;
  protocol: number;
  minHostVersion: number;
  entry: { sha256: string; size: number };
  /** The signed entry interpretation; bytecode is never evaluated as source. */
  entryFormat: "javascript" | "quickjs-bytecode";
  /** Stable ABI identifier emitted by the pinned QuickJS compiler/host. */
  runtimeAbi?: string;
  worker?: Record<string, unknown>;
  pak: { sha256: string; size: number; parts: PakPart[] };
  files: ContentFile[];
  /** Optional one-shot ZIP bundle for initial full download of code and resources. */
  bundle?: BundleDescriptor;
  /** Present only when `--asset-dir` was supplied; omitted for compatibility. */
  assets?: Record<string, AssetFile>;
  /** Signed guest capability declaration; it is metadata, not executable code. */
  capabilities?: { requires: string[]; optional: string[] };
  permissions?: { requires: string[]; optional: string[] };
  /** Signed guest memory declaration; the host remains the final authority. */
  memory?: PocketMemoryBudget;
};

export type SignedManifest = {
  keyId: string;
  payload: string;
  signature: string;
};

/** Public-only key material suitable for Dart `cryptography` verification. */
export type PublicKeyConfig = {
  keyId: string;
  /** Ed25519 raw public key: exactly 32 bytes, standard Base64 encoded. */
  publicKeyBase64: string;
};

export type PakLayoutPart = PakPart & { kind: "blob" | "metadata"; key?: string; dtype?: number };

type PakRange = { offset: number; size: number; kind: "blob" | "metadata"; key?: string; dtype?: number };
type SigningKey = { keyId: string; privateKey: ReturnType<typeof createPrivateKey> };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc = (CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateZipEntryName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    hasControlChars(normalized) ||
    normalized.includes("://") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`zip: unsafe entry name: ${name}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.trim() !== segment)) {
    throw new Error(`zip: unsafe entry path: ${name}`);
  }
  if (encoder.encode(normalized).byteLength > 0xffff) {
    throw new Error(`zip: entry name exceeds 65535 bytes: ${name}`);
  }
  return normalized;
}

/** Create a deterministic PKZIP archive from a map of relative path -> file bytes. */
export function createZipArchive(entries: Record<string, Uint8Array> | Map<string, Uint8Array>): Uint8Array {
  const sourceEntries = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
  if (sourceEntries.length > 0xffff) {
    throw new Error(`zip: entry count ${sourceEntries.length} exceeds ZIP32 limit 65535`);
  }
  const sorted = sourceEntries
    .map(([name, data]) => ({ name: validateZipEntryName(name), data }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].name === sorted[i - 1].name) {
      throw new Error(`zip: duplicate entry ${sorted[i].name}`);
    }
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of sorted) {
    const nameBytes = encoder.encode(entry.name);
    if (nameBytes.byteLength > 0xffff) {
      throw new Error(`zip: entry name exceeds 65535 bytes: ${entry.name}`);
    }
    const uncompressed = entry.data;
    if (uncompressed.byteLength > 0xffffffff) {
      throw new Error(`zip: entry ${entry.name} exceeds ZIP32 size limit`);
    }
    const rawDeflated = uncompressed.byteLength > 0 ? new Uint8Array(deflateRawSync(asBuffer(uncompressed))) : uncompressed;
    const useDeflate = uncompressed.byteLength > 0 && rawDeflated.byteLength < uncompressed.byteLength;
    const method = useDeflate ? 8 : 0;
    const compressed = useDeflate ? rawDeflated : uncompressed;
    if (compressed.byteLength > 0xffffffff || localOffset > 0xffffffff) {
      throw new Error(`zip: archive exceeds ZIP32 offset or size limit`);
    }
    const checksum = crc32(uncompressed);

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIG, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, ZIP_UTF8_FLAG, true);
    localView.setUint16(8, method, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, ZIP_DOS_DATE_1980, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, uncompressed.byteLength, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, ZIP_CENTRAL_DIR_HEADER_SIG, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, ZIP_UTF8_FLAG, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, ZIP_DOS_DATE_1980, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, uncompressed.byteLength, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, compressed);
    centralParts.push(centralHeader);
    localOffset += localHeader.byteLength + compressed.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  if (centralSize > 0xffffffff || localOffset > 0xffffffff || localOffset + centralSize + 22 > 0xffffffff) {
    throw new Error("zip: archive exceeds ZIP32 size limit");
  }
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, ZIP_END_OF_CENTRAL_DIR_SIG, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, sorted.length, true);
  eocdView.setUint16(10, sorted.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, localOffset, true);
  eocdView.setUint16(20, 0, true);

  const out = new Uint8Array(localOffset + centralSize + eocd.byteLength);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

/** Extract and verify a PKZIP archive into a map of relative path -> file bytes. */
export function extractZipArchive(archive: Uint8Array, maxTotalBytes = 768 * 1024 * 1024): Map<string, Uint8Array> {
  if (archive.byteLength < 22) throw new Error("zip: archive is truncated");
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let eocdOffset = -1;
  const minSearch = Math.max(0, archive.byteLength - 22 - 0xffff);
  for (let offset = archive.byteLength - 22; offset >= minSearch; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIR_SIG) {
      const commentLen = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLen === archive.byteLength) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new Error("zip: missing end of central directory record");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  assertRange(centralOffset, centralSize, eocdOffset, "central directory");

  const extracted = new Map<string, Uint8Array>();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertRange(cursor, 46, centralOffset + centralSize, `central header ${index}`);
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_DIR_HEADER_SIG) {
      throw new Error(`zip: bad central directory header signature at ${cursor}`);
    }
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const headerTotal = 46 + nameLen + extraLen + commentLen;
    assertRange(cursor, headerTotal, centralOffset + centralSize, `central entry ${index}`);

    const rawName = decoder.decode(archive.subarray(cursor + 46, cursor + 46 + nameLen));
    const name = validateZipEntryName(rawName);
    if (extracted.has(name)) throw new Error(`zip: duplicate entry ${name}`);

    assertRange(localHeaderOffset, 30, centralOffset, `local header for ${name}`);
    if (view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_FILE_HEADER_SIG) {
      throw new Error(`zip: bad local file header signature for ${name}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
    assertRange(dataOffset, compressedSize, centralOffset, `compressed data for ${name}`);

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxTotalBytes) {
      throw new Error(`zip: uncompressed total exceeds limit ${maxTotalBytes}`);
    }

    const compressedBytes = archive.subarray(dataOffset, dataOffset + compressedSize);
    let uncompressedBytes: Uint8Array;
    if (method === 0) {
      if (compressedSize !== uncompressedSize) {
        throw new Error(`zip: stored entry ${name} size mismatch`);
      }
      uncompressedBytes = archive.slice(dataOffset, dataOffset + compressedSize);
    } else if (method === 8) {
      uncompressedBytes = new Uint8Array(
        inflateRawSync(asBuffer(compressedBytes), { maxOutputLength: Math.max(1, uncompressedSize) }),
      );
    } else {
      throw new Error(`zip: unsupported compression method ${method} for ${name}`);
    }

    if (uncompressedBytes.byteLength !== uncompressedSize) {
      throw new Error(`zip: uncompressed size mismatch for ${name}`);
    }
    if (crc32(uncompressedBytes) !== expectedCrc) {
      throw new Error(`zip: CRC-32 mismatch for ${name}`);
    }
    extracted.set(name, uncompressedBytes);
    cursor += headerTotal;
  }
  return extracted;
}

class LzmaBufferDecoder {
  private out: Uint8Array;
  private outPos = 0;
  private dictResetPos = 0;
  private lc = 3;
  private lp = 0;
  private pb = 2;
  private state = 0;
  private reps = [0, 0, 0, 0];
  private isMatch = new Uint16Array(192);
  private isRep = new Uint16Array(12);
  private isRepG0 = new Uint16Array(12);
  private isRepG1 = new Uint16Array(12);
  private isRepG2 = new Uint16Array(12);
  private isRep0Long = new Uint16Array(192);
  private posSlotDecoder = Array.from({ length: 4 }, () => new Uint16Array(64));
  private posDecoders = new Uint16Array(114);
  private alignDecoder = new Uint16Array(16);
  private litProbs = new Uint16Array(0x300);
  private lenChoice = 0x400;
  private lenChoice2 = 0x400;
  private lenLow = Array.from({ length: 16 }, () => new Uint16Array(8));
  private lenMid = Array.from({ length: 16 }, () => new Uint16Array(8));
  private lenHigh = new Uint16Array(256);
  private repLenChoice = 0x400;
  private repLenChoice2 = 0x400;
  private repLenLow = Array.from({ length: 16 }, () => new Uint16Array(8));
  private repLenMid = Array.from({ length: 16 }, () => new Uint16Array(8));
  private repLenHigh = new Uint16Array(256);
  private propsInitialized = false;

  constructor(expectedSize: number) {
    this.out = new Uint8Array(expectedSize);
  }

  resetDictionary(): void {
    this.dictResetPos = this.outPos;
  }

  resetProps(propByte: number): void {
    if (propByte >= 9 * 5 * 5) throw new Error("7z: invalid LZMA properties byte");
    this.lc = propByte % 9;
    const rem = (propByte / 9) | 0;
    this.lp = rem % 5;
    this.pb = (rem / 5) | 0;
    this.litProbs = new Uint16Array(0x300 << (this.lc + this.lp));
    this.propsInitialized = true;
  }

  resetState(): void {
    if (!this.propsInitialized) throw new Error("7z: LZMA properties not initialized");
    this.state = 0;
    this.reps[0] = 0;
    this.reps[1] = 0;
    this.reps[2] = 0;
    this.reps[3] = 0;
    this.isMatch.fill(0x400);
    this.isRep.fill(0x400);
    this.isRepG0.fill(0x400);
    this.isRepG1.fill(0x400);
    this.isRepG2.fill(0x400);
    this.isRep0Long.fill(0x400);
    for (const a of this.posSlotDecoder) a.fill(0x400);
    this.posDecoders.fill(0x400);
    this.alignDecoder.fill(0x400);
    this.litProbs.fill(0x400);
    this.lenChoice = 0x400;
    this.lenChoice2 = 0x400;
    for (const a of this.lenLow) a.fill(0x400);
    for (const a of this.lenMid) a.fill(0x400);
    this.lenHigh.fill(0x400);
    this.repLenChoice = 0x400;
    this.repLenChoice2 = 0x400;
    for (const a of this.repLenLow) a.fill(0x400);
    for (const a of this.repLenMid) a.fill(0x400);
    this.repLenHigh.fill(0x400);
  }

  copyUncompressed(src: Uint8Array, offset: number, len: number): void {
    if (offset < 0 || len < 0 || offset + len > src.byteLength) {
      throw new Error("7z: truncated LZMA2 uncompressed chunk");
    }
    if (this.outPos + len > this.out.byteLength) {
      throw new Error("7z: LZMA2 output exceeds declared unpack size");
    }
    this.out.set(src.subarray(offset, offset + len), this.outPos);
    this.outPos += len;
  }

  private getByte(dist: number): number {
    const avail = this.outPos - this.dictResetPos;
    if (dist <= 0 || dist > avail) {
      throw new Error("7z: corrupted LZMA back-reference distance");
    }
    return this.out[this.outPos - dist];
  }

  private putByte(b: number): void {
    if (this.outPos >= this.out.byteLength) {
      throw new Error("7z: LZMA output exceeds declared unpack size");
    }
    this.out[this.outPos++] = b & 0xff;
  }

  decodeChunk(inBuf: Uint8Array, unpackSize: number): void {
    if (!this.propsInitialized) throw new Error("7z: LZMA properties not initialized");
    if (inBuf.byteLength < 5 || inBuf[0] !== 0) {
      throw new Error("7z: corrupted or truncated LZMA stream");
    }
    if (this.outPos + unpackSize > this.out.byteLength) {
      throw new Error("7z: LZMA chunk exceeds declared unpack size");
    }
    let inPos = 0;
    let range = 0xffffffff;
    let code = 0;
    for (let i = 0; i < 5; i += 1) {
      code = ((code << 8) | inBuf[inPos++]) >>> 0;
    }
    const readByte = (): number => {
      if (inPos >= inBuf.byteLength) {
        throw new Error("7z: truncated LZMA input stream");
      }
      return inBuf[inPos++];
    };
    const normalize = (): void => {
      if (range < 0x01000000) {
        code = ((code << 8) | readByte()) >>> 0;
        range = (range << 8) >>> 0;
      }
    };
    const decodeBit = (probs: Uint16Array, idx: number): number => {
      normalize();
      const prob = probs[idx];
      const bound = ((range >>> 11) * prob) >>> 0;
      if (code < bound) {
        range = bound;
        probs[idx] = (prob + ((2048 - prob) >>> 5)) & 0xffff;
        return 0;
      }
      range = (range - bound) >>> 0;
      code = (code - bound) >>> 0;
      probs[idx] = (prob - (prob >>> 5)) & 0xffff;
      return 1;
    };
    const decodeBitScalar = (prob: number): [number, number] => {
      normalize();
      const bound = ((range >>> 11) * prob) >>> 0;
      let bit: number;
      let nextProb: number;
      if (code < bound) {
        range = bound;
        nextProb = (prob + ((2048 - prob) >>> 5)) & 0xffff;
        bit = 0;
      } else {
        range = (range - bound) >>> 0;
        code = (code - bound) >>> 0;
        nextProb = (prob - (prob >>> 5)) & 0xffff;
        bit = 1;
      }
      return [bit, nextProb];
    };
    const decodeBitTree = (probs: Uint16Array, numBits: number): number => {
      let m = 1;
      for (let i = 0; i < numBits; i += 1) m = (m << 1) | decodeBit(probs, m);
      return m - (1 << numBits);
    };
    const decodeReverseBitTree = (probs: Uint16Array, offset: number, numBits: number): number => {
      let m = 1;
      let symbol = 0;
      for (let i = 0; i < numBits; i += 1) {
        const bit = decodeBit(probs, offset + m);
        m = (m << 1) | bit;
        symbol |= bit << i;
      }
      return symbol;
    };
    const decodeDirectBits = (numBits: number): number => {
      let res = 0;
      for (let i = numBits; i > 0; i -= 1) {
        normalize();
        range >>>= 1;
        const t = (code - range) >>> 31;
        code = (code - (range & (t - 1))) >>> 0;
        res = (res << 1) | (1 - t);
      }
      return res;
    };
    const decodeLen = (isRepLen: boolean, posState: number): number => {
      let b: number;
      if (isRepLen) {
        [b, this.repLenChoice] = decodeBitScalar(this.repLenChoice);
        if (b === 0) return decodeBitTree(this.repLenLow[posState], 3);
        [b, this.repLenChoice2] = decodeBitScalar(this.repLenChoice2);
        if (b === 0) return 8 + decodeBitTree(this.repLenMid[posState], 3);
        return 16 + decodeBitTree(this.repLenHigh, 8);
      }
      [b, this.lenChoice] = decodeBitScalar(this.lenChoice);
      if (b === 0) return decodeBitTree(this.lenLow[posState], 3);
      [b, this.lenChoice2] = decodeBitScalar(this.lenChoice2);
      if (b === 0) return 8 + decodeBitTree(this.lenMid[posState], 3);
      return 16 + decodeBitTree(this.lenHigh, 8);
    };

    const posStateMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    let chunkWritten = 0;
    while (chunkWritten < unpackSize) {
      const totalPos = this.outPos - this.dictResetPos;
      const posState = totalPos & posStateMask;
      if (decodeBit(this.isMatch, (this.state << 4) + posState) === 0) {
        const prevByte = totalPos > 0 ? this.getByte(1) : 0;
        const litState = ((totalPos & lpMask) << this.lc) + (prevByte >>> (8 - this.lc));
        const probsOffset = 0x300 * litState;
        let symbol = 1;
        if (this.state >= 7) {
          let matchByte = this.getByte(this.reps[0] + 1);
          do {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const bit = decodeBit(this.litProbs, probsOffset + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) {
          symbol = (symbol << 1) | decodeBit(this.litProbs, probsOffset + symbol);
        }
        this.putByte(symbol & 0xff);
        chunkWritten += 1;
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
      } else {
        let len: number;
        if (decodeBit(this.isRep, this.state) === 1) {
          if (decodeBit(this.isRepG0, this.state) === 0) {
            if (decodeBit(this.isRep0Long, (this.state << 4) + posState) === 0) {
              this.state = this.state < 7 ? 9 : 11;
              this.putByte(this.getByte(this.reps[0] + 1));
              chunkWritten += 1;
              continue;
            }
          } else {
            let dist: number;
            if (decodeBit(this.isRepG1, this.state) === 0) {
              dist = this.reps[1];
            } else {
              if (decodeBit(this.isRepG2, this.state) === 0) dist = this.reps[2];
              else {
                dist = this.reps[3];
                this.reps[3] = this.reps[2];
              }
              this.reps[2] = this.reps[1];
            }
            this.reps[1] = this.reps[0];
            this.reps[0] = dist;
          }
          len = decodeLen(true, posState) + 2;
          this.state = this.state < 7 ? 8 : 11;
        } else {
          this.reps[3] = this.reps[2];
          this.reps[2] = this.reps[1];
          this.reps[1] = this.reps[0];
          len = decodeLen(false, posState) + 2;
          this.state = this.state < 7 ? 7 : 10;
          const posSlot = decodeBitTree(this.posSlotDecoder[len - 2 < 4 ? len - 2 : 3], 6);
          if (posSlot >= 4) {
            const numDirectBits = (posSlot >>> 1) - 1;
            let dist = (2 | (posSlot & 1)) << numDirectBits;
            if (posSlot < 14) {
              dist += decodeReverseBitTree(this.posDecoders, dist - posSlot - 1, numDirectBits);
            } else {
              dist += decodeDirectBits(numDirectBits - 4) << 4;
              dist += decodeReverseBitTree(this.alignDecoder, 0, 4);
            }
            this.reps[0] = dist;
          } else {
            this.reps[0] = posSlot;
          }
        }
        if (chunkWritten + len > unpackSize) {
          throw new Error("7z: LZMA match exceeds declared chunk unpack size");
        }
        for (let i = 0; i < len; i += 1) {
          this.putByte(this.getByte(this.reps[0] + 1));
          chunkWritten += 1;
        }
      }
    }
  }

  finish(): Uint8Array {
    if (this.outPos !== this.out.byteLength) {
      throw new Error(`7z: decoded ${this.outPos} bytes, expected ${this.out.byteLength}`);
    }
    return this.out;
  }
}

function decodeLzma1Stream(props: Uint8Array, inBuf: Uint8Array, expectedSize: number): Uint8Array {
  if (props.byteLength < 5) throw new Error("7z: LZMA1 coder properties too short");
  if (expectedSize === 0) return new Uint8Array(0);
  const decoder = new LzmaBufferDecoder(expectedSize);
  decoder.resetProps(props[0]);
  decoder.resetState();
  decoder.decodeChunk(inBuf, expectedSize);
  return decoder.finish();
}

function decodeLzma2Stream(props: Uint8Array, inBuf: Uint8Array, expectedSize: number): Uint8Array {
  if (props.byteLength < 1) throw new Error("7z: LZMA2 coder properties missing");
  if ((props[0] & 0x3f) > 40) throw new Error("7z: invalid LZMA2 dictionary size property");
  const decoder = new LzmaBufferDecoder(expectedSize);
  let pos = 0;
  let sawEnd = false;
  while (pos < inBuf.byteLength) {
    const control = inBuf[pos++];
    if (control === 0x00) {
      sawEnd = true;
      break;
    }
    if (control === 0x01 || control === 0x02) {
      if (pos + 2 > inBuf.byteLength) throw new Error("7z: truncated LZMA2 uncompressed chunk header");
      const unpackSize = ((inBuf[pos] << 8) | inBuf[pos + 1]) + 1;
      pos += 2;
      if (control === 0x01) decoder.resetDictionary();
      decoder.copyUncompressed(inBuf, pos, unpackSize);
      pos += unpackSize;
    } else if (control >= 0x80) {
      if (pos + 4 > inBuf.byteLength) throw new Error("7z: truncated LZMA2 compressed chunk header");
      const unpackSize = (((control & 0x1f) << 16) | (inBuf[pos] << 8) | inBuf[pos + 1]) + 1;
      const packSize = ((inBuf[pos + 2] << 8) | inBuf[pos + 3]) + 1;
      pos += 4;
      const mode = (control >>> 5) & 3;
      if (mode >= 2) {
        if (pos >= inBuf.byteLength) throw new Error("7z: missing LZMA2 property byte");
        const propByte = inBuf[pos++];
        if (mode === 3) decoder.resetDictionary();
        decoder.resetProps(propByte);
        decoder.resetState();
      } else if (mode === 1) {
        decoder.resetState();
      }
      if (pos + packSize > inBuf.byteLength) throw new Error("7z: truncated LZMA2 compressed chunk data");
      decoder.decodeChunk(inBuf.subarray(pos, pos + packSize), unpackSize);
      pos += packSize;
    } else {
      throw new Error(`7z: invalid LZMA2 control byte 0x${control.toString(16)}`);
    }
  }
  if (!sawEnd && expectedSize > 0) {
    throw new Error("7z: LZMA2 stream missing end marker");
  }
  return decoder.finish();
}

function write7zU64(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`7z: invalid uint64 value ${value}`);
  }
  const v = BigInt(value);
  let mask = 0x80;
  let firstByte = 0;
  for (let i = 0; i < 8; i += 1) {
    if (v < (1n << BigInt(7 * (i + 1)))) {
      firstByte |= Number((v >> BigInt(8 * i)) & BigInt(mask - 1));
      const out = [firstByte];
      for (let j = 0; j < i; j += 1) {
        out.push(Number((v >> BigInt(8 * j)) & 0xffn));
      }
      return out;
    }
    firstByte |= mask;
    mask >>= 1;
  }
  const out = [0xff];
  for (let j = 0; j < 8; j += 1) {
    out.push(Number((v >> BigInt(8 * j)) & 0xffn));
  }
  return out;
}

function encodeLzma2Uncompressed(data: Uint8Array): Uint8Array {
  if (data.byteLength === 0) return new Uint8Array([0x00]);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let first = true;
  while (offset < data.byteLength) {
    const chunkLen = Math.min(0x10000, data.byteLength - offset);
    const header = new Uint8Array(3);
    header[0] = first ? 0x01 : 0x02;
    first = false;
    header[1] = ((chunkLen - 1) >>> 8) & 0xff;
    header[2] = (chunkLen - 1) & 0xff;
    chunks.push(header, data.subarray(offset, offset + chunkLen));
    offset += chunkLen;
  }
  chunks.push(new Uint8Array([0x00]));
  const total = chunks.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of chunks) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  return out;
}

function write7zBitVector(bits: boolean[]): number[] {
  const bytes: number[] = [];
  let cur = 0;
  let mask = 0x80;
  for (const bit of bits) {
    if (bit) cur |= mask;
    mask >>>= 1;
    if (mask === 0) {
      bytes.push(cur);
      cur = 0;
      mask = 0x80;
    }
  }
  if (mask !== 0x80) bytes.push(cur);
  return bytes;
}

function createBuiltin7zArchive(sorted: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const nonEmpty = sorted.filter((entry) => entry.data.byteLength > 0);
  const totalUnpackSize = nonEmpty.reduce((sum, entry) => sum + entry.data.byteLength, 0);
  const rawPayload = new Uint8Array(totalUnpackSize);
  let rawCursor = 0;
  for (const entry of nonEmpty) {
    rawPayload.set(entry.data, rawCursor);
    rawCursor += entry.data.byteLength;
  }
  const packedPayload = nonEmpty.length > 0 ? encodeLzma2Uncompressed(rawPayload) : new Uint8Array(0);
  const header: number[] = [0x01]; // kHeader

  if (nonEmpty.length > 0) {
    header.push(
      0x04, // kMainStreamsInfo
      0x06, // kPackInfo
      ...write7zU64(0),
      ...write7zU64(1),
      0x09, // kSize
      ...write7zU64(packedPayload.byteLength),
      0x00, // kEnd PackInfo
      0x07, // kUnPackInfo
      0x0b, // kFolder
      ...write7zU64(1),
      0x00, // external = 0
      ...write7zU64(1), // 1 coder
      0x21, // flags: idSize=1, hasAttrs=true
      0x21, // codec ID: LZMA2
      ...write7zU64(1), // props size = 1
      0x18, // 4 MiB dictionary prop
      0x0c, // kCodersUnPackSize
      ...write7zU64(totalUnpackSize),
    );
    if (nonEmpty.length === 1) {
      const c = crc32(nonEmpty[0].data);
      header.push(0x0a, 0x01, c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
    }
    header.push(0x00); // kEnd UnPackInfo
    if (nonEmpty.length > 1) {
      header.push(0x08, 0x0d, ...write7zU64(nonEmpty.length), 0x09);
      for (let i = 0; i < nonEmpty.length - 1; i += 1) {
        header.push(...write7zU64(nonEmpty[i].data.byteLength));
      }
      header.push(0x0a, 0x01);
      for (const entry of nonEmpty) {
        const c = crc32(entry.data);
        header.push(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
      }
      header.push(0x00); // kEnd SubStreamsInfo
    }
    header.push(0x00); // kEnd MainStreamsInfo
  }

  header.push(0x05, ...write7zU64(sorted.length)); // kFilesInfo
  const emptyFlags = sorted.map((entry) => entry.data.byteLength === 0);
  const emptyCount = emptyFlags.filter(Boolean).length;
  if (emptyCount > 0) {
    const emptyStreamVec = write7zBitVector(emptyFlags);
    header.push(0x0e, ...write7zU64(emptyStreamVec.length), ...emptyStreamVec);
    const emptyFileVec = write7zBitVector(new Array(emptyCount).fill(true));
    header.push(0x0f, ...write7zU64(emptyFileVec.length), ...emptyFileVec);
  }
  if (sorted.length > 0) {
    const nameProp: number[] = [0x00]; // external = 0
    for (const entry of sorted) {
      for (let i = 0; i < entry.name.length; i += 1) {
        const code = entry.name.charCodeAt(i);
        nameProp.push(code & 0xff, (code >>> 8) & 0xff);
      }
      nameProp.push(0x00, 0x00);
    }
    header.push(0x11, ...write7zU64(nameProp.length), ...nameProp);
  }
  header.push(0x00, 0x00); // kEnd FilesInfo, kEnd Header

  const headerBytes = new Uint8Array(header);
  const out = new Uint8Array(32 + packedPayload.byteLength + headerBytes.byteLength);
  out.set(SEVEN_ZIP_MAGIC, 0);
  out[6] = 0x00;
  out[7] = 0x04;
  const view = new DataView(out.buffer);
  view.setBigUint64(12, BigInt(packedPayload.byteLength), true);
  view.setBigUint64(20, BigInt(headerBytes.byteLength), true);
  view.setUint32(28, crc32(headerBytes), true);
  view.setUint32(8, crc32(out.subarray(12, 32)), true);
  out.set(packedPayload, 32);
  out.set(headerBytes, 32 + packedPayload.byteLength);
  return out;
}

let cached7zBinary: string | null | undefined;

function resolve7zBinary(): string | null {
  if (cached7zBinary !== undefined) return cached7zBinary;
  const candidates = [
    Bun.which("7zz"),
    Bun.which("7z"),
    Bun.which("7za"),
    existsSync("/opt/homebrew/bin/7zz") ? "/opt/homebrew/bin/7zz" : null,
    existsSync("/opt/homebrew/bin/7z") ? "/opt/homebrew/bin/7z" : null,
    existsSync("/usr/local/bin/7zz") ? "/usr/local/bin/7zz" : null,
    existsSync("/usr/local/bin/7z") ? "/usr/local/bin/7z" : null,
  ];
  cached7zBinary = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0) ?? null;
  return cached7zBinary;
}

/**
 * Create a deterministic `.7z` (LZMA2) archive from a map of relative path -> file bytes.
 * Uses the host `7zz`/`7z` CLI with deterministic flags when available, or falls back to
 * the built-in deterministic LZMA2 `.7z` encoder.
 */
export function create7zArchive(
  entries: Record<string, Uint8Array> | Map<string, Uint8Array>,
  options?: { useCli?: boolean },
): Uint8Array {
  const sourceEntries = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
  if (sourceEntries.length > 0xffff) {
    throw new Error(`7z: entry count ${sourceEntries.length} exceeds limit 65535`);
  }
  const sorted = sourceEntries
    .map(([name, data]) => ({ name: validateZipEntryName(name), data }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].name === sorted[i - 1].name) {
      throw new Error(`7z: duplicate entry ${sorted[i].name}`);
    }
  }

  const cliBin = options?.useCli === false ? null : resolve7zBinary();
  if (cliBin && sorted.length > 0) {
    const tempDir = mkdtempSync(join(tmpdir(), "pocket-7z-build-"));
    try {
      const stageDir = join(tempDir, "stage");
      mkdirSync(stageDir, { recursive: true });
      for (const entry of sorted) {
        const dest = join(stageDir, entry.name);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, asBuffer(entry.data));
      }
      const listFile = join(tempDir, "files.list");
      writeFileSync(listFile, sorted.map((entry) => entry.name).join("\n") + "\n", "utf8");
      const archivePath = join(tempDir, "bundle.7z");
      const proc = Bun.spawnSync(
        [
          cliBin,
          "a",
          "-t7z",
          "-m0=lzma2",
          "-mf=off",
          "-ms=on",
          "-mhc=on",
          "-mtm=off",
          "-mtc=off",
          "-mta=off",
          "-mtr=off",
          "-scsUTF-8",
          archivePath,
          `@${listFile}`,
        ],
        { cwd: stageDir, stdout: "pipe", stderr: "pipe" },
      );
      if (proc.exitCode === 0 && existsSync(archivePath)) {
        return new Uint8Array(readFileSync(archivePath));
      }
    } catch {
      // Fall back to built-in deterministic 7z encoder.
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  return createBuiltin7zArchive(sorted);
}

class SevenZipHeaderReader {
  pos = 0;

  constructor(readonly buf: Uint8Array) {}

  readByte(): number {
    if (this.pos >= this.buf.byteLength) throw new Error("7z: unexpected EOF in header");
    return this.buf[this.pos++];
  }

  readBytes(len: number): Uint8Array {
    if (!Number.isSafeInteger(len) || len < 0 || this.pos + len > this.buf.byteLength) {
      throw new Error("7z: unexpected EOF in header slice");
    }
    const sub = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return sub;
  }

  readU32(): number {
    if (this.pos + 4 > this.buf.byteLength) throw new Error("7z: unexpected EOF reading uint32");
    const v =
      (this.buf[this.pos] |
        (this.buf[this.pos + 1] << 8) |
        (this.buf[this.pos + 2] << 16) |
        (this.buf[this.pos + 3] << 24)) >>>
      0;
    this.pos += 4;
    return v;
  }

  readU64(): number {
    const b0 = this.readByte();
    let mask = 0x80;
    let extra = 0;
    for (let i = 0; i < 8; i += 1) {
      if ((b0 & mask) === 0) {
        extra = i;
        break;
      }
      mask >>>= 1;
      if (i === 7) extra = 8;
    }
    let val = 0n;
    for (let i = 0; i < extra; i += 1) {
      val |= BigInt(this.readByte()) << BigInt(8 * i);
    }
    if (extra < 8) {
      const high = BigInt(b0 & (mask - 1));
      val |= high << BigInt(8 * extra);
    }
    if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("7z: uint64 exceeds safe integer range");
    }
    return Number(val);
  }

  readBitVector(count: number): boolean[] {
    if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff) {
      throw new Error(`7z: bit vector count ${count} exceeds limit 65535`);
    }
    const byteCount = Math.ceil(count / 8);
    if (this.pos + byteCount > this.buf.byteLength) {
      throw new Error("7z: unexpected EOF in bit vector");
    }
    const bits: boolean[] = [];
    let mask = 0;
    let cur = 0;
    for (let i = 0; i < count; i += 1) {
      if (mask === 0) {
        cur = this.readByte();
        mask = 0x80;
      }
      bits.push((cur & mask) !== 0);
      mask >>>= 1;
    }
    return bits;
  }

  readAllOrBits(count: number): boolean[] {
    if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff) {
      throw new Error(`7z: digest count ${count} exceeds limit 65535`);
    }
    const allDefined = this.readByte();
    if (allDefined !== 0) return new Array(count).fill(true);
    return this.readBitVector(count);
  }

  readDigests(count: number): Array<number | undefined> {
    const defined = this.readAllOrBits(count);
    const definedCount = defined.filter(Boolean).length;
    if (this.pos + definedCount * 4 > this.buf.byteLength) {
      throw new Error("7z: unexpected EOF in CRC digest vector");
    }
    return defined.map((isDef) => (isDef ? this.readU32() : undefined));
  }
}

type SevenZipCoder = {
  codecId: Uint8Array;
  props: Uint8Array;
  numInStreams: number;
  numOutStreams: number;
};

type SevenZipFolder = {
  coders: SevenZipCoder[];
  packedStreamIndices: number[];
  unpackSizes: number[];
  unpackSize: number;
  crc?: number;
};

type SevenZipStreamsInfo = {
  packPos: number;
  packSizes: number[];
  packCrcs: Array<number | undefined>;
  folders: SevenZipFolder[];
  subStreamSizes: number[][];
  subStreamCrcs: Array<Array<number | undefined>>;
};

function parse7zStreamsInfo(r: SevenZipHeaderReader, firstId?: number): SevenZipStreamsInfo {
  let id = firstId ?? r.readByte();
  let packPos = 0;
  let packSizes: number[] = [];
  let packCrcs: Array<number | undefined> = [];
  if (id === 0x06) {
    packPos = r.readU64();
    const numPackStreams = r.readU64();
    if (numPackStreams > 0xffff) {
      throw new Error(`7z: pack stream count ${numPackStreams} exceeds limit 65535`);
    }
    packCrcs = new Array(numPackStreams).fill(undefined);
    id = r.readByte();
    while (id !== 0x00) {
      if (id === 0x09) {
        packSizes = [];
        for (let i = 0; i < numPackStreams; i += 1) packSizes.push(r.readU64());
      } else if (id === 0x0a) {
        packCrcs = r.readDigests(numPackStreams);
      } else {
        const skip = r.readU64();
        r.readBytes(skip);
      }
      id = r.readByte();
    }
    id = r.readByte();
  }

  const folders: SevenZipFolder[] = [];
  if (id === 0x07) {
    id = r.readByte();
    if (id !== 0x0b) throw new Error(`7z: expected kFolder (0x0b), got 0x${id.toString(16)}`);
    const numFolders = r.readU64();
    if (numFolders > 0xffff) {
      throw new Error(`7z: folder count ${numFolders} exceeds limit 65535`);
    }
    const external = r.readByte();
    if (external !== 0) throw new Error("7z: external folders are not supported");
    for (let f = 0; f < numFolders; f += 1) {
      const numCoders = r.readU64();
      if (numCoders < 1 || numCoders > 64) {
        throw new Error(`7z: invalid coder count ${numCoders}`);
      }
      const coders: SevenZipCoder[] = [];
      let totalIn = 0;
      let totalOut = 0;
      for (let c = 0; c < numCoders; c += 1) {
        const flags = r.readByte();
        const idSize = flags & 0x0f;
        const isComplex = (flags & 0x10) !== 0;
        const hasAttrs = (flags & 0x20) !== 0;
        const codecId = r.readBytes(idSize);
        const numInStreams = isComplex ? r.readU64() : 1;
        const numOutStreams = isComplex ? r.readU64() : 1;
        if (numInStreams < 1 || numInStreams > 64 || numOutStreams < 1 || numOutStreams > 64) {
          throw new Error("7z: invalid coder stream count");
        }
        const props = hasAttrs ? r.readBytes(r.readU64()) : new Uint8Array(0);
        coders.push({ codecId, props, numInStreams, numOutStreams });
        totalIn += numInStreams;
        totalOut += numOutStreams;
      }
      const numBindPairs = totalOut - 1;
      const boundIn = new Set<number>();
      for (let b = 0; b < numBindPairs; b += 1) {
        boundIn.add(r.readU64());
        r.readU64();
      }
      const numPackedStreams = totalIn - numBindPairs;
      const packedStreamIndices: number[] = [];
      if (numPackedStreams === 1) {
        for (let i = 0; i < totalIn; i += 1) {
          if (!boundIn.has(i)) {
            packedStreamIndices.push(i);
            break;
          }
        }
      } else {
        for (let i = 0; i < numPackedStreams; i += 1) packedStreamIndices.push(r.readU64());
      }
      folders.push({ coders, packedStreamIndices, unpackSizes: [], unpackSize: 0 });
    }
    id = r.readByte();
    if (id !== 0x0c) throw new Error(`7z: expected kCodersUnPackSize (0x0c), got 0x${id.toString(16)}`);
    for (const folder of folders) {
      const totalOut = folder.coders.reduce((sum, c) => sum + c.numOutStreams, 0);
      for (let i = 0; i < totalOut; i += 1) folder.unpackSizes.push(r.readU64());
      folder.unpackSize = folder.unpackSizes[folder.unpackSizes.length - 1] ?? 0;
    }
    id = r.readByte();
    if (id === 0x0a) {
      const crcs = r.readDigests(folders.length);
      for (let i = 0; i < folders.length; i += 1) folders[i].crc = crcs[i];
      id = r.readByte();
    }
    if (id !== 0x00) throw new Error(`7z: expected kEnd of UnPackInfo, got 0x${id.toString(16)}`);
    id = r.readByte();
  }

  const numUnPackStreams = folders.map(() => 1);
  const subStreamSizes = folders.map((f) => [f.unpackSize]);
  const subStreamCrcs: Array<Array<number | undefined>> = folders.map((f) => [f.crc]);
  if (id === 0x08) {
    let sawSubStreamCrcs = false;
    id = r.readByte();
    while (id !== 0x00) {
      if (id === 0x0d) {
        let totalSubStreams = 0;
        for (let i = 0; i < folders.length; i += 1) {
          const count = r.readU64();
          if (count > 0xffff) throw new Error(`7z: substream count ${count} exceeds limit 65535`);
          totalSubStreams += count;
          if (totalSubStreams > 0xffff) throw new Error("7z: total substreams exceed limit 65535");
          numUnPackStreams[i] = count;
        }
      } else if (id === 0x09) {
        for (let i = 0; i < folders.length; i += 1) {
          const count = numUnPackStreams[i];
          if (count === 0) {
            subStreamSizes[i] = [];
            continue;
          }
          const sizes: number[] = [];
          let sum = 0;
          for (let j = 0; j < count - 1; j += 1) {
            const s = r.readU64();
            sizes.push(s);
            sum += s;
          }
          if (sum > folders[i].unpackSize) throw new Error("7z: substream sizes exceed folder unpack size");
          sizes.push(folders[i].unpackSize - sum);
          subStreamSizes[i] = sizes;
        }
      } else if (id === 0x0a) {
        sawSubStreamCrcs = true;
        let unknownCrcs = 0;
        for (let i = 0; i < folders.length; i += 1) {
          const count = numUnPackStreams[i];
          if (!(count === 1 && folders[i].crc !== undefined)) unknownCrcs += count;
        }
        const digests = r.readDigests(unknownCrcs);
        let dIdx = 0;
        for (let i = 0; i < folders.length; i += 1) {
          const count = numUnPackStreams[i];
          if (count === 1 && folders[i].crc !== undefined) {
            subStreamCrcs[i] = [folders[i].crc];
          } else {
            const list: Array<number | undefined> = [];
            for (let j = 0; j < count; j += 1) list.push(digests[dIdx++]);
            subStreamCrcs[i] = list;
          }
        }
      } else {
        const skip = r.readU64();
        r.readBytes(skip);
      }
      id = r.readByte();
    }
    for (let i = 0; i < folders.length; i += 1) {
      if (numUnPackStreams[i] === 1 && subStreamSizes[i].length !== 1) {
        subStreamSizes[i] = [folders[i].unpackSize];
      }
      if (!sawSubStreamCrcs) {
        subStreamCrcs[i] =
          numUnPackStreams[i] === 1 ? [folders[i].crc] : new Array(numUnPackStreams[i]).fill(undefined);
      }
    }
    id = r.readByte();
  }
  if (id !== 0x00) throw new Error(`7z: expected kEnd of StreamsInfo, got 0x${id.toString(16)}`);
  return { packPos, packSizes, packCrcs, folders, subStreamSizes, subStreamCrcs };
}

function decode7zFolder(
  archive: Uint8Array,
  streams: SevenZipStreamsInfo,
  folderIdx: number,
  packStreamOffset: number,
  packSize: number,
  maxAllowedBytes: number,
): Uint8Array {
  const folder = streams.folders[folderIdx];
  if (folder.unpackSize > maxAllowedBytes) {
    throw new Error(`7z: uncompressed total exceeds limit ${maxAllowedBytes}`);
  }
  const dataStart = 32 + streams.packPos + packStreamOffset;
  if (dataStart < 32 || packSize < 0 || dataStart + packSize > archive.byteLength) {
    throw new Error("7z: packed stream out of bounds");
  }
  if (folder.coders.length !== 1) {
    throw new Error(`7z: multi-coder filter chains (${folder.coders.length}) are not supported`);
  }
  const coder = folder.coders[0];
  const packed = archive.subarray(dataStart, dataStart + packSize);
  const expectedPackCrc = streams.packCrcs[folderIdx];
  if (expectedPackCrc !== undefined && crc32(packed) !== expectedPackCrc) {
    throw new Error("7z: packed stream CRC-32 mismatch");
  }
  let unpacked: Uint8Array;
  if (coder.codecId.byteLength === 1 && coder.codecId[0] === 0x00) {
    if (packed.byteLength !== folder.unpackSize) {
      throw new Error("7z: Copy coder size mismatch");
    }
    unpacked = archive.slice(dataStart, dataStart + packSize);
  } else if (coder.codecId.byteLength === 1 && coder.codecId[0] === 0x21) {
    unpacked = decodeLzma2Stream(coder.props, packed, folder.unpackSize);
  } else if (
    coder.codecId.byteLength === 3 &&
    coder.codecId[0] === 0x03 &&
    coder.codecId[1] === 0x01 &&
    coder.codecId[2] === 0x01
  ) {
    unpacked = decodeLzma1Stream(coder.props, packed, folder.unpackSize);
  } else if (
    coder.codecId.byteLength === 3 &&
    coder.codecId[0] === 0x04 &&
    coder.codecId[1] === 0x01 &&
    coder.codecId[2] === 0x08
  ) {
    unpacked = new Uint8Array(
      inflateRawSync(asBuffer(packed), { maxOutputLength: Math.max(1, folder.unpackSize) }),
    );
    if (unpacked.byteLength !== folder.unpackSize) {
      throw new Error("7z: Deflate coder size mismatch");
    }
  } else {
    throw new Error(`7z: unsupported coder [${[...coder.codecId].map((b) => b.toString(16)).join(" ")}]`);
  }
  if (folder.crc !== undefined && crc32(unpacked) !== folder.crc) {
    throw new Error("7z: folder CRC-32 mismatch");
  }
  return unpacked;
}

/** Extract and verify a `.7z` archive into a map of relative path -> file bytes. */
export function extract7zArchive(archive: Uint8Array, maxTotalBytes = 768 * 1024 * 1024): Map<string, Uint8Array> {
  if (archive.byteLength < 32) throw new Error("7z: archive is truncated");
  for (let i = 0; i < SEVEN_ZIP_MAGIC.byteLength; i += 1) {
    if (archive[i] !== SEVEN_ZIP_MAGIC[i]) throw new Error("7z: bad signature magic");
  }
  if (archive[6] !== 0) {
    throw new Error(`7z: unsupported major version ${archive[6]}`);
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const startHeaderCrc = view.getUint32(8, true);
  if (crc32(archive.subarray(12, 32)) !== startHeaderCrc) {
    throw new Error("7z: StartHeader CRC-32 mismatch");
  }
  const nextHeaderOffsetBig = view.getBigUint64(12, true);
  const nextHeaderSizeBig = view.getBigUint64(20, true);
  const nextHeaderCrc = view.getUint32(28, true);
  if (nextHeaderOffsetBig > BigInt(archive.byteLength) || nextHeaderSizeBig > BigInt(archive.byteLength)) {
    throw new Error("7z: NextHeader offset or size out of bounds");
  }
  const nextHeaderOffset = Number(nextHeaderOffsetBig);
  const nextHeaderSize = Number(nextHeaderSizeBig);
  const nextHeaderStart = 32 + nextHeaderOffset;
  if (nextHeaderStart < 32 || nextHeaderSize < 0 || nextHeaderStart + nextHeaderSize > archive.byteLength) {
    throw new Error("7z: NextHeader range out of bounds");
  }
  let headerSlice = archive.subarray(nextHeaderStart, nextHeaderStart + nextHeaderSize);
  if (crc32(headerSlice) !== nextHeaderCrc) {
    throw new Error("7z: NextHeader CRC-32 mismatch");
  }

  let hr = new SevenZipHeaderReader(headerSlice);
  let headerId = hr.readByte();
  if (headerId === 0x17) {
    // kEncodedHeader: decompress the header stream first.
    const encInfo = parse7zStreamsInfo(hr);
    if (encInfo.folders.length !== 1 || encInfo.packSizes.length < 1) {
      throw new Error("7z: unsupported multi-folder EncodedHeader");
    }
    headerSlice = decode7zFolder(
      archive,
      encInfo,
      0,
      0,
      encInfo.packSizes[0],
      Math.min(maxTotalBytes, 16 * 1024 * 1024),
    );
    hr = new SevenZipHeaderReader(headerSlice);
    headerId = hr.readByte();
  }
  if (headerId !== 0x01) {
    throw new Error(`7z: expected kHeader (0x01), got 0x${headerId.toString(16)}`);
  }

  let sectionId = hr.readByte();
  if (sectionId === 0x02) {
    // kArchiveProperties
    let propId = hr.readByte();
    while (propId !== 0x00) {
      hr.readBytes(hr.readU64());
      propId = hr.readByte();
    }
    sectionId = hr.readByte();
  }
  if (sectionId === 0x03) {
    throw new Error("7z: AdditionalStreamsInfo is not supported");
  }

  let mainStreams: SevenZipStreamsInfo | null = null;
  if (sectionId === 0x04) {
    mainStreams = parse7zStreamsInfo(hr);
    sectionId = hr.readByte();
  }

  const extracted = new Map<string, Uint8Array>();
  if (sectionId === 0x00) {
    return extracted;
  }
  if (sectionId !== 0x05) {
    throw new Error(`7z: expected kFilesInfo (0x05), got 0x${sectionId.toString(16)}`);
  }

  const numFiles = hr.readU64();
  if (numFiles > 0xffff) {
    throw new Error(`7z: file count ${numFiles} exceeds limit 65535`);
  }
  let emptyStreams: boolean[] = new Array(numFiles).fill(false);
  let emptyFiles: boolean[] | null = null;
  let antiFiles: boolean[] | null = null;
  const names: string[] = new Array(numFiles).fill("");
  let fileCrcs: Array<number | undefined> = new Array(numFiles).fill(undefined);

  let propType = hr.readByte();
  while (propType !== 0x00) {
    const propSize = hr.readU64();
    const endPos = hr.pos + propSize;
    if (endPos > hr.buf.byteLength) throw new Error("7z: FilesInfo property exceeds header");
    if (propType === 0x0e) {
      emptyStreams = hr.readBitVector(numFiles);
    } else if (propType === 0x0f) {
      const emptyCount = emptyStreams.filter(Boolean).length;
      emptyFiles = hr.readBitVector(emptyCount);
    } else if (propType === 0x10) {
      const emptyCount = emptyStreams.filter(Boolean).length;
      antiFiles = hr.readBitVector(emptyCount);
    } else if (propType === 0x11) {
      const external = hr.readByte();
      if (external !== 0) throw new Error("7z: external file names are not supported");
      for (let i = 0; i < numFiles; i += 1) {
        const chars: number[] = [];
        while (hr.pos + 2 <= endPos) {
          const code = hr.buf[hr.pos] | (hr.buf[hr.pos + 1] << 8);
          hr.pos += 2;
          if (code === 0) break;
          chars.push(code);
        }
        names[i] = String.fromCharCode(...chars);
      }
    } else if (propType === 0x0a) {
      fileCrcs = hr.readDigests(numFiles);
    }
    hr.pos = endPos;
    propType = hr.readByte();
  }

  let totalUncompressed = 0;
  const unpackedSubStreams: Array<{ data: Uint8Array; crc?: number }> = [];
  if (mainStreams) {
    let packOffset = 0;
    for (let f = 0; f < mainStreams.folders.length; f += 1) {
      const packSize = mainStreams.packSizes[f] ?? 0;
      const folderBytes = decode7zFolder(
        archive,
        mainStreams,
        f,
        packOffset,
        packSize,
        maxTotalBytes - totalUncompressed,
      );
      totalUncompressed += folderBytes.byteLength;
      packOffset += packSize;
      const sizes = mainStreams.subStreamSizes[f];
      const crcs = mainStreams.subStreamCrcs[f];
      let subCursor = 0;
      for (let s = 0; s < sizes.length; s += 1) {
        const size = sizes[s];
        if (subCursor + size > folderBytes.byteLength) {
          throw new Error("7z: substream exceeds decoded folder size");
        }
        unpackedSubStreams.push({
          data: folderBytes.subarray(subCursor, subCursor + size),
          crc: crcs[s],
        });
        subCursor += size;
      }
    }
  }

  let emptyIdx = 0;
  let streamIdx = 0;
  for (let i = 0; i < numFiles; i += 1) {
    if (emptyStreams[i]) {
      const isAnti = antiFiles ? antiFiles[emptyIdx] : false;
      const isEmptyFile = emptyFiles ? emptyFiles[emptyIdx] : false;
      emptyIdx += 1;
      if (isAnti) throw new Error("7z: anti-files are not supported");
      if (!isEmptyFile) {
        // Directory entry in 7z archive; skip.
        continue;
      }
      const name = validateZipEntryName(names[i]);
      if (extracted.has(name)) throw new Error(`7z: duplicate entry ${name}`);
      extracted.set(name, new Uint8Array(0));
    } else {
      if (streamIdx >= unpackedSubStreams.length) {
        throw new Error("7z: missing substream for non-empty file");
      }
      const name = validateZipEntryName(names[i]);
      if (extracted.has(name)) throw new Error(`7z: duplicate entry ${name}`);
      const sub = unpackedSubStreams[streamIdx++];
      const expectedCrc = fileCrcs[i] ?? sub.crc;
      if (expectedCrc !== undefined && crc32(sub.data) !== expectedCrc) {
        throw new Error(`7z: CRC-32 mismatch for ${name}`);
      }
      extracted.set(name, new Uint8Array(sub.data));
    }
  }
  return extracted;
}

/** Extract and verify either a `.7z` or `.zip` bundle archive. */
export function extractBundleArchive(
  archive: Uint8Array,
  maxTotalBytes = 768 * 1024 * 1024,
  format?: BundleFormat,
): Map<string, Uint8Array> {
  const is7z =
    archive.byteLength >= 6 &&
    archive[0] === 0x37 &&
    archive[1] === 0x7a &&
    archive[2] === 0xbc &&
    archive[3] === 0xaf &&
    archive[4] === 0x27 &&
    archive[5] === 0x1c;
  if (format === "7z" || (format === undefined && is7z)) {
    return extract7zArchive(archive, maxTotalBytes);
  }
  if (format === "zip" || format === undefined) {
    return extractZipArchive(archive, maxTotalBytes);
  }
  throw new Error(`bundle: unsupported archive format ${format}`);
}

function fnv1a(text: string): number {
  let hash = PAK_FNV1A_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, PAK_FNV1A_PRIME);
  }
  return hash >>> 0;
}

const alignPak = (n: number): number => (n + (PAK_ALIGN - 1)) & ~(PAK_ALIGN - 1);

/** Unpack a PocketJS `.pak` binary into its constituent named `PakBlob` entries. */
export function unpackPak(file: Uint8Array): PakBlob[] {
  parsePakLayout(file);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const entryCount = readU32(view, 8);
  const dirOffset = readU32(view, 12);
  const namesOffset = readU32(view, 16);
  const blobs: PakBlob[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = dirOffset + index * PAK_ENTRY_SIZE;
    const blobOffset = readU32(view, entryOffset + 4);
    const blobSize = readU32(view, entryOffset + 8);
    const nameOffset = readU32(view, entryOffset + 12);
    const nameSize = readU16(view, entryOffset + 16);
    const key = decoder.decode(file.subarray(namesOffset + nameOffset, namesOffset + nameOffset + nameSize));
    blobs.push({
      key,
      dtype: file[entryOffset + 18],
      data: file.slice(blobOffset, blobOffset + blobSize),
    });
  }
  return blobs;
}

function validatePakKey(key: string): Uint8Array {
  if (!key || key.trim().length === 0 || key.trim() !== key || hasControlChars(key)) {
    throw new Error(`pak: invalid key "${key}"`);
  }
  const encoded = encoder.encode(key);
  if (encoded.byteLength === 0 || encoded.byteLength > 0xffff) {
    throw new Error(`pak: key "${key.slice(0, 32)}" UTF-8 length ${encoded.byteLength} exceeds 1..65535`);
  }
  return encoded;
}

/** Pack named `PakBlob` entries back into a deterministic PocketJS `.pak` binary. */
export function packPak(blobsIn: PakBlob[]): Uint8Array {
  const blobs = [...blobsIn].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  const names: Uint8Array[] = [];
  for (const blob of blobs) {
    const encodedName = validatePakKey(blob.key);
    if (seen.has(blob.key)) throw new Error(`pak: invalid or duplicate key ${blob.key}`);
    if (blob.data.byteLength <= 0) throw new Error(`pak: entry ${blob.key} must not be empty`);
    if (!Number.isInteger(blob.dtype) || blob.dtype < 0 || blob.dtype > 0xff) {
      throw new Error(`pak: invalid dtype ${blob.dtype} for ${blob.key}`);
    }
    seen.add(blob.key);
    names.push(encodedName);
  }
  const dirOffset = PAK_HEADER_SIZE;
  const namesOffset = dirOffset + blobs.length * PAK_ENTRY_SIZE;
  let nameCursor = 0;
  const nameOffsets = names.map((name) => {
    const offset = nameCursor;
    nameCursor += name.byteLength;
    return offset;
  });
  const blobsOffset = alignPak(namesOffset + nameCursor);
  let blobCursor = blobsOffset;
  const blobOffsets = blobs.map((blob) => {
    const offset = blobCursor;
    blobCursor += alignPak(blob.data.byteLength);
    return offset;
  });

  const out = new Uint8Array(blobCursor);
  const view = new DataView(out.buffer);
  view.setUint32(0, PAK_MAGIC, true);
  view.setUint16(4, PAK_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, blobs.length, true);
  view.setUint32(12, dirOffset, true);
  view.setUint32(16, namesOffset, true);
  view.setUint32(20, blobsOffset, true);
  view.setUint32(24, out.byteLength, true);
  view.setUint32(28, 0, true);

  for (let index = 0; index < blobs.length; index += 1) {
    const entryOffset = dirOffset + index * PAK_ENTRY_SIZE;
    view.setUint32(entryOffset + 0, fnv1a(blobs[index].key), true);
    view.setUint32(entryOffset + 4, blobOffsets[index], true);
    view.setUint32(entryOffset + 8, blobs[index].data.byteLength, true);
    view.setUint32(entryOffset + 12, nameOffsets[index], true);
    view.setUint16(entryOffset + 16, names[index].byteLength, true);
    out[entryOffset + 18] = blobs[index].dtype & 0xff;
    out[entryOffset + 19] = 0;
    view.setUint32(entryOffset + 20, 0, true);
    out.set(names[index], namesOffset + nameOffsets[index]);
    out.set(blobs[index].data, blobOffsets[index]);
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ed25519RawPublicKey(publicKey: ReturnType<typeof createPublicKey>): Buffer {
  const der = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error("signing key: unexpected Ed25519 SubjectPublicKeyInfo encoding");
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function assertRange(offset: number, size: number, fileSize: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > fileSize) {
    throw new Error(`pak: ${label} range ${offset}+${size} is outside ${fileSize} bytes`);
  }
}

/**
 * Return the exact ranges that need to be published for a PAK.
 *
 * A resource range is only the entry's declared `byteLen`; alignment bytes
 * remain metadata ranges.  This is important when one image changes: another
 * image's bytes retain their content hash even if directory offsets move.
 */
export function parsePakLayout(file: Uint8Array): PakLayoutPart[] {
  if (file.byteLength < PAK_HEADER_SIZE) throw new Error("pak: truncated header");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (readU32(view, 0) !== PAK_MAGIC) throw new Error("pak: bad magic");
  if (readU16(view, 4) !== PAK_VERSION) throw new Error("pak: unsupported version");

  const entryCount = readU32(view, 8);
  const directoryOffset = readU32(view, 12);
  const namesOffset = readU32(view, 16);
  const blobsOffset = readU32(view, 20);
  const declaredSize = readU32(view, 24);
  if (declaredSize !== file.byteLength) {
    throw new Error(`pak: header fileSize ${declaredSize} does not match ${file.byteLength}`);
  }
  if (directoryOffset < PAK_HEADER_SIZE || directoryOffset > file.byteLength) {
    throw new Error(`pak: invalid directory offset ${directoryOffset}`);
  }
  assertRange(directoryOffset, entryCount * PAK_ENTRY_SIZE, file.byteLength, "directory");
  const directoryEnd = directoryOffset + entryCount * PAK_ENTRY_SIZE;
  if (namesOffset < directoryEnd || namesOffset > file.byteLength) throw new Error(`pak: invalid names offset ${namesOffset}`);
  if (blobsOffset < namesOffset || blobsOffset > file.byteLength) throw new Error(`pak: invalid blobs offset ${blobsOffset}`);

  const ranges: PakRange[] = [];
  const seenKeys = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + index * PAK_ENTRY_SIZE;
    const blobOffset = readU32(view, entryOffset + 4);
    const blobSize = readU32(view, entryOffset + 8);
    const nameOffset = readU32(view, entryOffset + 12);
    const nameSize = readU16(view, entryOffset + 16);
    const dtype = file[entryOffset + 18];
    assertRange(namesOffset + nameOffset, nameSize, file.byteLength, `entry ${index} name`);
    if (namesOffset + nameOffset + nameSize > blobsOffset) throw new Error(`pak: entry ${index} name overlaps blob area`);
    if (blobOffset < blobsOffset) throw new Error(`pak: entry ${index} blob starts before blob area`);
    assertRange(blobOffset, blobSize, file.byteLength, `entry ${index} blob`);
    if (nameSize === 0) throw new Error(`pak: entry ${index} has empty key`);
    const key = decoder.decode(file.subarray(namesOffset + nameOffset, namesOffset + nameOffset + nameSize));
    validatePakKey(key);
    if (seenKeys.has(key)) throw new Error(`pak: duplicate entry key ${key}`);
    seenKeys.add(key);
    if (blobSize <= 0) throw new Error(`pak: entry ${index} (${key}) must not be empty`);
    ranges.push({ offset: blobOffset, size: blobSize, kind: "blob", key, dtype });
  }

  // Entries in a valid pack do not overlap or alias each other. Keeping this check
  // explicit prevents an invalid pack from losing key identity or causing ambiguous reconstruction.
  ranges.sort((a, b) => a.offset - b.offset || a.size - b.size);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.offset < previous.offset + previous.size) {
      throw new Error(`pak: overlapping or aliased blob ranges at ${previous.offset} and ${current.offset}`);
    }
  }

  const parts: PakLayoutPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.offset > cursor) parts.push({ offset: cursor, size: range.offset - cursor, sha256: "", kind: "metadata" });
    if (range.offset < cursor) throw new Error("pak: non-monotonic blob range");
    parts.push({
      offset: range.offset,
      size: range.size,
      sha256: "",
      kind: "blob",
      ...(range.key === undefined ? {} : { key: range.key }),
      ...(range.dtype === undefined ? {} : { dtype: range.dtype }),
    });
    cursor = range.offset + range.size;
  }
  if (cursor < file.byteLength) parts.push({ offset: cursor, size: file.byteLength - cursor, sha256: "", kind: "metadata" });
  if (parts.length === 0 && file.byteLength > 0) parts.push({ offset: 0, size: file.byteLength, sha256: "", kind: "metadata" });
  return parts;
}

function loadPrivateKey(path: string): SigningKey {
  const source = readFileSync(path);
  let keyId: string | undefined;
  let privateKeyInput: string | Buffer = source;
  try {
    const parsed = JSON.parse(source.toString("utf8")) as { keyId?: unknown; privateKeyPem?: unknown; privateKey?: unknown };
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.keyId === "string") keyId = parsed.keyId;
      const pem = typeof parsed.privateKeyPem === "string" ? parsed.privateKeyPem : parsed.privateKey;
      if (typeof pem === "string") privateKeyInput = pem;
    }
  } catch {
    // A raw PEM is also accepted for local tooling.
  }
  const privateKey = createPrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  if (!keyId) {
    const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
    keyId = `dev-${sha256Hex(new Uint8Array(publicDer)).slice(0, 16)}`;
  }
  return { keyId, privateKey };
}

export function signPayload(payloadBytes: Uint8Array, key: SigningKey): SignedManifest {
  return {
    keyId: key.keyId,
    payload: asBuffer(payloadBytes).toString("base64"),
    signature: sign(null, asBuffer(payloadBytes), key.privateKey).toString("base64"),
  };
}

export function verifySignedManifest(envelope: SignedManifest, publicKey: string | Buffer): Uint8Array {
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  if (!verify(null, payload, createPublicKey(publicKey), signature)) throw new Error("manifest: invalid Ed25519 signature");
  return new Uint8Array(payload);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeBlob(outDir: string, bytes: Uint8Array): { sha256: string; size: number; url: string } {
  const sha256 = sha256Hex(bytes);
  const blobDir = join(outDir, "blobs");
  ensureDir(blobDir);
  const filePath = join(blobDir, sha256);
  if (!existsSync(filePath)) writeFileSync(filePath, asBuffer(bytes));
  else {
    const existing = new Uint8Array(readFileSync(filePath));
    if (existing.byteLength !== bytes.byteLength || sha256Hex(existing) !== sha256) {
      writeFileSync(filePath, asBuffer(bytes));
    }
  }
  return { sha256, size: bytes.byteLength, url: `blobs/${sha256}` };
}

function stableFiles(files: Map<string, ContentFile>): ContentFile[] {
  return [...files.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

function normalizeAssetPrefix(prefix: string): string {
  const raw = prefix.replaceAll("\\", "/");
  if (raw.startsWith("/") || hasControlChars(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`package: asset-prefix must be a safe relative path: ${prefix}`);
  }
  const normalized = raw.replace(/\/+$/g, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.trim() !== segment)) {
    throw new Error(`package: asset-prefix must be a safe relative path: ${prefix}`);
  }
  return normalized;
}

function safeAssetName(rootDir: string, filePath: string, prefix: string | undefined): string {
  const rawRelative = relative(rootDir, filePath);
  const normalized = rawRelative.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    hasControlChars(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.trim() !== segment)
  ) {
    throw new Error(`package: asset path is not safe: ${rawRelative}`);
  }
  return prefix ? `${prefix}/${normalized}` : normalized;
}

function assertNoRemoteNativeCode(filePath: string): void {
  const lower = filePath.toLowerCase();
  const forbidden = [".so", ".dylib", ".dll", ".framework", ".aar", ".apk", ".ipa", ".exe", ".node"];
  if (forbidden.some((suffix) => lower.endsWith(suffix))) {
    throw new Error(`package: remote native code is not allowed in assets: ${filePath}`);
  }
}

function collectAssets(
  assetDir: string,
  assetPrefix: string | undefined,
  add: (bytes: Uint8Array) => ContentFile,
): Record<string, AssetFile> {
  const rootDir = resolve(assetDir);
  const rootStat = lstatSync(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`package: asset-dir must be a real directory: ${assetDir}`);
  }

  const files: Array<{ path: string; name: string }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`package: asset directory contains unsupported symlink: ${path}`);
      }
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        assertNoRemoteNativeCode(path);
        files.push({ path, name: safeAssetName(rootDir, path, assetPrefix) });
      }
    }
  };
  walk(rootDir);
  files.sort((left, right) => left.name.localeCompare(right.name));

  const assets: Record<string, AssetFile> = Object.create(null) as Record<string, AssetFile>;
  for (const file of files) {
    if (Object.prototype.hasOwnProperty.call(assets, file.name)) {
      throw new Error(`package: duplicate asset path: ${file.name}`);
    }
    const content = add(new Uint8Array(readFileSync(file.path)));
    assets[file.name] = { sha256: content.sha256, size: content.size };
  }
  return assets;
}

type GuestManifest = {
  worker?: Record<string, unknown>;
  capabilities?: { requires: string[]; optional: string[] };
  permissions?: { requires: string[]; optional: string[] };
  memory?: PocketMemoryBudget;
};

function readGuestManifest(filePath: string): GuestManifest {
  const value = JSON.parse(readFileSync(resolve(filePath), "utf8")) as Record<string, unknown>;
  const readNames = (value: unknown, field: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(item))) {
      throw new Error(`package: ${field} must contain safe dotted names`);
    }
    return [...new Set(value as string[])].sort();
  };
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`package: ${field} must be an object`);
    return value as Record<string, unknown>;
  };
  const nestedGuest = value.guest && typeof value.guest === "object" && !Array.isArray(value.guest)
    ? value.guest as Record<string, unknown>
    : undefined;
  const capabilitiesValue = value.capabilities ?? nestedGuest?.capabilities;
  const permissionsValue = value.permissions ?? nestedGuest?.permissions;
  const readGroup = (value: unknown, field: string): { requires: string[]; optional: string[] } | undefined => {
    if (value === undefined) return undefined;
    const group = object(value, field);
    const requires = readNames(group.requires ?? group.required, `${field}.requires`);
    const optional = readNames(group.optional, `${field}.optional`).filter((name) => !requires.includes(name));
    return { requires, optional };
  };
  const readMemory = (value: unknown, field: string): PocketMemoryBudget | undefined => {
    if (value === undefined) return undefined;
    const memory = object(value, field);
    const unknown = Object.keys(memory).filter((key) => key !== "heapLimitBytes" && key !== "maxPakBytes");
    if (unknown.length > 0) throw new Error(`package: ${field} has unknown field ${unknown[0]}`);
    const readLimit = (key: "heapLimitBytes" | "maxPakBytes", minimum: number, maximum: number): number | undefined => {
      if (!Object.prototype.hasOwnProperty.call(memory, key)) return undefined;
      const limit = memory[key];
      if (!Number.isSafeInteger(limit) || (limit as number) < minimum || (limit as number) > maximum) {
        throw new Error(`package: ${field}.${key} must be a safe integer from ${minimum} through ${maximum}`);
      }
      return limit as number;
    };
    const heapLimitBytes = readLimit("heapLimitBytes", MIN_HEAP_LIMIT_BYTES, MAX_HEAP_LIMIT_BYTES);
    const maxPakBytes = readLimit("maxPakBytes", MIN_PAK_BYTES, MAX_PAK_BYTES);
    return {
      ...(heapLimitBytes === undefined ? {} : { heapLimitBytes }),
      ...(maxPakBytes === undefined ? {} : { maxPakBytes }),
    };
  };
  const memoryValue = Object.prototype.hasOwnProperty.call(value, "memory")
    ? value.memory
    : nestedGuest?.memory;
  return {
    capabilities: readGroup(capabilitiesValue, "capabilities"),
    permissions: readGroup(permissionsValue, "permissions"),
    memory: readMemory(memoryValue, "memory"),
    ...(value.worker === undefined ? {} : { worker: object(value.worker, "worker") }),
  };
}

export type PackageOptions = {
  appId: string;
  version: string;
  build: number;
  /** UTF-8 JavaScript entry for legacy/source packages. */
  jsPath?: string;
  /** Real QuickJS bytecode entry produced by the pinned compiler. */
  bytecodePath?: string;
  entryFormat?: "javascript" | "quickjs-bytecode";
  runtimeAbi?: string;
  pakPath: string;
  outDir: string;
  keyFile: string;
  /** Optional directory of ordinary files published outside the PAK. */
  assetDir?: string;
  /** Optional safe relative prefix for names in [assetDir]. */
  assetPrefix?: string;
  protocol?: number;
  minHostVersion?: number;
  /** Optional JSON file containing signed capabilities/permissions. */
  guestManifestPath?: string;
  /** Whether to emit a one-shot bundle archive for initial download (defaults to true). */
  includeBundle?: boolean;
  /** Archive format for one-shot bundle download (`"7z"` default, or `"zip"`). */
  bundleFormat?: BundleFormat;
};

export type PatchPackageOptions = {
  /** Directory containing an already-published Pocket update (`payload.json` + `blobs/*`). */
  baseDir: string;
  /** Output directory for the patched version (may be the same as `baseDir` or a new directory). */
  outDir: string;
  version: string;
  build: number;
  keyFile: string;
  /** Optional code update: UTF-8 JavaScript entry. */
  jsPath?: string;
  /** Optional code update: QuickJS bytecode entry. */
  bytecodePath?: string;
  entryFormat?: "javascript" | "quickjs-bytecode";
  runtimeAbi?: string;
  /** Optional replacement of individual named entries inside `app.pak` (key -> file path or bytes). */
  replacePakEntries?: Record<string, string | Uint8Array | { data: string | Uint8Array; dtype?: number }>;
  /** Optional replacement/addition of individual external loose assets (asset name -> file path or bytes). */
  replaceAssets?: Record<string, string | Uint8Array>;
  /** Optional removal of external loose assets by name. */
  removeAssets?: string[];
  /** Optional updated guest manifest path. */
  guestManifestPath?: string;
  /** Whether to emit a one-shot bundle archive for initial download (defaults to true). */
  includeBundle?: boolean;
  /** Archive format for one-shot bundle download (`"7z"` default, or `"zip"`). */
  bundleFormat?: BundleFormat;
};

export type PackageResult = {
  payload: PocketUpdatePayload;
  envelope: SignedManifest;
  payloadBytes: Uint8Array;
  manifestPath: string;
  bundlePath?: string;
  pakParts: PakLayoutPart[];
};

function writeBundleZip(
  outDir: string,
  files: ContentFile[],
  format: BundleFormat = "7z",
): { descriptor: BundleDescriptor; bundlePath: string } {
  if (format !== "7z" && format !== "zip") {
    throw new Error(`package: unsupported bundle format ${format}`);
  }
  const entries = new Map<string, Uint8Array>();
  for (const file of files) {
    const blobPath = join(outDir, file.url);
    const bytes = new Uint8Array(readFileSync(blobPath));
    if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
      throw new Error(`package: blob ${file.sha256} failed verification before bundling`);
    }
    entries.set(file.url, bytes);
  }
  const archiveBytes = format === "7z" ? create7zArchive(entries) : createZipArchive(entries);
  const archiveSha256 = sha256Hex(archiveBytes);
  const bundlesDir = join(outDir, "bundles");
  ensureDir(bundlesDir);
  const immutableRelUrl = `bundles/bundle-${archiveSha256}.${format}`;
  const immutablePath = join(outDir, immutableRelUrl);
  writeFileSync(immutablePath, asBuffer(archiveBytes));
  writeFileSync(join(outDir, `bundle.${format}`), asBuffer(archiveBytes));
  return {
    descriptor: {
      format,
      sha256: archiveSha256,
      size: archiveBytes.byteLength,
      url: immutableRelUrl,
    },
    bundlePath: immutablePath,
  };
}

function validateLogicalAssetName(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    hasControlChars(normalized) ||
    normalized.includes("://") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`package: asset path is not safe: ${name}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.trim() !== segment)) {
    throw new Error(`package: asset path is not safe: ${name}`);
  }
  assertNoRemoteNativeCode(normalized);
  return normalized;
}

/** Build payload.json, signed-manifest.json, latest.json, bundle.zip and content blobs. */
export function packageArtifacts(options: PackageOptions): PackageResult {
  if (!options.appId || !options.version) throw new Error("package: app-id and version are required");
  if (!Number.isSafeInteger(options.build) || options.build < 0) throw new Error("package: build must be a non-negative integer");
  const entryFormat = options.entryFormat ?? (options.bytecodePath ? "quickjs-bytecode" : "javascript");
  const entryPath = entryFormat === "quickjs-bytecode" ? options.bytecodePath : options.jsPath;
  if (!entryPath) throw new Error(`package: ${entryFormat === "quickjs-bytecode" ? "--bytecode" : "--js"} is required`);
  if (entryFormat === "quickjs-bytecode" && !options.runtimeAbi?.trim()) {
    throw new Error("package: --runtime-abi is required for quickjs-bytecode");
  }
  if (entryFormat === "javascript" && options.bytecodePath) {
    throw new Error("package: --bytecode requires --entry-format quickjs-bytecode");
  }
  if (options.assetPrefix !== undefined && options.assetDir === undefined) {
    throw new Error("package: asset-prefix requires asset-dir");
  }
  const assetPrefix = options.assetPrefix === undefined ? undefined : normalizeAssetPrefix(options.assetPrefix);
  const entry = new Uint8Array(readFileSync(entryPath));
  const pak = new Uint8Array(readFileSync(options.pakPath));
  const outDir = resolve(options.outDir);
  ensureDir(outDir);
  const files = new Map<string, ContentFile>();
  const add = (bytes: Uint8Array): ContentFile => {
    const file = writeBlob(outDir, bytes);
    files.set(file.sha256, file);
    return file;
  };

  const entryFile = add(entry);
  const layout = parsePakLayout(pak);
  const parts: PakPart[] = layout.map((part) => {
    const file = add(pak.subarray(part.offset, part.offset + part.size));
    return {
      offset: part.offset,
      sha256: file.sha256,
      size: part.size,
      kind: part.kind,
      ...(part.key === undefined ? {} : { key: part.key }),
      ...(part.dtype === undefined ? {} : { dtype: part.dtype }),
    };
  });
  let assets = options.assetDir === undefined ? undefined : collectAssets(options.assetDir, assetPrefix, add);
  const guest = options.guestManifestPath === undefined
    ? undefined
    : readGuestManifest(options.guestManifestPath);
  const metadataPath = join(dirname(resolve(entryPath)), "app.bytecode.json");
  const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown> : undefined;
  const rawWorker = guest?.worker ?? metadata?.worker;
  let worker: Record<string, unknown> | undefined;
  if (rawWorker !== undefined) {
    if (!rawWorker || typeof rawWorker !== "object" || Array.isArray(rawWorker)) throw new Error("package: worker descriptor must be an object");
    const descriptor = rawWorker as Record<string, unknown>;
    const artifact = descriptor.bytecode as Record<string, unknown> | undefined;
    const path = artifact?.path;
    if (descriptor.kind !== "quickjs-bytecode" || descriptor.protocolVersion !== 1 || descriptor.runtimeAbi !== options.runtimeAbi ||
        typeof path !== "string" || path.includes("\\") || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..")) {
      throw new Error("package: invalid worker bytecode descriptor/ABI/path");
    }
    const declared = new Set([...(guest?.capabilities?.requires ?? []), ...(guest?.capabilities?.optional ?? [])]);
    if (!declared.has("runtime.worker") || !Array.isArray(descriptor.requiredCaps) || descriptor.requiredCaps.some(c => typeof c !== "string" || !declared.has(c))) {
      throw new Error("package: worker capabilities must be declared in signed guest manifest");
    }
    const bytes = new Uint8Array(readFileSync(join(dirname(resolve(entryPath)), path)));
    if (bytes.byteLength !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256 || bytes.byteLength <= 124 ||
        Buffer.from(bytes.subarray(0, 4)).toString() !== "PJBC") throw new Error("package: worker bytecode integrity mismatch");
    const content = add(bytes);
    const name = assetPrefix ? `${assetPrefix}/${path}` : path;
    assets ??= Object.create(null) as Record<string, AssetFile>;
    if (assets[name] && (assets[name].sha256 !== content.sha256 || assets[name].size !== content.size)) throw new Error("package: conflicting worker asset");
    assets[name] = {sha256: content.sha256, size: content.size};
    worker = {...descriptor, bytecode: {...artifact, path: name}};
  } else if (guest?.capabilities?.requires.includes("runtime.worker") || existsSync(join(dirname(resolve(entryPath)), "app.worker.qjbc"))) {
    throw new Error("package: refusing to publish a worker package without its signed descriptor");
  }
  const orderedFiles = stableFiles(files);
  const bundleResult = options.includeBundle === false
    ? undefined
    : writeBundleZip(outDir, orderedFiles, options.bundleFormat ?? "7z");
  const payload: PocketUpdatePayload = {
    schemaVersion: 1,
    appId: options.appId,
    version: options.version,
    build: options.build,
    protocol: options.protocol ?? 1,
    minHostVersion: options.minHostVersion ?? 1,
    entry: { sha256: entryFile.sha256, size: entryFile.size },
    entryFormat,
    ...(options.runtimeAbi === undefined ? {} : { runtimeAbi: options.runtimeAbi }),
    pak: { sha256: sha256Hex(pak), size: pak.byteLength, parts },
    files: orderedFiles,
    ...(bundleResult === undefined ? {} : { bundle: bundleResult.descriptor }),
    ...(assets === undefined ? {} : { assets }),
    ...(worker === undefined ? {} : { worker }),
    ...(guest?.capabilities === undefined ? {} : { capabilities: guest.capabilities }),
    ...(guest?.permissions === undefined ? {} : { permissions: guest.permissions }),
    ...(guest?.memory === undefined ? {} : { memory: guest.memory }),
  };
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const envelope = signPayload(payloadBytes, loadPrivateKey(options.keyFile));
  const payloadPath = join(outDir, "payload.json");
  const manifestPath = join(outDir, "signed-manifest.json");
  writeFileSync(payloadPath, asBuffer(payloadBytes));
  const envelopeBytes = encoder.encode(JSON.stringify(envelope));
  writeFileSync(manifestPath, asBuffer(envelopeBytes));
  // A same-envelope latest file makes the directory immediately usable by a
  // host that polls /latest.json, without adding an unsigned redirect layer.
  writeFileSync(join(outDir, "latest.json"), asBuffer(envelopeBytes));
  return {
    payload,
    envelope,
    payloadBytes,
    manifestPath,
    ...(bundleResult === undefined ? {} : { bundlePath: bundleResult.bundlePath }),
    pakParts: layout.map((part, index) => ({ ...part, sha256: parts[index].sha256 })),
  };
}

function readBytesOrFile(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(readFileSync(resolve(input)));
}

function reconstructBasePak(baseDir: string, payload: PocketUpdatePayload): Uint8Array {
  const pak = new Uint8Array(payload.pak.size);
  for (const part of payload.pak.parts) {
    const blobPath = join(baseDir, "blobs", part.sha256);
    const bytes = new Uint8Array(readFileSync(blobPath));
    if (bytes.byteLength !== part.size || sha256Hex(bytes) !== part.sha256) {
      throw new Error(`patch: base PAK part ${part.sha256} is missing or corrupted`);
    }
    pak.set(bytes, part.offset);
  }
  if (sha256Hex(pak) !== payload.pak.sha256) {
    throw new Error("patch: reconstructed base PAK hash does not match base payload");
  }
  return pak;
}

/**
 * Produce a new signed version by patching only code (`jsPath` / `bytecodePath`)
 * and/or specific resource files (`replacePakEntries` / `replaceAssets`) on top
 * of an already-published Pocket package directory. Unchanged blobs retain their
 * exact SHA-256 and are reused without re-downloading on installed clients.
 */
export function patchPackageArtifacts(options: PatchPackageOptions): PackageResult {
  if (!options.version) throw new Error("patch: version is required");
  if (!Number.isSafeInteger(options.build) || options.build < 0) throw new Error("patch: build must be a non-negative integer");
  const baseDir = resolve(options.baseDir);
  const outDir = resolve(options.outDir);
  ensureDir(outDir);

  const payloadFile = join(baseDir, "payload.json");
  const basePayload = (existsSync(payloadFile)
    ? JSON.parse(readFileSync(payloadFile, "utf8"))
    : JSON.parse(Buffer.from((JSON.parse(readFileSync(join(baseDir, "signed-manifest.json"), "utf8")) as SignedManifest).payload, "base64").toString("utf8"))
  ) as PocketUpdatePayload;

  if (options.build <= basePayload.build) {
    throw new Error(`patch: build ${options.build} must be greater than base build ${basePayload.build}`);
  }

  const hasCodeChange = options.jsPath !== undefined || options.bytecodePath !== undefined;
  const pakReplacements = options.replacePakEntries ? Object.entries(options.replacePakEntries) : [];
  const assetReplacements = options.replaceAssets ? Object.entries(options.replaceAssets) : [];
  const assetRemovals = options.removeAssets ?? [];
  if (!hasCodeChange && pakReplacements.length === 0 && assetReplacements.length === 0 && assetRemovals.length === 0 && !options.guestManifestPath) {
    throw new Error("patch: at least one code or resource update is required");
  }

  const files = new Map<string, ContentFile>();
  const add = (bytes: Uint8Array): ContentFile => {
    const file = writeBlob(outDir, bytes);
    files.set(file.sha256, file);
    return file;
  };
  const copyBaseBlob = (sha256: string, expectedSize: number): ContentFile => {
    const srcPath = join(baseDir, "blobs", sha256);
    const bytes = new Uint8Array(readFileSync(srcPath));
    if (bytes.byteLength !== expectedSize || sha256Hex(bytes) !== sha256) {
      throw new Error(`patch: base blob ${sha256} is missing or corrupted`);
    }
    const blobDir = join(outDir, "blobs");
    ensureDir(blobDir);
    const dstPath = join(blobDir, sha256);
    if (!existsSync(dstPath)) {
      copyFileSync(srcPath, dstPath);
    }
    const file: ContentFile = { sha256, size: expectedSize, url: `blobs/${sha256}` };
    files.set(sha256, file);
    return file;
  };

  const entryFormat = options.entryFormat ?? (options.bytecodePath ? "quickjs-bytecode" : options.jsPath ? "javascript" : basePayload.entryFormat);
  const runtimeAbi = options.runtimeAbi ?? basePayload.runtimeAbi;
  if (entryFormat === "quickjs-bytecode" && !runtimeAbi?.trim()) {
    throw new Error("patch: --runtime-abi is required for quickjs-bytecode");
  }
  if (entryFormat === "javascript" && options.bytecodePath) {
    throw new Error("patch: --bytecode requires --entry-format quickjs-bytecode");
  }

  let entryFile: ContentFile;
  if (hasCodeChange) {
    const entryPath = entryFormat === "quickjs-bytecode" ? options.bytecodePath : options.jsPath;
    if (!entryPath) throw new Error(`patch: ${entryFormat === "quickjs-bytecode" ? "--bytecode" : "--js"} is required`);
    entryFile = add(new Uint8Array(readFileSync(resolve(entryPath))));
  } else {
    entryFile = copyBaseBlob(basePayload.entry.sha256, basePayload.entry.size);
  }

  let pakSha256 = basePayload.pak.sha256;
  let pakSize = basePayload.pak.size;
  let parts: PakPart[];
  let pakParts: PakLayoutPart[];
  if (pakReplacements.length > 0) {
    const basePak = reconstructBasePak(baseDir, basePayload);
    const blobs = unpackPak(basePak);
    const byKey = new Map<string, PakBlob>(blobs.map((blob) => [blob.key, blob]));
    for (const [key, spec] of pakReplacements) {
      if (!key.trim()) throw new Error("patch: PAK entry key must not be empty");
      const existing = byKey.get(key);
      const isObjectSpec = typeof spec === "object" && !(spec instanceof Uint8Array) && spec !== null && "data" in spec;
      const data = readBytesOrFile(isObjectSpec ? spec.data : spec as string | Uint8Array);
      const dtype = isObjectSpec && spec.dtype !== undefined ? spec.dtype : (existing?.dtype ?? 0);
      byKey.set(key, { key, dtype, data });
    }
    const nextPak = packPak([...byKey.values()]);
    const layout = parsePakLayout(nextPak);
    parts = layout.map((part) => {
      const file = add(nextPak.subarray(part.offset, part.offset + part.size));
      return {
        offset: part.offset,
        sha256: file.sha256,
        size: part.size,
        kind: part.kind,
        ...(part.key === undefined ? {} : { key: part.key }),
        ...(part.dtype === undefined ? {} : { dtype: part.dtype }),
      };
    });
    pakParts = layout.map((part, index) => ({ ...part, sha256: parts[index].sha256 }));
    pakSha256 = sha256Hex(nextPak);
    pakSize = nextPak.byteLength;
  } else {
    parts = basePayload.pak.parts.map((part) => {
      copyBaseBlob(part.sha256, part.size);
      return { ...part };
    });
    pakParts = parts.map((part) => ({
      ...part,
      kind: part.kind ?? "metadata",
    }));
  }

  const guest = options.guestManifestPath === undefined
    ? undefined
    : readGuestManifest(options.guestManifestPath);
  const entryDir = options.bytecodePath ? dirname(resolve(options.bytecodePath)) : undefined;
  const metadataPath = entryDir ? join(entryDir, "app.bytecode.json") : undefined;
  const metadata = metadataPath && existsSync(metadataPath)
    ? JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>
    : undefined;
  const capabilities = guest?.capabilities ?? basePayload.capabilities;
  const permissions = guest?.permissions ?? basePayload.permissions;
  const memory = guest?.memory ?? basePayload.memory;

  const baseWorkerArtifact = basePayload.worker && typeof basePayload.worker === "object"
    ? (basePayload.worker.bytecode as Record<string, unknown> | undefined)
    : undefined;
  const baseWorkerPath = typeof baseWorkerArtifact?.path === "string" ? baseWorkerArtifact.path : undefined;
  const hasExplicitWorkerUpdate = guest?.worker !== undefined || metadata?.worker !== undefined;

  const removedSet = new Set(assetRemovals.map(validateLogicalAssetName));
  const replacedMap = new Map<string, string | Uint8Array>();
  for (const [rawName, source] of assetReplacements) {
    replacedMap.set(validateLogicalAssetName(rawName), source);
  }

  if (baseWorkerPath && !hasExplicitWorkerUpdate) {
    if (removedSet.has(baseWorkerPath)) {
      throw new Error(`patch: cannot remove active worker asset ${baseWorkerPath} without updating worker manifest`);
    }
    if (replacedMap.has(baseWorkerPath)) {
      throw new Error(`patch: cannot replace worker asset ${baseWorkerPath} without updating signed worker descriptor`);
    }
  }

  const map: Record<string, AssetFile> = Object.create(null) as Record<string, AssetFile>;
  if (basePayload.assets || assetReplacements.length > 0) {
    for (const [name, asset] of Object.entries(basePayload.assets ?? {})) {
      if (removedSet.has(name) || replacedMap.has(name) || (hasExplicitWorkerUpdate && name === baseWorkerPath)) continue;
      copyBaseBlob(asset.sha256, asset.size);
      map[name] = { sha256: asset.sha256, size: asset.size };
    }
    for (const [safeName, source] of replacedMap.entries()) {
      if (typeof source === "string") assertNoRemoteNativeCode(source);
      const content = add(readBytesOrFile(source));
      map[safeName] = { sha256: content.sha256, size: content.size };
    }
  }

  const rawWorker = guest?.worker ?? metadata?.worker ?? (removedSet.has(baseWorkerPath ?? "") ? undefined : basePayload.worker);
  let worker: Record<string, unknown> | undefined;
  if (rawWorker !== undefined) {
    if (!rawWorker || typeof rawWorker !== "object" || Array.isArray(rawWorker)) {
      throw new Error("patch: worker descriptor must be an object");
    }
    const descriptor = rawWorker as Record<string, unknown>;
    const artifact = descriptor.bytecode as Record<string, unknown> | undefined;
    const rawPath = artifact?.path;
    if (
      entryFormat !== "quickjs-bytecode" ||
      descriptor.kind !== "quickjs-bytecode" ||
      descriptor.protocolVersion !== 1 ||
      descriptor.runtimeAbi !== runtimeAbi ||
      typeof rawPath !== "string" ||
      rawPath.includes("\\") ||
      rawPath.startsWith("/") ||
      rawPath.split("/").some((p) => !p || p === "." || p === ".." || p.trim() !== p)
    ) {
      throw new Error("patch: invalid worker bytecode descriptor/ABI/path");
    }
    const declared = new Set([...(capabilities?.requires ?? []), ...(capabilities?.optional ?? [])]);
    if (
      !declared.has("runtime.worker") ||
      !Array.isArray(descriptor.requiredCaps) ||
      descriptor.requiredCaps.some((c) => typeof c !== "string" || !declared.has(c))
    ) {
      throw new Error("patch: worker capabilities must be declared in signed guest manifest");
    }
    let resolvedAssetPath = rawPath;
    if (baseWorkerPath && baseWorkerPath !== rawPath && baseWorkerPath.endsWith(`/${rawPath}`)) {
      resolvedAssetPath = baseWorkerPath;
    }
    if (hasExplicitWorkerUpdate) {
      let workerBytes: Uint8Array | undefined;
      if (replacedMap.has(resolvedAssetPath)) {
        workerBytes = readBytesOrFile(replacedMap.get(resolvedAssetPath)!);
      } else if (replacedMap.has(rawPath)) {
        resolvedAssetPath = rawPath;
        workerBytes = readBytesOrFile(replacedMap.get(rawPath)!);
      } else if (entryDir && existsSync(join(entryDir, rawPath))) {
        workerBytes = new Uint8Array(readFileSync(join(entryDir, rawPath)));
      } else if (options.guestManifestPath && existsSync(join(dirname(resolve(options.guestManifestPath)), rawPath))) {
        workerBytes = new Uint8Array(readFileSync(join(dirname(resolve(options.guestManifestPath)), rawPath)));
      } else if (map[resolvedAssetPath]) {
        const blobPath = join(outDir, "blobs", map[resolvedAssetPath].sha256);
        workerBytes = new Uint8Array(readFileSync(blobPath));
      } else if (basePayload.assets?.[resolvedAssetPath]) {
        const baseAsset = basePayload.assets[resolvedAssetPath];
        const blobPath = join(baseDir, "blobs", baseAsset.sha256);
        workerBytes = new Uint8Array(readFileSync(blobPath));
      }
      if (
        !workerBytes ||
        workerBytes.byteLength !== artifact.bytes ||
        sha256Hex(workerBytes) !== artifact.sha256 ||
        workerBytes.byteLength <= 124 ||
        Buffer.from(workerBytes.subarray(0, 4)).toString() !== "PJBC"
      ) {
        throw new Error("patch: worker bytecode integrity mismatch");
      }
      const content = add(workerBytes);
      if (baseWorkerPath && baseWorkerPath !== resolvedAssetPath && !replacedMap.has(baseWorkerPath)) {
        delete map[baseWorkerPath];
      }
      if (map[resolvedAssetPath] && (map[resolvedAssetPath].sha256 !== content.sha256 || map[resolvedAssetPath].size !== content.size)) {
        throw new Error("patch: conflicting worker asset");
      }
      map[resolvedAssetPath] = { sha256: content.sha256, size: content.size };
    } else {
      const existingAsset = map[resolvedAssetPath];
      if (!existingAsset || existingAsset.sha256 !== artifact.sha256 || existingAsset.size !== artifact.bytes) {
        throw new Error("patch: worker bytecode integrity mismatch");
      }
      const workerBytes = new Uint8Array(readFileSync(join(outDir, "blobs", existingAsset.sha256)));
      if (workerBytes.byteLength <= 124 || Buffer.from(workerBytes.subarray(0, 4)).toString() !== "PJBC") {
        throw new Error("patch: worker bytecode integrity mismatch");
      }
    }
    worker = { ...descriptor, bytecode: { ...artifact, path: resolvedAssetPath } };
  } else if (capabilities?.requires.includes("runtime.worker") || (entryDir && existsSync(join(entryDir, "app.worker.qjbc")))) {
    throw new Error("patch: refusing to publish a worker package without its signed descriptor");
  }

  let nextAssets: Record<string, AssetFile> | undefined;
  const sortedNames = Object.keys(map).sort();
  if (sortedNames.length > 0) {
    nextAssets = Object.create(null) as Record<string, AssetFile>;
    for (const name of sortedNames) nextAssets[name] = map[name];
  }

  const orderedFiles = stableFiles(files);
  const bundleResult = options.includeBundle === false
    ? undefined
    : writeBundleZip(outDir, orderedFiles, options.bundleFormat ?? basePayload.bundle?.format ?? "7z");
  const payload: PocketUpdatePayload = {
    schemaVersion: 1,
    appId: basePayload.appId,
    version: options.version,
    build: options.build,
    protocol: basePayload.protocol,
    minHostVersion: basePayload.minHostVersion,
    entry: { sha256: entryFile.sha256, size: entryFile.size },
    entryFormat,
    ...(runtimeAbi === undefined ? {} : { runtimeAbi }),
    pak: { sha256: pakSha256, size: pakSize, parts },
    files: orderedFiles,
    ...(bundleResult === undefined ? {} : { bundle: bundleResult.descriptor }),
    ...(nextAssets === undefined ? {} : { assets: nextAssets }),
    ...(worker === undefined ? {} : { worker }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(memory === undefined ? {} : { memory }),
  };
  const payloadBytes = encoder.encode(JSON.stringify(payload));
  const envelope = signPayload(payloadBytes, loadPrivateKey(options.keyFile));
  const payloadPath = join(outDir, "payload.json");
  const manifestPath = join(outDir, "signed-manifest.json");
  writeFileSync(payloadPath, asBuffer(payloadBytes));
  const envelopeBytes = encoder.encode(JSON.stringify(envelope));
  writeFileSync(manifestPath, asBuffer(envelopeBytes));
  writeFileSync(join(outDir, "latest.json"), asBuffer(envelopeBytes));
  return {
    payload,
    envelope,
    payloadBytes,
    manifestPath,
    ...(bundleResult === undefined ? {} : { bundlePath: bundleResult.bundlePath }),
    pakParts,
  };
}

export function writePublicKeyConfig(outPath: string, config: PublicKeyConfig): void {
  ensureDir(dirname(resolve(outPath)));
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 });
  try { chmodSync(outPath, 0o644); } catch { /* Windows/readonly filesystems may not support chmod. */ }
}

export function generateDevKey(outPath: string, keyId?: string, force = false): PublicKeyConfig & { publicKeyPem: string } {
  if (existsSync(outPath) && !force) throw new Error(`key already exists: ${outPath} (pass --force to replace)`);
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyBase64 = ed25519RawPublicKey(pair.publicKey).toString("base64");
  const resolvedKeyId = keyId || `dev-${sha256Hex(new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }))).slice(0, 16)}`;
  ensureDir(dirname(resolve(outPath)));
  writeFileSync(outPath, JSON.stringify({ keyId: resolvedKeyId, privateKeyPem, publicKeyPem, publicKeyBase64 }, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(outPath, 0o600); } catch { /* Windows/readonly filesystems may not support chmod. */ }
  return { keyId: resolvedKeyId, publicKeyPem, publicKeyBase64 };
}

function usage(): never {
  throw new Error([
    "usage:",
    "  bun scripts/package_update.ts package --app-id ID --version VERSION --build N --js app.js --pak app.pak --out DIR --key-file KEY [--entry-format javascript|quickjs-bytecode --bytecode app.qjbc --runtime-abi ABI] [--guest-manifest manifest.json] [--asset-dir DIR] [--asset-prefix PREFIX] [--no-bundle]",
    "  bun scripts/package_update.ts patch --base-dir DIR --out DIR --version VERSION --build N --key-file KEY [--js app.js | --bytecode app.qjbc] [--pak-entry KEY=FILE] [--asset NAME=FILE] [--remove-asset NAME] [--no-bundle]",
    "  bun scripts/pocket_package.ts generate-dev-key --out KEY [--key-id ID] [--public-config-out PUBLIC_JSON] [--force]",
  ].join("\n"));
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string>; multiFlags: Map<string, string[]>; booleans: Set<string> } {
  let command = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : "package";
  const flags = new Map<string, string>();
  const multiFlags = new Map<string, string[]>();
  const booleans = new Set<string>();
  const recordFlag = (key: string, val: string): void => {
    flags.set(key, val);
    const list = multiFlags.get(key) ?? [];
    list.push(val);
    multiFlags.set(key, list);
  };
  while (argv.length) {
    const arg = argv.shift()!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      recordFlag(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    if (name === "force" || name === "adb-reverse" || name === "no-bundle") booleans.add(name);
    else {
      const value = argv.shift();
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
      recordFlag(name, value);
    }
  }
  return { command, flags, multiFlags, booleans };
}

function parseKeyValuePairs(items: string[] | undefined, flagName: string): Record<string, string> | undefined {
  if (!items || items.length === 0) return undefined;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const item of items) {
    const splitAt = item.indexOf("=");
    if (splitAt <= 0 || splitAt === item.length - 1) {
      throw new Error(`patch: --${flagName} requires NAME=PATH, got ${item}`);
    }
    out[item.slice(0, splitAt)] = item.slice(splitAt + 1);
  }
  return out;
}

if (import.meta.main) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.command === "generate-dev-key") {
      const out = parsed.flags.get("out") || parsed.flags.get("key-file");
      if (!out) usage();
      const key = generateDevKey(out!, parsed.flags.get("key-id"), parsed.booleans.has("force"));
      const publicConfigOut = parsed.flags.get("public-config-out") || parsed.flags.get("public-config");
      if (publicConfigOut) writePublicKeyConfig(publicConfigOut, { keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 });
      console.log(JSON.stringify({ out: resolve(out!), keyId: key.keyId, ...(publicConfigOut ? { publicConfig: resolve(publicConfigOut) } : {}) }));
    } else if (parsed.command === "package") {
      const required = ["app-id", "version", "build", "pak", "out", "key-file"];
      for (const name of required) if (!parsed.flags.has(name)) throw new Error(`package: missing --${name}`);
      const entryFormat = parsed.flags.get("entry-format") as "javascript" | "quickjs-bytecode" | undefined;
      if (entryFormat === "quickjs-bytecode" && !parsed.flags.has("bytecode")) throw new Error("package: missing --bytecode");
      if (entryFormat !== "quickjs-bytecode" && !parsed.flags.has("js")) throw new Error("package: missing --js");
      const result = packageArtifacts({
        appId: parsed.flags.get("app-id")!, version: parsed.flags.get("version")!,
        build: Number(parsed.flags.get("build")), jsPath: parsed.flags.get("js"), bytecodePath: parsed.flags.get("bytecode"),
        entryFormat,
        runtimeAbi: parsed.flags.get("runtime-abi"),
        pakPath: parsed.flags.get("pak")!, outDir: parsed.flags.get("out")!, keyFile: parsed.flags.get("key-file")!,
        assetDir: parsed.flags.get("asset-dir"), assetPrefix: parsed.flags.get("asset-prefix"),
        guestManifestPath: parsed.flags.get("guest-manifest"),
        protocol: parsed.flags.has("protocol") ? Number(parsed.flags.get("protocol")) : undefined,
        minHostVersion: parsed.flags.has("min-host-version") ? Number(parsed.flags.get("min-host-version")) : undefined,
        includeBundle: !parsed.booleans.has("no-bundle"),
        bundleFormat: (parsed.flags.get("bundle-format") as BundleFormat | undefined),
      });
      console.log(JSON.stringify({ manifest: result.manifestPath, bundle: result.bundlePath, files: result.payload.files.length, pakParts: result.payload.pak.parts.length }));
    } else if (parsed.command === "patch") {
      const required = ["base-dir", "out", "version", "build", "key-file"];
      for (const name of required) if (!parsed.flags.has(name)) throw new Error(`patch: missing --${name}`);
      const result = patchPackageArtifacts({
        baseDir: parsed.flags.get("base-dir")!,
        outDir: parsed.flags.get("out")!,
        version: parsed.flags.get("version")!,
        build: Number(parsed.flags.get("build")),
        keyFile: parsed.flags.get("key-file")!,
        jsPath: parsed.flags.get("js"),
        bytecodePath: parsed.flags.get("bytecode"),
        entryFormat: parsed.flags.get("entry-format") as "javascript" | "quickjs-bytecode" | undefined,
        runtimeAbi: parsed.flags.get("runtime-abi"),
        replacePakEntries: parseKeyValuePairs(parsed.multiFlags.get("pak-entry"), "pak-entry"),
        replaceAssets: parseKeyValuePairs(parsed.multiFlags.get("asset"), "asset"),
        removeAssets: parsed.multiFlags.get("remove-asset"),
        guestManifestPath: parsed.flags.get("guest-manifest"),
        includeBundle: !parsed.booleans.has("no-bundle"),
        bundleFormat: (parsed.flags.get("bundle-format") as BundleFormat | undefined),
      });
      console.log(JSON.stringify({ manifest: result.manifestPath, bundle: result.bundlePath, files: result.payload.files.length, pakParts: result.payload.pak.parts.length }));
    } else usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

