import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { SDK_VERSION, readPrebuiltToolsSourceConstants, validateToolsPackage } from './prebuilt_tools.mjs';

export const DEFAULT_GITHUB_RELEASES_URL = 'https://api.github.com/repos/CodeEagle/pocket/releases';
export const DEFAULT_SOURCE_REPOSITORY = 'CodeEagle/pocket';
export const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_SHA256_BYTES = 64 * 1024;
export const MAX_ARCHIVE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_EXTRACTED_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_EXTRACTED_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_EXTRACTED_ENTRIES = 16_384;
export const RELEASE_CHECK_TIMEOUT_MS = 10_000;
export const RELEASE_DOWNLOAD_TIMEOUT_MS = 60_000;

export const MANAGED_SDK_PATHS = [
  'editor',
  'scripts',
  'packages',
  'targets',
  'templates',
  'docs',
  'prebuilt',
  'native',
  'package.json',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'provenance.json',
  'README.md',
  'LICENSE',
  '.gitignore',
];

const MANAGED_SDK_TOP_LEVEL = new Set(MANAGED_SDK_PATHS);
const SDK_MANIFEST_FILENAME = '.pocket-sdk-manifest.json';
const BACKUP_META_FILENAME = 'backup-meta.json';
const BACKUP_COMPLETE_FILENAME = 'backup-complete.json';

const ALLOWED_HTTPS_RELEASE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

export function parseStableSemver(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const normalized = trimmed.startsWith('sdk-v')
    ? trimmed.slice('sdk-v'.length)
    : trimmed.startsWith('v')
      ? trimmed.slice(1)
      : trimmed;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch, version: `${major}.${minor}.${patch}` };
}

export function compareStableSemver(left, right) {
  const a = typeof left === 'string' ? parseStableSemver(left) : left;
  const b = typeof right === 'string' ? parseStableSemver(right) : right;
  if (!a || !b) throw new Error(`无效的稳定语义化版本号：${String(left)} vs ${String(right)}`);
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

export function expectedSdkArchiveAssetNames(version, platform = process.platform, arch = process.arch) {
  const parsed = parseStableSemver(version);
  if (!parsed) throw new Error(`无效的 SDK 发布版本号：${version}`);
  const tuple = `${platform}-${arch}`;
  const archiveName = `pocket-web-sdk-tools-${tuple}-${parsed.version}.tgz`;
  return {
    platformTuple: tuple,
    version: parsed.version,
    archiveName,
    checksumName: `${archiveName}.sha256`,
    toolsArchiveName: `pocket-tools-${tuple}-${parsed.version}.tgz`,
    toolsPackageRelPath: `node_modules/@pocket/tools-${tuple}`,
  };
}

export function readInstalledSdkInfo(sdkRoot, platform = process.platform, arch = process.arch) {
  const resolvedRoot = resolve(sdkRoot);
  const checkoutRoot = resolve(resolvedRoot, '..');
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(resolvedRoot, 'package.json'), 'utf8'));
  } catch {
    pkg = {};
  }
  const currentVersion = parseStableSemver(pkg.version)?.version || SDK_VERSION;
  const tuple = `${platform}-${arch}`;
  const validStandaloneName = pkg.name === '@pocket/web-sdk-tools' || pkg.name === `@pocket/web-sdk-tools-${tuple}`;
  let provenance = null;
  const provenancePath = join(resolvedRoot, 'provenance.json');
  if (existsSync(provenancePath) && lstatSync(provenancePath).isFile()) {
    try {
      provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    } catch {
      provenance = null;
    }
  }
  const hasGitInRoot = existsSync(join(resolvedRoot, '.git'));
  const hasParentSourceRepo = existsSync(join(checkoutRoot, '.git')) && existsSync(join(checkoutRoot, 'demo')) && resolve(join(checkoutRoot, 'sdk')) === resolvedRoot;
  const hasEditorTestTree = existsSync(join(resolvedRoot, 'editor', 'test'));
  const hasValidProvenance = Boolean(provenance && typeof provenance === 'object' && provenance.sourceRepository === DEFAULT_SOURCE_REPOSITORY);
  const isStandalone = Boolean(validStandaloneName && hasValidProvenance && !hasGitInRoot && !hasParentSourceRepo && !hasEditorTestTree);
  return {
    sdkRoot: resolvedRoot,
    packageName: typeof pkg.name === 'string' ? pkg.name : 'pocketjs-sdk',
    currentVersion,
    platformTuple: tuple,
    mode: isStandalone ? 'standalone' : 'source',
    autoUpgradeSupported: isStandalone,
    modeReason: isStandalone
      ? '受管独立 Web SDK 安装目录'
      : '源码仓库或开发检出模式（仅检查版本，不自动覆盖 Git 工作区）',
  };
}

