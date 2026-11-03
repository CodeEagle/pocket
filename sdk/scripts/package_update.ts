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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const PAK_MAGIC = 0x4b504344;
const PAK_VERSION = 1;
const PAK_HEADER_SIZE = 32;
const PAK_ENTRY_SIZE = 24;
const MIN_HEAP_LIMIT_BYTES = 64 * 1024;
const MAX_HEAP_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MIN_PAK_BYTES = 1;
const MAX_PAK_BYTES = 512 * 1024 * 1024;

export type ContentFile = {
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

export type PakLayoutPart = PakPart & { kind: "blob" | "metadata" };

type PakRange = { offset: number; size: number; kind: "blob" | "metadata" };
type SigningKey = { keyId: string; privateKey: ReturnType<typeof createPrivateKey> };

const encoder = new TextEncoder();
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + index * PAK_ENTRY_SIZE;
    const blobOffset = readU32(view, entryOffset + 4);
    const blobSize = readU32(view, entryOffset + 8);
    const nameOffset = readU32(view, entryOffset + 12);
    const nameSize = readU16(view, entryOffset + 16);
    assertRange(namesOffset + nameOffset, nameSize, file.byteLength, `entry ${index} name`);
    if (namesOffset + nameOffset + nameSize > blobsOffset) throw new Error(`pak: entry ${index} name overlaps blob area`);
    if (blobOffset < blobsOffset) throw new Error(`pak: entry ${index} blob starts before blob area`);
    assertRange(blobOffset, blobSize, file.byteLength, `entry ${index} blob`);
    if (blobSize > 0) ranges.push({ offset: blobOffset, size: blobSize, kind: "blob" });
  }

  // Entries in a valid pack do not overlap.  Keeping this check explicit
  // prevents an invalid pack from causing an ambiguous reconstruction.
  ranges.sort((a, b) => a.offset - b.offset || a.size - b.size);
  const uniqueRanges: PakRange[] = [];
  for (const range of ranges) {
    const previous = uniqueRanges.at(-1);
    if (previous && range.offset === previous.offset && range.size === previous.size) continue;
    uniqueRanges.push(range);
  }
  for (let index = 1; index < uniqueRanges.length; index += 1) {
    const previous = uniqueRanges[index - 1];
    const current = uniqueRanges[index];
    if (current.offset < previous.offset + previous.size) {
      throw new Error(`pak: overlapping blob ranges at ${previous.offset} and ${current.offset}`);
    }
  }

  const parts: PakLayoutPart[] = [];
  let cursor = 0;
  for (const range of uniqueRanges) {
    if (range.offset > cursor) parts.push({ offset: cursor, size: range.offset - cursor, sha256: "", kind: "metadata" });
    if (range.offset < cursor) throw new Error("pak: non-monotonic blob range");
    parts.push({ offset: range.offset, size: range.size, sha256: "", kind: "blob" });
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
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`package: asset-prefix must be a safe relative path: ${prefix}`);
  }
  const normalized = raw.replace(/\/+$/g, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`package: asset-prefix must be a safe relative path: ${prefix}`);
  }
  return normalized;
}

function safeAssetName(rootDir: string, filePath: string, prefix: string | undefined): string {
  const rawRelative = relative(rootDir, filePath);
  const normalized = rawRelative.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
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
};

export type PackageResult = {
  payload: PocketUpdatePayload;
  envelope: SignedManifest;
  payloadBytes: Uint8Array;
  manifestPath: string;
  pakParts: PakLayoutPart[];
};

/** Build payload.json, signed-manifest.json, latest.json and content blobs. */
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
    return { offset: part.offset, sha256: file.sha256, size: part.size };
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
    files: stableFiles(files),
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
  return { payload, envelope, payloadBytes, manifestPath, pakParts: layout.map((part, index) => ({ ...part, sha256: parts[index].sha256 })) };
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
    "  bun scripts/package_update.ts package --app-id ID --version VERSION --build N --js app.js --pak app.pak --out DIR --key-file KEY [--entry-format javascript|quickjs-bytecode --bytecode app.qjbc --runtime-abi ABI] [--guest-manifest manifest.json] [--asset-dir DIR] [--asset-prefix PREFIX]",
    "  bun scripts/pocket_package.ts generate-dev-key --out KEY [--key-id ID] [--public-config-out PUBLIC_JSON] [--force]",
  ].join("\n"));
}

function parseArgs(argv: string[]): { command: string; flags: Map<string, string>; booleans: Set<string> } {
  let command = argv[0] && !argv[0].startsWith("--") ? argv.shift()! : "package";
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  while (argv.length) {
    const arg = argv.shift()!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }
    const name = arg.slice(2);
    if (name === "force" || name === "adb-reverse") booleans.add(name);
    else {
      const value = argv.shift();
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${name}`);
      flags.set(name, value);
    }
  }
  return { command, flags, booleans };
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
      });
      console.log(JSON.stringify({ manifest: result.manifestPath, files: result.payload.files.length, pakParts: result.payload.pak.parts.length }));
    } else usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