export function validateReleaseOriginUrl(rawUrl, options = {}) {
  const allowLoopbackHttp = Boolean(options.allowLoopbackHttp ?? process.env.POCKET_STUDIO_UPGRADE_ALLOW_LOOPBACK === '1');
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error(`非法发布地址：${rawUrl}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`发布地址禁止内嵌凭据：${rawUrl}`);
  }
  if (parsed.protocol === 'https:') {
    if (!ALLOWED_HTTPS_RELEASE_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error(`不受信任的发布主机：${parsed.hostname}`);
    }
    return parsed;
  }
  if (allowLoopbackHttp && parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
    return parsed;
  }
  throw new Error(`升级仅允许来自受信任 GitHub HTTPS 发布源：${rawUrl}`);
}

export async function readBoundedResponseBytes(response, maxBytes, label) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`${label} 超过大小上限（${declared} > ${maxBytes} 字节）`);
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`${label} 超过大小上限（${buffer.byteLength} > ${maxBytes} 字节）`);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} 超过大小上限（>${maxBytes} 字节）`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export function selectLatestStableRelease(releasesPayload, platform = process.platform, arch = process.arch, options = {}) {
  const list = Array.isArray(releasesPayload)
    ? releasesPayload
    : releasesPayload && typeof releasesPayload === 'object'
      ? [releasesPayload]
      : [];
  const candidates = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.draft === true || item.prerelease === true) continue;
    const tagName = typeof item.tag_name === 'string' ? item.tag_name.trim() : '';
    if (!tagName.startsWith('sdk-v')) continue;
    const parsedVersion = parseStableSemver(tagName);
    if (!parsedVersion) continue;
    const expected = expectedSdkArchiveAssetNames(parsedVersion.version, platform, arch);
    const assets = Array.isArray(item.assets) ? item.assets : [];
    const archiveAsset = assets.find((asset) => asset && typeof asset === 'object' && asset.name === expected.archiveName);
    const checksumAsset = assets.find(
      (asset) => asset && typeof asset === 'object' && (asset.name === expected.checksumName || asset.name === 'SHA256SUMS'),
    );
    const archiveUrl = typeof archiveAsset?.browser_download_url === 'string' ? archiveAsset.browser_download_url : '';
    const checksumUrl = typeof checksumAsset?.browser_download_url === 'string' ? checksumAsset.browser_download_url : '';
    const htmlUrl = typeof item.html_url === 'string' && item.html_url
      ? item.html_url
      : `https://github.com/${DEFAULT_SOURCE_REPOSITORY}/releases/tag/${tagName}`;
    if (archiveUrl) validateReleaseOriginUrl(archiveUrl, options);
    if (checksumUrl) validateReleaseOriginUrl(checksumUrl, options);
    candidates.push({
      tagName,
      version: parsedVersion.version,
      semver: parsedVersion,
      releaseUrl: htmlUrl,
      publishedAt: typeof item.published_at === 'string' ? item.published_at : null,
      archiveName: expected.archiveName,
      checksumName: checksumAsset?.name || expected.checksumName,
      archiveUrl: archiveUrl || null,
      checksumUrl: checksumUrl || null,
      hasMatchingPlatformAsset: Boolean(archiveUrl && checksumUrl),
    });
  }
  candidates.sort((left, right) => compareStableSemver(right.semver, left.semver));
  return candidates[0] || null;
}

export function parseSha256File(rawText, expectedArchiveName) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('SHA-256 校验文件内容为空');
  }
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([A-Fa-f0-9]{64})(?:\s+\*?([^\s]+))?$/);
    if (!match) continue;
    const hash = match[1].toLowerCase();
    const file = match[2] ? posix.basename(match[2].replaceAll('\\', '/')) : undefined;
    if (!file || file === expectedArchiveName) return hash;
  }
  throw new Error(`SHA-256 校验文件未包含 ${expectedArchiveName} 的有效摘要`);
}

function parseOctalField(block, offset, length) {
  const raw = block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`tar 头部包含非法八进制字段：${raw}`);
  return Number.parseInt(raw, 8);
}

function verifyTarHeaderChecksum(block) {
  const recorded = parseOctalField(block, 148, 8);
  let unsignedSum = 0;
  for (let i = 0; i < 512; i += 1) {
    unsignedSum += (i >= 148 && i < 156) ? 0x20 : block[i];
  }
  if (unsignedSum !== recorded) {
    throw new Error('tar 归档头部校验和无效');
  }
}

function parsePaxExtendedHeader(bytes) {
  const text = bytes.toString('utf8');
  let cursor = 0;
  const records = {};
  while (cursor < text.length) {
    const spaceIdx = text.indexOf(' ', cursor);
    if (spaceIdx < 0) break;
    const length = Number.parseInt(text.slice(cursor, spaceIdx), 10);
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error('tar PAX 扩展头长度无效');
    const record = text.slice(spaceIdx + 1, cursor + length - 1);
    const eqIdx = record.indexOf('=');
    if (eqIdx > 0) {
      records[record.slice(0, eqIdx)] = record.slice(eqIdx + 1);
    }
    cursor += length;
  }
  return records;
}

export function normalizeSafeArchiveRelativePath(rawEntryPath, stripTopLevelPackage = true) {
  if (typeof rawEntryPath !== 'string' || !rawEntryPath || rawEntryPath.includes('\0')) {
    throw new Error('归档包含空路径或 NUL 字节');
  }
  if (rawEntryPath.includes('\\')) {
    throw new Error(`归档路径包含非法反斜杠：${rawEntryPath}`);
  }
  if (rawEntryPath.startsWith('/') || /^[A-Za-z]:/.test(rawEntryPath)) {
    throw new Error(`归档包含绝对路径或盘符路径：${rawEntryPath}`);
  }
  const parts = rawEntryPath.split('/');
  for (const part of parts) {
    if (part === '..') throw new Error(`归档包含路径穿越段：${rawEntryPath}`);
  }
  const filtered = parts.filter((part) => part.length > 0 && part !== '.');
  if (filtered.length === 0) return '';
  if (stripTopLevelPackage) {
    if (filtered[0] !== 'package') {
      throw new Error(`归档条目必须位于顶层 package/ 目录下：${rawEntryPath}`);
    }
    filtered.shift();
  }
  return filtered.join('/');
}

export function extractSafeTarGz(tgzBytes, targetDirectory, options = {}) {
  const maxTotalBytes = options.maxTotalBytes ?? MAX_EXTRACTED_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? MAX_EXTRACTED_FILE_BYTES;
  const maxEntries = options.maxEntries ?? MAX_EXTRACTED_ENTRIES;
  const stripTopLevelPackage = options.stripTopLevelPackage ?? true;
  if (!Buffer.isBuffer(tgzBytes) && !(tgzBytes instanceof Uint8Array)) {
    throw new Error('归档数据必须是字节数组');
  }
  const tarBytes = gunzipSync(tgzBytes, { maxOutputLength: maxTotalBytes });
  if (tarBytes.byteLength === 0 || tarBytes.byteLength % 512 !== 0) {
    throw new Error('tar 归档大小无效');
  }

  const parsedEntries = [];
  let offset = 0;
  let totalBytes = 0;
  let nextPaxPath = null;
  let nextLongLinkPath = null;

  while (offset + 512 <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + 512);
    offset += 512;
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) continue;

    verifyTarHeaderChecksum(header);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const size = parseOctalField(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tarBytes.byteLength) {
      throw new Error('tar 条目大小越界');
    }
    const mode = parseOctalField(header, 100, 8);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const rawHeaderPath = prefix ? `${prefix}/${name}` : name;
    const payload = tarBytes.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;

    if (typeFlag === 'g') {
      const pax = parsePaxExtendedHeader(payload);
      if (pax.path || pax.linkpath) throw new Error('拒绝包含全局路径覆盖的 tar 归档');
      continue;
    }
    if (typeFlag === 'x') {
      const pax = parsePaxExtendedHeader(payload);
      if (pax.linkpath) throw new Error('拒绝包含符号链接/硬链接扩展头的 tar 归档');
      if (pax.path) nextPaxPath = pax.path;
      continue;
    }
    if (typeFlag === 'L') {
      nextLongLinkPath = payload.toString('utf8').replace(/\0.*$/, '');
      continue;
    }

    const effectiveRawPath = nextPaxPath ?? nextLongLinkPath ?? rawHeaderPath;
    nextPaxPath = null;
    nextLongLinkPath = null;

    if (typeFlag === '1' || typeFlag === '2' || typeFlag === '3' || typeFlag === '4' || typeFlag === '6') {
      throw new Error(`拒绝包含链接或特殊设备节点的归档条目（type=${typeFlag}）：${effectiveRawPath}`);
    }
    if (typeFlag !== '0' && typeFlag !== '5') {
      throw new Error(`不支持的 tar 条目类型（type=${typeFlag}）：${effectiveRawPath}`);
    }

    const isDirectory = typeFlag === '5' || effectiveRawPath.endsWith('/');
    const relPath = normalizeSafeArchiveRelativePath(effectiveRawPath, stripTopLevelPackage);
    if (!relPath) continue;

    if (!isDirectory) {
      if (size > maxFileBytes) {
        throw new Error(`归档单文件超过大小限制：${relPath} (${size} > ${maxFileBytes})`);
      }
      totalBytes += size;
      if (totalBytes > maxTotalBytes) {
        throw new Error(`归档解压总大小超过上限（>${maxTotalBytes} 字节）`);
      }
    }

    parsedEntries.push({
      relPath,
      isDirectory,
      mode: (mode & 0o111) ? 0o755 : 0o644,
      payload,
    });
    if (parsedEntries.length > maxEntries) {
      throw new Error(`归档条目数量超过上限（>${maxEntries}）`);
    }
  }

  const root = resolve(targetDirectory);
  mkdirSync(root, { recursive: true });
  for (const entry of parsedEntries) {
    const dest = resolve(root, entry.relPath);
    const rel = relative(root, dest);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`拒绝越界解压路径：${entry.relPath}`);
    }
    if (entry.isDirectory) {
      mkdirSync(dest, { recursive: true });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.payload, { mode: entry.mode });
    try {
      chmodSync(dest, entry.mode);
    } catch {
      /* Windows filesystem may ignore POSIX mode bits */
    }
  }
  return { root, entriesCount: parsedEntries.length, totalBytes };
}

const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

export function withBoundedFsRetries(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 10;
  const retryDelay = options.retryDelay ?? 200;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fn();
    } catch (error) {
      if (attempt >= maxRetries || !TRANSIENT_FS_CODES.has(error?.code)) throw error;
      sleepSyncMs(retryDelay);
    }
  }
}

function removeTreeWithRetries(targetPath) {
  rmSync(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export function validateStagedStandaloneSdk(stageRoot, expectedVersion, platform = process.platform, arch = process.arch) {
  const root = resolve(stageRoot);
  const expected = expectedSdkArchiveAssetNames(expectedVersion, platform, arch);
  const pkgPath = join(root, 'package.json');
  const provenancePath = join(root, 'provenance.json');
  const serverPath = join(root, 'editor', 'server.ts');
  const servicePath = join(root, 'scripts', 'editor_service.mjs');
  const prebuiltScriptPath = join(root, 'scripts', 'prebuilt_tools.mjs');
  if (!existsSync(pkgPath) || !existsSync(provenancePath) || !existsSync(serverPath) || !existsSync(servicePath)) {
    throw new Error('升级包缺少必要的 SDK 入口文件（package.json、provenance.json、editor/server.ts 或 scripts/editor_service.mjs）');
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const validName = pkg.name === '@pocket/web-sdk-tools' || pkg.name === `@pocket/web-sdk-tools-${expected.platformTuple}`;
  if (!validName || pkg.version !== expected.version) {
    throw new Error(`升级包清单不匹配：期望 ${expected.platformTuple}@${expected.version}，实际 ${pkg.name}@${pkg.version}`);
  }
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const stagedRevision = typeof provenance.pinnedPocketJsRevision === 'string' ? provenance.pinnedPocketJsRevision.trim() : '';
  if (provenance.sourceRepository !== DEFAULT_SOURCE_REPOSITORY || !/^[0-9a-f]{40}$/i.test(stagedRevision)) {
    throw new Error('升级包 provenance.json 仓库或固定编译器版本不匹配');
  }
  const stagedConstants = readPrebuiltToolsSourceConstants(prebuiltScriptPath);
  if (stagedConstants.sdkVersion && stagedConstants.sdkVersion !== expected.version) {
    throw new Error(`升级包 prebuilt_tools.mjs SDK_VERSION (${stagedConstants.sdkVersion}) 与目标版本 (${expected.version}) 不一致`);
  }
  if (stagedConstants.upstreamRevision && stagedConstants.upstreamRevision !== stagedRevision) {
    throw new Error(`升级包 prebuilt_tools.mjs UPSTREAM_REVISION (${stagedConstants.upstreamRevision}) 与 provenance.json (${stagedRevision}) 不一致`);
  }
  const toolsArchivePath = join(root, 'prebuilt', expected.toolsArchiveName);
  if (!existsSync(toolsArchivePath) || !lstatSync(toolsArchivePath).isFile()) {
    throw new Error(`升级包缺少平台预编译工具归档：prebuilt/${expected.toolsArchiveName}`);
  }
  const stagedToolsDir = join(root, '.staged-tools', expected.platformTuple);
  removeTreeWithRetries(stagedToolsDir);
  extractSafeTarGz(readFileSync(toolsArchivePath), stagedToolsDir, { stripTopLevelPackage: true });
  validateToolsPackage(stagedToolsDir, platform, arch, expected.version, {
    expectedUpstreamRevision: stagedRevision,
    expectedBytecodeAbi: stagedConstants.bytecodeAbi ?? null,
  });
  return {
    stageRoot: root,
    stagedToolsDir,
    version: expected.version,
    platformTuple: expected.platformTuple,
  };
}

export function upgradeStatusFilePath(sdkRoot) {
  return join(resolve(sdkRoot), '.pocket-build', 'sdk-upgrade-status.json');
}

export function readPersistedUpgradeStatus(sdkRoot) {
  const path = upgradeStatusFilePath(sdkRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writePersistedUpgradeStatus(sdkRoot, record) {
  const path = upgradeStatusFilePath(sdkRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function upgradeApplyLockPath(sdkRoot) {
  return join(resolve(sdkRoot), '.pocket-build', 'sdk-upgrade-apply.lock.json');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function isUpgradeApplyLockActive(sdkRoot) {
  const lockPath = upgradeApplyLockPath(sdkRoot);
  if (!existsSync(lockPath)) return false;
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (isPidAlive(Number(raw?.pid))) return true;
    const createdAt = Date.parse(String(raw?.updatedAt || raw?.createdAt || ''));
    if (raw?.phase === 'spawning' && Number.isFinite(createdAt) && Date.now() - createdAt < 10_000) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function acquireUpgradeApplyLock(sdkRoot, metadata = {}) {
  const lockPath = upgradeApplyLockPath(sdkRoot);
  mkdirSync(dirname(lockPath), { recursive: true });
  const callerPid = Number(metadata.pid ?? process.pid);
  const normalizedMeta = {
    ...metadata,
    ...(metadata.stageDir ? { stageDir: resolve(String(metadata.stageDir)) } : {}),
  };
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf8'));
      const existingPid = Number(existing?.pid);
      const isAuthenticatedSpawningHandoff = Boolean(
        existing?.phase === 'spawning' &&
        normalizedMeta?.phase === 'applying' &&
        typeof existing?.handoffToken === 'string' &&
        existing.handoffToken.length > 0 &&
        existing.handoffToken === normalizedMeta.handoffToken &&
        existing?.targetVersion === normalizedMeta.targetVersion &&
        existing?.stageDir &&
        normalizedMeta?.stageDir &&
        resolve(String(existing.stageDir)) === resolve(String(normalizedMeta.stageDir)),
      );
      if (!isAuthenticatedSpawningHandoff && isUpgradeApplyLockActive(sdkRoot)) {
        const err = new Error(`已有另一个升级进程正在执行（PID ${existingPid || 'unknown'}）`);
        err.status = 409;
        throw err;
      }
    } catch (error) {
      if (error?.status === 409) throw error;
    }
    rmSync(lockPath, { force: true });
  }
  const payload = {
    pid: callerPid,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...normalizedMeta,
  };
  const fd = openSync(lockPath, 'wx');
  try {
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  const updateLock = (patch = {}) => {
    try {
      if (!existsSync(lockPath)) return;
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current?.pid !== callerPid) return;
      const next = {
        ...current,
        ...patch,
        ...(patch.stageDir ? { stageDir: resolve(String(patch.stageDir)) } : {}),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(lockPath, `${JSON.stringify(next, null, 2)}\n`);
    } catch {}
  };
  const releaseLock = () => {
    try {
      if (!existsSync(lockPath)) return;
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current?.pid === callerPid) rmSync(lockPath, { force: true });
    } catch {
      rmSync(lockPath, { force: true });
    }
  };
  releaseLock.update = updateLock;
  return releaseLock;
}

function listRelativeFilesUnderRoot(rootDir, allowedTopLevel = null) {
  const resolvedRoot = resolve(rootDir);
  if (!existsSync(resolvedRoot)) return [];
  const results = [];
  const walk = (currentDir) => {
    const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const rel = relative(resolvedRoot, fullPath).replaceAll('\\', '/');
      const top = rel.split('/')[0];
      if (allowedTopLevel && !allowedTopLevel.has(top)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  };
  walk(resolvedRoot);
  return results;
}

function computeSdkOwnedFilesToManage(sdkRoot, stageRoot) {
  const stagedFiles = listRelativeFilesUnderRoot(stageRoot, MANAGED_SDK_TOP_LEVEL);
  const stagedSet = new Set(stagedFiles);
  const manifestPath = join(resolve(sdkRoot), '.pocket-build', SDK_MANIFEST_FILENAME);
  let previousOwnedFiles = null;
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(parsed?.files)) {
        previousOwnedFiles = parsed.files.filter((item) => typeof item === 'string' && MANAGED_SDK_TOP_LEVEL.has(item.split('/')[0]));
      }
    } catch {
      previousOwnedFiles = null;
    }
  }
  if (!previousOwnedFiles) {
    previousOwnedFiles = stagedFiles;
  }
  const allCandidatePaths = new Set([...previousOwnedFiles, ...stagedFiles]);
  return {
    stagedFiles,
    stagedSet,
    previousOwnedFiles,
    allCandidatePaths: [...allCandidatePaths].sort(),
    manifestPath,
  };
}

function pruneEmptyManagedDirs(sdkRoot, fileRelPath) {
  const resolvedSdk = resolve(sdkRoot);
  let current = dirname(join(resolvedSdk, fileRelPath));
  while (current !== resolvedSdk && current.startsWith(resolvedSdk)) {
    try {
      const items = readdirSync(current);
      if (items.length > 0) break;
      rmSync(current, { recursive: true, force: true });
      current = dirname(current);
    } catch {
      break;
    }
  }
}

export function prepareSdkUpgradeBackup(sdkRoot, stageRoot, backupRoot, platform = process.platform, arch = process.arch) {
  const resolvedSdk = resolve(sdkRoot);
  const resolvedStage = resolve(stageRoot);
  const resolvedBackup = resolve(backupRoot);
  const tuple = `${platform}-${arch}`;
  const toolsRelPath = join('node_modules', '@pocket', `tools-${tuple}`);
  const stagedToolsDir = join(resolvedStage, '.staged-tools', tuple);
  if (!existsSync(stagedToolsDir)) {
    validateStagedStandaloneSdk(resolvedStage, JSON.parse(readFileSync(join(resolvedStage, 'package.json'), 'utf8')).version, platform, arch);
  }

  removeTreeWithRetries(resolvedBackup);
  mkdirSync(join(resolvedBackup, 'sdk'), { recursive: true });

  const { stagedFiles, allCandidatePaths, manifestPath } = computeSdkOwnedFilesToManage(resolvedSdk, resolvedStage);
  const backedUpFiles = [];
  const absentBeforeUpgrade = [];

  for (const rel of allCandidatePaths) {
    const existing = join(resolvedSdk, rel);
    if (existsSync(existing) && lstatSync(existing).isFile()) {
      const backupDest = join(resolvedBackup, 'sdk', rel);
      mkdirSync(dirname(backupDest), { recursive: true });
      withBoundedFsRetries(() => cpSync(existing, backupDest, { force: true }));
      backedUpFiles.push(rel);
    } else {
      absentBeforeUpgrade.push(rel);
    }
  }

  if (existsSync(manifestPath) && lstatSync(manifestPath).isFile()) {
    withBoundedFsRetries(() => cpSync(manifestPath, join(resolvedBackup, SDK_MANIFEST_FILENAME), { force: true }));
  }

  const existingToolsDir = join(resolvedSdk, toolsRelPath);
  const hadToolsDir = existsSync(existingToolsDir);
  if (hadToolsDir) {
    const backupToolsDest = join(resolvedBackup, 'tools');
    mkdirSync(dirname(backupToolsDest), { recursive: true });
    withBoundedFsRetries(() => cpSync(existingToolsDir, backupToolsDest, { recursive: true, force: true }));
  }

  const meta = {
    schemaVersion: 1,
    platform,
    arch,
    platformTuple: tuple,
    previousVersion: readInstalledSdkInfo(resolvedSdk, platform, arch).currentVersion,
    stagedFiles,
    backedUpFiles,
    absentBeforeUpgrade,
    hadToolsDir,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(resolvedBackup, BACKUP_META_FILENAME), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(resolvedBackup, BACKUP_COMPLETE_FILENAME), `${JSON.stringify({ completedAt: new Date().toISOString() }, null, 2)}\n`);
  return meta;
}

export function isSdkBackupComplete(backupRoot) {
  const resolvedBackup = resolve(backupRoot);
  return existsSync(join(resolvedBackup, BACKUP_COMPLETE_FILENAME)) && existsSync(join(resolvedBackup, BACKUP_META_FILENAME));
}

export function applyStagedSdkFiles(sdkRoot, stageRoot, backupRoot, platform = process.platform, arch = process.arch) {
  const resolvedSdk = resolve(sdkRoot);
  const resolvedStage = resolve(stageRoot);
  const resolvedBackup = resolve(backupRoot);
  const tuple = `${platform}-${arch}`;
  const toolsRelPath = join('node_modules', '@pocket', `tools-${tuple}`);
  const stagedToolsDir = join(resolvedStage, '.staged-tools', tuple);

  const meta = isSdkBackupComplete(resolvedBackup)
    ? JSON.parse(readFileSync(join(resolvedBackup, BACKUP_META_FILENAME), 'utf8'))
    : prepareSdkUpgradeBackup(resolvedSdk, resolvedStage, resolvedBackup, platform, arch);

  const stagedSet = new Set(meta.stagedFiles);

  // Remove only files that were owned by the previous SDK release and are no longer in the new release.
  for (const rel of meta.backedUpFiles) {
    if (!stagedSet.has(rel)) {
      const target = join(resolvedSdk, rel);
      if (existsSync(target) && lstatSync(target).isFile()) {
        withBoundedFsRetries(() => unlinkSync(target));
        pruneEmptyManagedDirs(resolvedSdk, rel);
      }
    }
  }

  // Copy all staged SDK files individually so custom consumer files in shared directories remain untouched.
  for (const rel of meta.stagedFiles) {
    const src = join(resolvedStage, rel);
    const dst = join(resolvedSdk, rel);
    const srcStat = lstatSync(src);
    if (!srcStat.isFile()) continue;
    if (existsSync(dst) && lstatSync(dst).isDirectory()) {
      throw new Error(`无法覆盖目标路径（存在同名目录）：${rel}`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    withBoundedFsRetries(() => cpSync(src, dst, { force: true }));
    try {
      chmodSync(dst, (srcStat.mode & 0o111) ? 0o755 : 0o644);
    } catch {}
  }

  if (existsSync(stagedToolsDir)) {
    const existingToolsDir = join(resolvedSdk, toolsRelPath);
    removeTreeWithRetries(existingToolsDir);
    mkdirSync(dirname(existingToolsDir), { recursive: true });
    withBoundedFsRetries(() => cpSync(stagedToolsDir, existingToolsDir, { recursive: true, force: true }));
  }

  const manifestPath = join(resolvedSdk, '.pocket-build', SDK_MANIFEST_FILENAME);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify({ files: meta.stagedFiles, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export function restoreBackedUpSdkFiles(sdkRoot, backupRoot, platform = process.platform, arch = process.arch) {
  const resolvedSdk = resolve(sdkRoot);
  const resolvedBackup = resolve(backupRoot);
  if (!isSdkBackupComplete(resolvedBackup)) {
    throw new Error(`备份未完成或元数据缺失，拒绝执行破坏性回滚：${resolvedBackup}`);
  }
  const meta = JSON.parse(readFileSync(join(resolvedBackup, BACKUP_META_FILENAME), 'utf8'));
  const tuple = meta.platformTuple || `${platform}-${arch}`;
  const toolsRelPath = join('node_modules', '@pocket', `tools-${tuple}`);
  const backupSdkDir = join(resolvedBackup, 'sdk');

  // Remove any newly introduced staged files that did not exist before the upgrade.
  for (const rel of meta.absentBeforeUpgrade || []) {
    const target = join(resolvedSdk, rel);
    if (existsSync(target) && lstatSync(target).isFile()) {
      withBoundedFsRetries(() => unlinkSync(target));
      pruneEmptyManagedDirs(resolvedSdk, rel);
    }
  }

  // Restore every file that was backed up before mutation.
  for (const rel of meta.backedUpFiles || []) {
    const saved = join(backupSdkDir, rel);
    const target = join(resolvedSdk, rel);
    if (existsSync(saved) && lstatSync(saved).isFile()) {
      mkdirSync(dirname(target), { recursive: true });
      withBoundedFsRetries(() => cpSync(saved, target, { force: true }));
    }
  }

  const savedManifest = join(resolvedBackup, SDK_MANIFEST_FILENAME);
  const manifestPath = join(resolvedSdk, '.pocket-build', SDK_MANIFEST_FILENAME);
  if (existsSync(savedManifest)) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    withBoundedFsRetries(() => cpSync(savedManifest, manifestPath, { force: true }));
  } else {
    rmSync(manifestPath, { force: true });
  }

  const backupToolsDir = join(resolvedBackup, 'tools');
  const existingToolsDir = join(resolvedSdk, toolsRelPath);
  if (meta.hadToolsDir && existsSync(backupToolsDir)) {
    removeTreeWithRetries(existingToolsDir);
    mkdirSync(dirname(existingToolsDir), { recursive: true });
    withBoundedFsRetries(() => cpSync(backupToolsDir, existingToolsDir, { recursive: true, force: true }));
  }
}

export function recoverInterruptedSdkUpgrade(sdkRoot, platform = process.platform, arch = process.arch) {
  const resolvedSdk = resolve(sdkRoot);
  const buildDir = join(resolvedSdk, '.pocket-build');
  if (!existsSync(buildDir) || isUpgradeApplyLockActive(resolvedSdk)) return null;
  const entries = readdirSync(buildDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('sdk-upgrade-backup-')) continue;
    const backupDir = join(buildDir, entry.name);
    if (!isSdkBackupComplete(backupDir)) {
      removeTreeWithRetries(backupDir);
      continue;
    }
    const meta = JSON.parse(readFileSync(join(backupDir, BACKUP_META_FILENAME), 'utf8'));
    restoreBackedUpSdkFiles(resolvedSdk, backupDir, platform, arch);
    removeTreeWithRetries(backupDir);
    const persisted = readPersistedUpgradeStatus(resolvedSdk);
    const targetVersion = persisted?.targetVersion || persisted?.latestVersion || null;
    writePersistedUpgradeStatus(resolvedSdk, {
      status: 'error',
      previousVersion: meta.previousVersion,
      currentVersion: meta.previousVersion,
      latestVersion: targetVersion,
      rolledBack: true,
      error: `检测到上次升级（目标 v${targetVersion || 'unknown'}）中断，已在服务启动前自动恢复到 v${meta.previousVersion}`,
      updatedAt: new Date().toISOString(),
    });
    return { restoredVersion: meta.previousVersion, targetVersion };
  }
  return null;
}

export function computeSha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function spawnDetachedServiceUpgrade(sdkRoot, stageDir, targetVersion, handoffToken) {
  const resolvedRoot = resolve(sdkRoot);
  const resolvedStage = resolve(stageDir);
  const serviceScript = join(resolvedRoot, 'scripts', 'editor_service.mjs');
  const logFile = join(resolvedRoot, '.pocket-build', 'editor-service-8791.log');
  mkdirSync(dirname(logFile), { recursive: true });
  const logFd = openSync(logFile, 'a');
  const args = [
    serviceScript,
    'upgrade-apply',
    `--stage-dir=${resolvedStage}`,
    `--target-version=${targetVersion}`,
    ...(handoffToken ? [`--handoff-token=${handoffToken}`] : []),
  ];
  let child;
  try {
    child = spawn(
      process.execPath,
      args,
      {
        cwd: resolvedRoot,
        detached: true,
        windowsHide: true,
        env: {
          ...process.env,
          ...(handoffToken ? { POCKET_UPGRADE_HANDOFF_TOKEN: handoffToken } : {}),
        },
        stdio: ['ignore', logFd, logFd],
      },
    );
  } finally {
    closeSync(logFd);
  }
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', (err) => rejectSpawn(new Error(`无法启动独立升级进程：${err.message}`)));
  });
  child.unref();
}

export function createStudioUpgradeManager(options = {}) {
  const sdkRoot = resolve(options.sdkRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const checkTimeoutMs = options.checkTimeoutMs ?? RELEASE_CHECK_TIMEOUT_MS;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? RELEASE_DOWNLOAD_TIMEOUT_MS;
  const maxReleaseJsonBytes = options.maxReleaseJsonBytes ?? MAX_RELEASE_JSON_BYTES;
  const maxSha256Bytes = options.maxSha256Bytes ?? MAX_SHA256_BYTES;
  const maxArchiveBytes = options.maxArchiveBytes ?? MAX_ARCHIVE_DOWNLOAD_BYTES;
  const allowLoopbackHttp = Boolean(options.allowLoopbackHttp ?? process.env.POCKET_STUDIO_UPGRADE_ALLOW_LOOPBACK === '1');
  const getReleasesUrl = () => options.releasesUrl || process.env.POCKET_STUDIO_UPGRADE_RELEASES_URL || DEFAULT_GITHUB_RELEASES_URL;
  const canApplyUpgrade = typeof options.canApplyUpgrade === 'function' ? options.canApplyUpgrade : null;
  const triggerServiceUpgrade = options.triggerServiceUpgrade
    ?? (({ stageDir, targetVersion, handoffToken }) => spawnDetachedServiceUpgrade(sdkRoot, stageDir, targetVersion, handoffToken));

  const installedInitial = readInstalledSdkInfo(sdkRoot, platform, arch);
  const persistedInitial = readPersistedUpgradeStatus(sdkRoot);

  const state = {
    currentVersion: installedInitial.currentVersion,
    latestVersion: persistedInitial?.latestVersion ?? null,
    targetVersion: null,
    mode: installedInitial.mode,
    modeReason: installedInitial.modeReason,
    autoUpgradeSupported: installedInitial.autoUpgradeSupported,
    platformTuple: installedInitial.platformTuple,
    status: persistedInitial?.status === 'error' ? 'error' : 'idle',
    upgradeAvailable: false,
    deferredReason: null,
    releaseUrl: null,
    archiveName: null,
    checkedAt: persistedInitial?.appliedAt ?? persistedInitial?.updatedAt ?? null,
    appliedAt: persistedInitial?.appliedAt ?? null,
    rolledBack: Boolean(persistedInitial?.rolledBack),
    error: persistedInitial?.status === 'error' ? persistedInitial.error : null,
  };

  let inFlightCheckPromise = null;
  let inFlightApplyPromise = null;
  let cachedReleaseCandidate = null;

  function evaluateCanApply() {
    if (!canApplyUpgrade) return { allowed: true, reason: null };
    try {
      const verdict = canApplyUpgrade();
      if (typeof verdict === 'boolean') {
        return { allowed: verdict, reason: verdict ? null : '当前 Studio 有正在执行的构建、保存、发布或部署任务，已暂缓应用更新' };
      }
      if (verdict && typeof verdict === 'object') {
        const allowed = verdict.allowed !== false;
        return {
          allowed,
          reason: allowed ? null : (typeof verdict.reason === 'string' && verdict.reason ? verdict.reason : '当前 Studio 有正在执行的项目操作，已暂缓应用更新'),
        };
      }
    } catch {}
    return { allowed: true, reason: null };
  }

  function syncFromDiskAndEnvironment() {
    const info = readInstalledSdkInfo(sdkRoot, platform, arch);
    state.currentVersion = info.currentVersion;
    state.mode = info.mode;
    state.modeReason = info.modeReason;
    state.autoUpgradeSupported = info.autoUpgradeSupported;
    state.platformTuple = info.platformTuple;
    if (state.latestVersion && parseStableSemver(state.latestVersion) && parseStableSemver(state.currentVersion)) {
      state.upgradeAvailable = compareStableSemver(state.latestVersion, state.currentVersion) > 0;
    } else {
      state.upgradeAvailable = false;
    }
    const persisted = readPersistedUpgradeStatus(sdkRoot);
    if (persisted?.status === 'restarting' && isUpgradeApplyLockActive(sdkRoot)) {
      state.status = 'restarting';
      state.targetVersion = persisted.targetVersion || persisted.latestVersion || state.targetVersion;
      state.error = null;
      state.deferredReason = null;
    } else if (persisted?.status === 'error' && persisted.error && !inFlightCheckPromise && !inFlightApplyPromise) {
      state.status = 'error';
      state.error = persisted.error;
      state.rolledBack = Boolean(persisted.rolledBack);
      if (persisted.latestVersion) state.latestVersion = persisted.latestVersion;
    } else if (persisted?.status === 'up-to-date' && persisted.currentVersion === state.currentVersion && state.status === 'restarting') {
      state.status = 'up-to-date';
      state.error = null;
      state.rolledBack = false;
      state.deferredReason = null;
    }
  }

  function snapshot() {
    syncFromDiskAndEnvironment();
    return { ...state };
  }

  async function fetchReleaseCandidate() {
    const url = validateReleaseOriginUrl(getReleasesUrl(), { allowLoopbackHttp });
    const response = await fetchImpl(url.toString(), {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `pocket-studio/${state.currentVersion}`,
      },
      signal: AbortSignal.timeout(checkTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`检查 GitHub Release 失败（HTTP ${response.status}）`);
    }
    const rawBytes = await readBoundedResponseBytes(response, maxReleaseJsonBytes, 'GitHub Release 列表');
    let parsed;
    try {
      parsed = JSON.parse(rawBytes.toString('utf8'));
    } catch {
      throw new Error('GitHub Release 响应不是有效 JSON');
    }
    return selectLatestStableRelease(parsed, platform, arch, { allowLoopbackHttp });
  }

  async function performApply(candidateOverride = null) {
    if (inFlightApplyPromise) return inFlightApplyPromise;
    if (isUpgradeApplyLockActive(sdkRoot)) {
      syncFromDiskAndEnvironment();
      state.status = 'restarting';
      return { ...state };
    }
    inFlightApplyPromise = (async () => {
      syncFromDiskAndEnvironment();
      if (state.mode !== 'standalone' || !state.autoUpgradeSupported) {
        const msg = '当前为源码检出模式，仅支持检查新版本，禁止自动覆盖 Git 工作区';
        state.status = state.upgradeAvailable ? 'available' : state.status;
        const err = new Error(msg);
        err.status = 409;
        throw err;
      }
      const admission = evaluateCanApply();
      if (!admission.allowed) {
        const msg = admission.reason || '当前 Studio 正在执行构建、保存、发布或部署任务，请稍后应用更新';
        state.deferredReason = msg;
        if (state.upgradeAvailable) state.status = 'available';
        const err = new Error(msg);
        err.status = 409;
        throw err;
      }
      state.deferredReason = null;
      const candidate = candidateOverride || cachedReleaseCandidate || await fetchReleaseCandidate();
      if (!candidate) {
        throw new Error('未找到可用的稳定版 SDK 发布');
      }
      cachedReleaseCandidate = candidate;
      state.latestVersion = candidate.version;
      state.releaseUrl = candidate.releaseUrl;
      state.archiveName = candidate.archiveName;
      state.upgradeAvailable = compareStableSemver(candidate.version, state.currentVersion) > 0;
      if (!state.upgradeAvailable) {
        state.status = 'up-to-date';
        state.error = null;
        return snapshot();
      }
      if (!candidate.hasMatchingPlatformAsset || !candidate.archiveUrl || !candidate.checksumUrl) {
        throw new Error(`发布 v${candidate.version} 缺少当前平台（${state.platformTuple}）的独立 Web SDK 归档或 SHA-256 校验文件`);
      }

      const targetVersion = candidate.version;
      const stageDir = resolve(sdkRoot, '.pocket-build', `sdk-upgrade-stage-${targetVersion}`);
      const handoffToken = randomUUID();
      const releaseLock = acquireUpgradeApplyLock(sdkRoot, {
        phase: 'downloading',
        targetVersion,
        stageDir,
        handoffToken,
      });
      let handedOffToChild = false;
      state.status = 'downloading';
      state.targetVersion = targetVersion;
      state.error = null;
      state.rolledBack = false;

      try {
        const checksumUrl = validateReleaseOriginUrl(candidate.checksumUrl, { allowLoopbackHttp });
        const archiveUrl = validateReleaseOriginUrl(candidate.archiveUrl, { allowLoopbackHttp });

        const checksumResp = await fetchImpl(checksumUrl.toString(), {
          headers: { 'user-agent': `pocket-studio/${state.currentVersion}` },
          signal: AbortSignal.timeout(checkTimeoutMs),
        });
        if (!checksumResp.ok) {
          throw new Error(`下载 SHA-256 校验文件失败（HTTP ${checksumResp.status}）`);
        }
        const checksumBytes = await readBoundedResponseBytes(checksumResp, maxSha256Bytes, 'SHA-256 校验文件');
        const expectedSha256 = parseSha256File(checksumBytes.toString('utf8'), candidate.archiveName);

        const archiveResp = await fetchImpl(archiveUrl.toString(), {
          headers: { 'user-agent': `pocket-studio/${state.currentVersion}` },
          signal: AbortSignal.timeout(downloadTimeoutMs),
        });
        if (!archiveResp.ok) {
          throw new Error(`下载 SDK 升级包失败（HTTP ${archiveResp.status}）`);
        }
        const archiveBytes = await readBoundedResponseBytes(archiveResp, maxArchiveBytes, 'SDK 升级归档');
        const actualSha256 = computeSha256Hex(archiveBytes);
        if (actualSha256 !== expectedSha256) {
          throw new Error(`SDK 升级包 SHA-256 校验失败：期望 ${expectedSha256}，实际 ${actualSha256}`);
        }

        // Re-check admission right before staging/spawning in case a project operation started during download
        const preSpawnAdmission = evaluateCanApply();
        if (!preSpawnAdmission.allowed) {
          const msg = preSpawnAdmission.reason || '当前 Studio 正在执行构建、保存、发布或部署任务，请稍后应用更新';
          state.deferredReason = msg;
          state.status = 'available';
          const err = new Error(msg);
          err.status = 409;
          throw err;
        }

        state.status = 'applying';
        removeTreeWithRetries(stageDir);
        extractSafeTarGz(archiveBytes, stageDir, { stripTopLevelPackage: true });
        validateStagedStandaloneSdk(stageDir, targetVersion, platform, arch);

        state.status = 'restarting';
        writePersistedUpgradeStatus(sdkRoot, {
          status: 'restarting',
          previousVersion: state.currentVersion,
          currentVersion: state.currentVersion,
          latestVersion: targetVersion,
          targetVersion,
          updatedAt: new Date().toISOString(),
          rolledBack: false,
          error: null,
        });
        releaseLock.update({
          phase: 'spawning',
          targetVersion,
          stageDir,
          handoffToken,
        });
        await triggerServiceUpgrade({ sdkRoot, stageDir, targetVersion, handoffToken });
        handedOffToChild = true;
        return { ...state };
      } catch (error) {
        handedOffToChild = false;
        removeTreeWithRetries(stageDir);
        if (error?.status === 409 && state.deferredReason) {
          state.status = 'available';
          state.error = null;
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        state.status = 'error';
        state.error = message;
        writePersistedUpgradeStatus(sdkRoot, {
          status: 'error',
          previousVersion: state.currentVersion,
          currentVersion: state.currentVersion,
          latestVersion: targetVersion,
          rolledBack: false,
          error: message,
          updatedAt: new Date().toISOString(),
        });
        throw error;
      } finally {
        if (!handedOffToChild) releaseLock();
      }
    })().finally(() => {
      inFlightApplyPromise = null;
    });
    return inFlightApplyPromise;
  }

  async function check(checkOptions = {}) {
    const autoApply = checkOptions.autoApply !== false;
    if (inFlightApplyPromise) return inFlightApplyPromise;
    if (isUpgradeApplyLockActive(sdkRoot)) return snapshot();
    if (inFlightCheckPromise) return inFlightCheckPromise;

    inFlightCheckPromise = (async () => {
      syncFromDiskAndEnvironment();
      const previousError = state.rolledBack ? state.error : null;
      state.status = 'checking';
      state.error = null;
      state.deferredReason = null;
      try {
        const candidate = await fetchReleaseCandidate();
        cachedReleaseCandidate = candidate;
        state.checkedAt = new Date().toISOString();
        if (!candidate) {
          state.latestVersion = state.currentVersion;
          state.upgradeAvailable = false;
          state.status = 'up-to-date';
          return snapshot();
        }
        state.latestVersion = candidate.version;
        state.releaseUrl = candidate.releaseUrl;
        state.archiveName = candidate.archiveName;
        state.upgradeAvailable = compareStableSemver(candidate.version, state.currentVersion) > 0;
        if (!state.upgradeAvailable) {
          state.status = 'up-to-date';
          state.rolledBack = false;
          state.error = null;
          return snapshot();
        }
        if (!candidate.hasMatchingPlatformAsset) {
          throw new Error(`发现新版本 v${candidate.version}，但缺少当前平台（${state.platformTuple}）的独立 Web SDK 归档或校验文件`);
        }
        state.status = 'available';
        if (state.mode === 'standalone' && state.autoUpgradeSupported && autoApply) {
          const persisted = readPersistedUpgradeStatus(sdkRoot);
          if (persisted?.rolledBack && persisted?.latestVersion === candidate.version && !checkOptions.forceApply) {
            state.status = 'error';
            state.rolledBack = true;
            state.error = persisted.error || previousError || `升级到 v${candidate.version} 失败并已自动回滚`;
            return snapshot();
          }
          const admission = evaluateCanApply();
          if (!admission.allowed) {
            state.deferredReason = admission.reason;
            state.status = 'available';
            return snapshot();
          }
          return await performApply(candidate);
        }
        return snapshot();
      } catch (error) {
        if (error?.status === 409 && state.deferredReason) {
          state.checkedAt = new Date().toISOString();
          state.status = 'available';
          state.error = null;
          return snapshot();
        }
        const message = error instanceof Error ? error.message : String(error);
        state.checkedAt = new Date().toISOString();
        state.status = 'error';
        state.error = message;
        return snapshot();
      }
    })().finally(() => {
      inFlightCheckPromise = null;
    });
    return inFlightCheckPromise;
  }

  return {
    status: () => snapshot(),
    check,
    apply: () => performApply(),
  };
}
