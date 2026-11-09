/**
 * Source snapshots for Pocket Studio projects.
 *
 * Backups are ordinary directories outside the project tree. Each manifest
 * binds every copied source/asset file to its size and SHA-256 digest. Restore
 * validates and stages the complete snapshot before touching project files.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const BACKUP_FORMAT = "pocket-editor-project-backup";
const BACKUP_VERSION = 1;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const BACKUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_BACKUPS_PER_PROJECT = 20;
const MAX_FILES = 20_000;
const MAX_DIRECTORIES = 20_000;
const MAX_TREE_ENTRIES = MAX_FILES + MAX_DIRECTORIES;
const MAX_BACKUP_STORAGE_ENTRIES = 128;
const MAX_PATH_BYTES = 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const COPY_CHUNK_BYTES = 64 * 1024;
const CACHE_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", ".pocket-build", ".cache", "node_modules", ".dart_tool",
  ".next", ".turbo", ".vite", ".pytest_cache", "__pycache__",
]);
const ROOT_BUILD_DIRECTORIES = new Set(["build", "builds", "dist", "out", "target", "coverage"]);
const ROOT_GENERATED_FILES = new Set(["app.qjbc", "app.pak", "app.bytecode.json"]);
const fsyncDirectoryFlag = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0);
const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;

export interface NovelBackupOptions {
  /** Editor workspace root; snapshots are stored below `backups/<projectId>`. */
  readonly workspaceRoot: string;
  /** The authorized project directory selected by the Editor server. */
  readonly projectRoot: string;
  readonly projectId: string;
  /** Reuse the newest complete snapshot when every path, byte and digest matches. */
  readonly skipUnchanged?: boolean;
}

export interface NovelBackupSummary {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Listing validates the manifest. Payload hashes are checked before restore. */
  readonly manifestValid: boolean;
  readonly error?: string;
}

export interface NovelBackupRestoreResult {
  readonly restored: NovelBackupSummary;
  /** A fresh snapshot of the project immediately before restore. */
  readonly recoveryBackupId: string;
  readonly restoredFiles: number;
  readonly removedFiles: number;
}

export interface NovelBackupFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  /** Permission bits only; ownership and timestamps are intentionally not restored. */
  readonly mode: number;
}

export interface NovelBackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly formatVersion: typeof BACKUP_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly NovelBackupFileRecord[];
}

export class NovelBackupError extends Error {
  readonly recoveryBackupId?: string;

  constructor(message: string, recoveryBackupId?: string) {
    super(message);
    this.name = "NovelBackupError";
    this.recoveryBackupId = recoveryBackupId;
  }
}

interface ProjectRoots {
  readonly projectReal: string;
  readonly workspaceRoot: string;
  readonly backupRoot: string;
}

interface ScannedFile {
  readonly path: string;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

interface ProjectScan {
  readonly files: readonly ScannedFile[];
  readonly directories: readonly string[];
  /** Excluded children that prevent a restore from replacing an ancestor. */
  readonly blockedPaths: readonly string[];
}

interface CopyResult {
  readonly size: number;
  readonly sha256: string;
}

const projectTails = new Map<string, Promise<void>>();

function isInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return false;
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/") || isAbsolute(value)) return false;
  const segments = value.split("/");
  if (segments.length > 64 || segments.some(segment => !segment || segment === "." || segment === "..")) return false;
  return true;
}

function isIgnoredDirectory(path: string): boolean {
  const segments = path.split("/");
  return segments.some((segment, index) =>
    CACHE_DIRECTORIES.has(segment.toLowerCase()) || (index === 0 && ROOT_BUILD_DIRECTORIES.has(segment.toLowerCase()))
  );
}

function isRootGeneratedFile(path: string): boolean {
  return !path.includes("/") && ROOT_GENERATED_FILES.has(path.toLowerCase());
}

function isSnapshotPath(path: string): boolean {
  if (!safeRelativePath(path) || isIgnoredDirectory(path)) return false;
  return !isRootGeneratedFile(path);
}

function checkedProjectId(value: string): string {
  if (!PROJECT_ID_PATTERN.test(value)) throw new NovelBackupError("projectId must match [a-z][a-z0-9-]{0,47}");
  return value;
}

function checkedBackupId(value: string): string {
  if (!BACKUP_ID_PATTERN.test(value)) throw new NovelBackupError("backup id is invalid");
  return value;
}

function lockKey(options: NovelBackupOptions): string {
  return `${resolve(options.workspaceRoot)}\0${resolve(options.projectRoot)}\0${options.projectId}`;
}

async function withProjectLock<T>(options: NovelBackupOptions, operation: () => Promise<T>): Promise<T> {
  const key = lockKey(options);
  const previous = projectTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const tail = previous.then(() => gate);
  projectTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (projectTails.get(key) === tail) projectTails.delete(key);
  }
}

async function lstatOrUndefined(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureDirectoryPath(root: string, parts: readonly string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes("/") || part.includes("\\") || part.includes("\0")) {
      throw new NovelBackupError("unsafe directory path");
    }
    current = join(current, part);
    let info = await lstatOrUndefined(current);
    if (!info) {
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new NovelBackupError(`directory is not a real directory: ${part}`);
  }
  return current;
}

async function validateOptionalDirectoryPath(root: string, parts: readonly string[]): Promise<void> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstatOrUndefined(current);
    if (!info) return;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new NovelBackupError("backup storage path contains a link or non-directory");
  }
}

async function resolveRoots(options: NovelBackupOptions, createWorkspace: boolean): Promise<ProjectRoots> {
  const projectId = checkedProjectId(options.projectId);
  const projectRoot = resolve(options.projectRoot);
  const projectInfo = await lstatOrUndefined(projectRoot);
  if (!projectInfo || projectInfo.isSymbolicLink() || !projectInfo.isDirectory()) {
    throw new NovelBackupError("project root must be an existing real directory");
  }
  const projectReal = await realpath(projectRoot);
  const workspaceRoot = resolve(options.workspaceRoot);
  if (isInside(projectReal, workspaceRoot)) {
    throw new NovelBackupError("Editor workspace must be outside the project tree");
  }
  if (createWorkspace) await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const workspaceInfo = await lstatOrUndefined(workspaceRoot);
  if (!workspaceInfo) return { projectReal, workspaceRoot, backupRoot: join(workspaceRoot, "backups", projectId) };
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new NovelBackupError("Editor workspace must be a real directory");
  const workspaceReal = await realpath(workspaceRoot);
  if (isInside(projectReal, workspaceReal)) throw new NovelBackupError("Editor workspace resolves inside the project tree");
  const backupRoot = join(workspaceReal, "backups", projectId);
  if (isInside(projectReal, backupRoot) || isInside(backupRoot, projectReal)) {
    throw new NovelBackupError("backup storage overlaps the project tree");
  }
  if (createWorkspace) {
    const backupParent = await ensureDirectoryPath(workspaceReal, ["backups"]);
    await ensureDirectoryPath(backupParent, [projectId]);
  } else await validateOptionalDirectoryPath(workspaceReal, ["backups", projectId]);
  return { projectReal, workspaceRoot: workspaceReal, backupRoot };
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsyncDirectoryFlag);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function scanProject(projectRoot: string): Promise<ProjectScan> {
  const files: ScannedFile[] = [];
  const directories: string[] = [];
  const blockedPaths: string[] = [];
  let totalBytes = 0;
  let visitedEntries = 0;
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      visitedEntries += 1;
      if (visitedEntries > MAX_TREE_ENTRIES) throw new NovelBackupError(`project contains more than ${MAX_TREE_ENTRIES} files and directories`);
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const ignoredDirectory = CACHE_DIRECTORIES.has(entry.name.toLowerCase()) ||
        (!relativeDirectory && ROOT_BUILD_DIRECTORIES.has(entry.name.toLowerCase()));
      if (entry.isDirectory() && ignoredDirectory) {
        blockedPaths.push(path);
        continue;
      }
      if (entry.isSymbolicLink() && ignoredDirectory) {
        // Known dependency/cache symlinks remain untouched and are never read.
        blockedPaths.push(path);
        continue;
      }
      if (entry.isSymbolicLink()) throw new NovelBackupError(`project contains an unsupported symbolic link: ${path}`);
      if (!safeRelativePath(path)) throw new NovelBackupError("project path exceeds the backup path limit");
      if (entry.isDirectory()) {
        directories.push(path);
        if (directories.length > MAX_DIRECTORIES) throw new NovelBackupError(`project contains more than ${MAX_DIRECTORIES} directories`);
        await walk(join(directory, entry.name), path);
        continue;
      }
      if (!entry.isFile()) throw new NovelBackupError(`project contains a non-regular file: ${path}`);
      if (isRootGeneratedFile(path)) {
        blockedPaths.push(path);
        continue;
      }
      const fullPath = join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new NovelBackupError(`project file changed during scan: ${path}`);
      if (info.size > MAX_FILE_BYTES) throw new NovelBackupError(`project file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new NovelBackupError(`project source exceeds the ${MAX_TOTAL_BYTES}-byte backup limit`);
      files.push({ path, size: info.size, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs, mode: info.mode & 0o777 });
      if (files.length > MAX_FILES) throw new NovelBackupError(`project contains more than ${MAX_FILES} source files`);
    }
  };
  await walk(projectRoot, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort((a, b) => a.localeCompare(b));
  blockedPaths.sort((a, b) => a.localeCompare(b));
  return { files, directories, blockedPaths };
}

function compareScan(left: ProjectScan, right: ProjectScan): boolean {
  if (left.files.length !== right.files.length) return false;
  return left.files.every((file, index) => {
    const next = right.files[index];
    return next?.path === file.path && next.size === file.size && next.dev === file.dev && next.ino === file.ino && next.mtimeMs === file.mtimeMs && next.mode === file.mode;
  });
}

async function copyFileNoFollow(
  source: string,
  destination: string,
  options: {
    readonly expectedSize?: number;
    readonly expectedHash?: string;
    readonly expectedSource?: ScannedFile;
    readonly maxBytes: number;
  },
): Promise<CopyResult> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new NovelBackupError("backup input is not a regular file");
  if (options.expectedSource && (
    sourceInfo.size !== options.expectedSource.size || sourceInfo.dev !== options.expectedSource.dev ||
    sourceInfo.ino !== options.expectedSource.ino || sourceInfo.mtimeMs !== options.expectedSource.mtimeMs ||
    (sourceInfo.mode & 0o777) !== options.expectedSource.mode
  )) throw new NovelBackupError(`project file changed while copying: ${options.expectedSource.path}`);
  const input = await open(source, fsConstants.O_RDONLY | noFollowFlag);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > options.maxBytes) throw new NovelBackupError("backup file exceeds its size limit");
    if (options.expectedSize !== undefined && before.size !== options.expectedSize) throw new NovelBackupError("backup file size does not match its manifest");
    output = await open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > options.maxBytes) throw new NovelBackupError("backup file exceeds its size limit");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, null);
        if (result.bytesWritten <= 0) throw new NovelBackupError("backup file write made no progress");
        written += result.bytesWritten;
      }
    }
    const after = await input.stat();
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new NovelBackupError("backup file changed while it was being read");
    }
    if (options.expectedSource && (before.size !== options.expectedSource.size || before.dev !== options.expectedSource.dev || before.ino !== options.expectedSource.ino || before.mtimeMs !== options.expectedSource.mtimeMs || (before.mode & 0o777) !== options.expectedSource.mode)) {
      throw new NovelBackupError(`project file changed while copying: ${options.expectedSource.path}`);
    }
    if (options.expectedSize !== undefined && total !== options.expectedSize) throw new NovelBackupError("backup file size does not match its manifest");
    const sha256 = hash.digest("hex");
    if (options.expectedHash !== undefined && sha256 !== options.expectedHash) throw new NovelBackupError("backup file hash does not match its manifest");
    await output.sync();
    return { size: total, sha256 };
  } catch (error) {
    await output?.close().catch(() => undefined);
    output = undefined;
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await input.close().catch(() => undefined);
    await output?.close();
  }
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFileNoFollow(path: string, expected: NovelBackupFileRecord, label = "backup payload"): Promise<void> {
  const beforePath = await lstat(path);
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.size !== expected.size) {
    throw new NovelBackupError(`${label} file has an invalid type or size: ${expected.path}`);
  }
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expected.size || total > MAX_FILE_BYTES) throw new NovelBackupError(`${label} file exceeds its size: ${expected.path}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (total !== expected.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) {
      throw new NovelBackupError(`${label} file changed while being verified: ${expected.path}`);
    }
    if (hash.digest("hex") !== expected.sha256) throw new NovelBackupError(`${label} hash does not match: ${expected.path}`);
  } finally {
    await handle.close();
  }
}

function validateManifest(value: unknown, expectedProjectId: string, expectedId?: string): NovelBackupManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NovelBackupError("backup manifest must be an object");
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "createdAt,fileCount,files,format,formatVersion,id,projectId,totalBytes") throw new NovelBackupError("backup manifest has unknown or missing fields");
  if (raw.format !== BACKUP_FORMAT || raw.formatVersion !== BACKUP_VERSION) throw new NovelBackupError("backup format is unsupported");
  if (typeof raw.id !== "string" || !BACKUP_ID_PATTERN.test(raw.id) || (expectedId !== undefined && raw.id !== expectedId)) throw new NovelBackupError("backup manifest id is invalid");
  if (raw.projectId !== expectedProjectId) throw new NovelBackupError("backup belongs to a different project");
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) throw new NovelBackupError("backup timestamp is invalid");
  if (!Number.isSafeInteger(raw.fileCount) || Number(raw.fileCount) < 0 || Number(raw.fileCount) > MAX_FILES) throw new NovelBackupError("backup file count is invalid");
  if (!Number.isSafeInteger(raw.totalBytes) || Number(raw.totalBytes) < 0 || Number(raw.totalBytes) > MAX_TOTAL_BYTES) throw new NovelBackupError("backup size is invalid");
  if (!Array.isArray(raw.files) || raw.files.length !== raw.fileCount || raw.files.length > MAX_FILES) throw new NovelBackupError("backup manifest file list is invalid");
  let totalBytes = 0;
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const files: NovelBackupFileRecord[] = [];
  for (const item of raw.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new NovelBackupError("backup file entry is invalid");
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "mode,path,sha256,size") throw new NovelBackupError("backup file entry has unknown or missing fields");
    if (!safeRelativePath(record.path) || !isSnapshotPath(record.path)) throw new NovelBackupError("backup manifest contains an unsafe or excluded path");
    if (!Number.isSafeInteger(record.size) || Number(record.size) < 0 || Number(record.size) > MAX_FILE_BYTES) throw new NovelBackupError(`backup file size is invalid: ${String(record.path)}`);
    if (!Number.isSafeInteger(record.mode) || Number(record.mode) < 0 || Number(record.mode) > 0o777) throw new NovelBackupError(`backup file mode is invalid: ${String(record.path)}`);
    if (typeof record.sha256 !== "string" || !SHA256_PATTERN.test(record.sha256)) throw new NovelBackupError(`backup file digest is invalid: ${String(record.path)}`);
    const path = record.path;
    const folded = path.toLowerCase();
    if (paths.has(path) || foldedPaths.has(folded)) throw new NovelBackupError(`backup manifest repeats a path: ${path}`);
    paths.add(path);
    foldedPaths.add(folded);
    totalBytes += Number(record.size);
    if (totalBytes > MAX_TOTAL_BYTES) throw new NovelBackupError("backup manifest exceeds the size limit");
    files.push({ path, size: Number(record.size), sha256: record.sha256, mode: Number(record.mode) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const foldedPrefixes = new Map<string, string>();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      const folded = prefix.toLowerCase();
      const previous = foldedPrefixes.get(folded);
      if (previous !== undefined && previous !== prefix) throw new NovelBackupError("backup manifest has a case-colliding path");
      foldedPrefixes.set(folded, prefix);
      if (i < segments.length && paths.has(prefix)) throw new NovelBackupError("backup manifest has a file/directory path collision");
    }
  }
  if (totalBytes !== raw.totalBytes) throw new NovelBackupError("backup manifest total size does not match its file list");
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    id: raw.id,
    projectId: expectedProjectId,
    createdAt: raw.createdAt,
    fileCount: files.length,
    totalBytes,
    files,
  };
}

async function readManifest(backupDirectory: string, projectId: string, backupId: string): Promise<NovelBackupManifest> {
  const directoryInfo = await lstat(backupDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new NovelBackupError("backup directory is not a real directory");
  const manifestPath = join(backupDirectory, "manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > MAX_MANIFEST_BYTES) {
    throw new NovelBackupError("backup manifest is missing, linked, or too large");
  }
  let parsed: unknown;
  try {
    const handle = await open(manifestPath, fsConstants.O_RDONLY | noFollowFlag);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) throw new NovelBackupError("backup manifest exceeds its size limit");
      parsed = JSON.parse(await handle.readFile("utf8"));
    }
    finally { await handle.close(); }
  }
  catch (error) { throw new NovelBackupError(`backup manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
  return validateManifest(parsed, projectId, backupId);
}

async function verifyBackupPayload(roots: ProjectRoots, manifest: NovelBackupManifest, verifyHashes: boolean): Promise<void> {
  const payloadRoot = join(roots.backupRoot, manifest.id, "files");
  const payloadInfo = await lstat(payloadRoot);
  if (payloadInfo.isSymbolicLink() || !payloadInfo.isDirectory()) throw new NovelBackupError("backup payload directory is missing or linked");
  const expectedFiles = new Map(manifest.files.map(file => [file.path, file]));
  const expectedDirectories = new Set<string>();
  for (const file of manifest.files) {
    const segments = file.path.split("/");
    for (let i = 1; i < segments.length; i++) expectedDirectories.add(segments.slice(0, i).join("/"));
  }
  const seenFiles = new Set<string>();
  let totalBytes = 0;
  let visitedEntries = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      visitedEntries += 1;
      if (visitedEntries > MAX_TREE_ENTRIES) throw new NovelBackupError("backup payload has too many files and directories");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeRelativePath(path)) throw new NovelBackupError("backup payload contains an unsafe path");
      const fullPath = join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new NovelBackupError(`backup payload contains a symlink: ${path}`);
      if (entry.isDirectory() && info.isDirectory()) {
        if (!expectedDirectories.has(path)) throw new NovelBackupError(`backup payload contains an unmanifested directory: ${path}`);
        await walk(fullPath, path);
        continue;
      }
      if (!entry.isFile() || !info.isFile()) throw new NovelBackupError(`backup payload contains a non-regular file: ${path}`);
      const record = expectedFiles.get(path);
      if (!record || seenFiles.has(path)) throw new NovelBackupError(`backup payload contains an unmanifested file: ${path}`);
      if (info.size > MAX_FILE_BYTES) throw new NovelBackupError(`backup payload file exceeds its limit: ${path}`);
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new NovelBackupError("backup payload exceeds its total size limit");
      seenFiles.add(path);
      if (verifyHashes) await hashFileNoFollow(fullPath, record);
    }
  };
  await walk(payloadRoot, "");
  if (seenFiles.size !== manifest.files.length || totalBytes !== manifest.totalBytes) {
    throw new NovelBackupError("backup payload does not match its manifest file list");
  }
}

async function listDirectories(root: string): Promise<Array<{ id: string; path: string; modifiedAt: number }>> {
  const rootInfo = await lstatOrUndefined(root);
  if (!rootInfo) return [];
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new NovelBackupError("backup storage root is not a real directory");
  const result: Array<{ id: string; path: string; modifiedAt: number }> = [];
  let entries = 0;
  const handle = await opendir(root);
  for await (const entry of handle) {
    entries += 1;
    if (entries > MAX_BACKUP_STORAGE_ENTRIES) throw new NovelBackupError("backup storage contains too many entries");
    if (!BACKUP_ID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    result.push({ id: entry.name, path, modifiedAt: info.mtimeMs });
  }
  return result;
}

function summaryFromManifest(manifest: NovelBackupManifest, manifestValid = true, error?: string): NovelBackupSummary {
  return {
    id: manifest.id,
    projectId: manifest.projectId,
    createdAt: manifest.createdAt,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    manifestValid,
    ...(error ? { error } : {}),
  };
}

async function listBackupsUnlocked(options: NovelBackupOptions): Promise<readonly NovelBackupSummary[]> {
  const roots = await resolveRoots(options, false);
  const directories = await listDirectories(roots.backupRoot);
  const summaries: NovelBackupSummary[] = [];
  for (const directory of directories) {
    try {
      const manifest = await readManifest(directory.path, options.projectId, directory.id);
      summaries.push(summaryFromManifest(manifest));
    } catch (error) {
      summaries.push({
        id: directory.id,
        projectId: options.projectId,
        createdAt: new Date(directory.modifiedAt).toISOString(),
        fileCount: 0,
        totalBytes: 0,
        manifestValid: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 240),
      });
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

async function pruneBackups(backupRoot: string, protectedIds: ReadonlySet<string> = new Set()): Promise<void> {
  const directories = await listDirectories(backupRoot);
  const keepable = directories.sort((a, b) => a.modifiedAt - b.modifiedAt || a.id.localeCompare(b.id));
  let count = keepable.length;
  for (const directory of keepable) {
    if (count <= MAX_BACKUPS_PER_PROJECT) break;
    if (protectedIds.has(directory.id)) continue;
    await rm(directory.path, { recursive: true, force: true });
    count -= 1;
  }
}

function sameFileRecords(left: readonly NovelBackupFileRecord[], right: readonly NovelBackupFileRecord[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.path.localeCompare(b.path));
  const sortedRight = [...right].sort((a, b) => a.path.localeCompare(b.path));
  return sortedLeft.every((file, index) => {
    const other = sortedRight[index];
    return other?.path === file.path && other.size === file.size && other.sha256 === file.sha256 && other.mode === file.mode;
  });
}

async function findUnchangedBackup(roots: ProjectRoots, projectId: string, files: readonly NovelBackupFileRecord[]): Promise<NovelBackupSummary | undefined> {
  const directories = await listDirectories(roots.backupRoot);
  const candidates: NovelBackupManifest[] = [];
  for (const directory of directories) {
    try { candidates.push(await readManifest(directory.path, projectId, directory.id)); }
    catch { /* Keep searching older complete snapshots. */ }
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  for (const candidate of candidates) {
    if (!sameFileRecords(candidate.files, files)) continue;
    try {
      await verifyBackupPayload(roots, candidate, true);
      return summaryFromManifest(candidate);
    } catch { /* Corrupt snapshots are never reused as the latest checkpoint. */ }
  }
  return undefined;
}

async function createBackupUnlocked(options: NovelBackupOptions, protectedIds: ReadonlySet<string> = new Set()): Promise<NovelBackupSummary> {
  const roots = await resolveRoots(options, true);
  const scan = await scanProject(roots.projectReal);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const temporaryRoot = join(roots.backupRoot, `.tmp-${id}`);
  await mkdir(temporaryRoot, { mode: 0o700 });
  let committed = false;
  try {
    const payloadRoot = await ensureDirectoryPath(temporaryRoot, ["files"]);
    const fileRecords: NovelBackupFileRecord[] = [];
    let totalBytes = 0;
    for (const sourceFile of scan.files) {
      const segments = sourceFile.path.split("/");
      const destinationParent = await ensureDirectoryPath(payloadRoot, segments.slice(0, -1));
      const destination = join(destinationParent, segments.at(-1)!);
      const source = join(roots.projectReal, ...segments);
      const copied = await copyFileNoFollow(source, destination, {
        expectedSize: sourceFile.size,
        expectedSource: sourceFile,
        maxBytes: MAX_FILE_BYTES,
      });
      totalBytes += copied.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new NovelBackupError("project source exceeds the backup size limit");
      fileRecords.push({ path: sourceFile.path, size: copied.size, sha256: copied.sha256, mode: sourceFile.mode });
    }
    const afterCopy = await scanProject(roots.projectReal);
    if (!compareScan(scan, afterCopy)) throw new NovelBackupError("project source changed while the backup was being created");
    if (options.skipUnchanged) {
      const unchanged = await findUnchangedBackup(roots, options.projectId, fileRecords);
      if (unchanged) return unchanged;
    }
    const manifest: NovelBackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_VERSION,
      id,
      projectId: options.projectId,
      createdAt,
      fileCount: fileRecords.length,
      totalBytes,
      files: fileRecords,
    };
    const serialized = JSON.stringify(manifest, null, 2) + "\n";
    if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) throw new NovelBackupError("backup manifest exceeds its size limit");
    await writeJsonExclusive(join(temporaryRoot, "manifest.json"), manifest);
    const payloadDirectories = requiredTargetDirectories(new Set(fileRecords.map(file => file.path)));
    for (const directory of [...payloadDirectories].sort((a, b) => b.length - a.length)) {
      await fsyncDirectory(join(payloadRoot, ...directory.split("/")));
    }
    await fsyncDirectory(payloadRoot);
    await fsyncDirectory(temporaryRoot);
    const destination = join(roots.backupRoot, id);
    await rename(temporaryRoot, destination);
    await fsyncDirectory(roots.backupRoot);
    committed = true;
    await pruneBackups(roots.backupRoot, protectedIds);
    return summaryFromManifest(manifest);
  } finally {
    if (!committed) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function stageBackupFiles(roots: ProjectRoots, manifest: NovelBackupManifest): Promise<string> {
  const sourceRoot = join(roots.backupRoot, manifest.id);
  const payloadRoot = join(sourceRoot, "files");
  const payloadInfo = await lstat(payloadRoot);
  if (payloadInfo.isSymbolicLink() || !payloadInfo.isDirectory()) throw new NovelBackupError("backup payload directory is missing or linked");
  const stageParent = dirname(roots.projectReal);
  const stageRoot = await mkdtemp(join(stageParent, `.${basename(roots.projectReal)}.restore-`));
  let keep = false;
  try {
    await verifyBackupPayload(roots, manifest, false);
    const stagedFilesRoot = await ensureDirectoryPath(stageRoot, ["files"]);
    for (const file of manifest.files) {
      const segments = file.path.split("/");
      const sourceParent = await verifyStorageParents(payloadRoot, segments.slice(0, -1));
      const source = join(sourceParent, segments.at(-1)!);
      const destinationParent = await ensureDirectoryPath(stagedFilesRoot, segments.slice(0, -1));
      const destination = join(destinationParent, segments.at(-1)!);
      await copyFileNoFollow(source, destination, { expectedSize: file.size, expectedHash: file.sha256, maxBytes: MAX_FILE_BYTES });
    }
    keep = true;
    return stagedFilesRoot;
  } finally {
    if (!keep) await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function verifyStorageParents(root: string, parts: readonly string[]): Promise<string> {
  let current = root;
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new NovelBackupError("backup storage path is invalid");
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw new NovelBackupError("backup path is unsafe");
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new NovelBackupError("backup path contains a link or non-directory");
  }
  const rel = relative(await realpath(root), await realpath(current));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new NovelBackupError("backup path escapes its payload root");
  }
  return current;
}

function requiredTargetDirectories(paths: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) result.add(parts.slice(0, i).join("/"));
  }
  return result;
}

function preflightRestore(scan: ProjectScan, target: NovelBackupManifest): void {
  for (const file of target.files) {
    const excludedChild = scan.blockedPaths.find(path => path === file.path || path.startsWith(`${file.path}/`));
    if (excludedChild) throw new NovelBackupError(`restore path would replace excluded project data: ${excludedChild}`);
  }
}

async function writeRestoredFile(projectRoot: string, stagedFilesRoot: string, file: NovelBackupFileRecord): Promise<void> {
  const segments = file.path.split("/");
  const destinationParent = await ensureDirectoryPath(projectRoot, segments.slice(0, -1));
  const destination = join(destinationParent, segments.at(-1)!);
  const existing = await lstatOrUndefined(destination);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new NovelBackupError(`restore destination is not a regular file: ${file.path}`);
  const temporary = join(destinationParent, `.${segments.at(-1)!}.${randomUUID()}.restore-tmp`);
  const source = join(stagedFilesRoot, ...segments);
  await copyFileNoFollow(source, temporary, { expectedSize: file.size, expectedHash: file.sha256, maxBytes: MAX_FILE_BYTES });
  try {
    await chmod(temporary, file.mode & 0o777);
    await rename(temporary, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if ((code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") || !existing) throw error;
    await unlink(destination);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  const final = await lstat(destination);
  if (final.isSymbolicLink() || !final.isFile() || final.size !== file.size) throw new NovelBackupError(`restored file failed post-write checks: ${file.path}`);
  await fsyncDirectory(destinationParent);
}

async function applyBackupContents(
  roots: ProjectRoots,
  manifest: NovelBackupManifest,
  stagedFilesRoot: string,
): Promise<{ restoredFiles: number; removedFiles: number }> {
  const scan = await scanProject(roots.projectReal);
  preflightRestore(scan, manifest);
  const targetPaths = new Set(manifest.files.map(file => file.path));
  const deletions = scan.files.filter(file => !targetPaths.has(file.path) || manifest.files.some(target => target.path.startsWith(`${file.path}/`)));
  for (const file of deletions.sort((a, b) => b.path.length - a.path.length)) {
    const destination = join(roots.projectReal, ...file.path.split("/"));
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile()) throw new NovelBackupError(`project file changed before restore: ${file.path}`);
    await unlink(destination);
  }
  const requiredDirectories = requiredTargetDirectories(targetPaths);
  for (const directory of [...scan.directories].sort((a, b) => b.length - a.length)) {
    if (requiredDirectories.has(directory)) continue;
    const path = join(roots.projectReal, ...directory.split("/"));
    const info = await lstatOrUndefined(path);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new NovelBackupError(`project directory changed before restore: ${directory}`);
    try { await rmdir(path); }
    catch (error) {
      if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  for (const file of manifest.files) await writeRestoredFile(roots.projectReal, stagedFilesRoot, file);
  const finalScan = await scanProject(roots.projectReal);
  const expectedFiles = new Map(manifest.files.map(file => [file.path, file]));
  if (finalScan.files.length !== manifest.files.length || finalScan.files.some(file => !expectedFiles.has(file.path))) {
    throw new NovelBackupError("restored project tree does not match the selected backup");
  }
  for (const scanned of finalScan.files) {
    const expected = expectedFiles.get(scanned.path)!;
    if (scanned.size !== expected.size || scanned.mode !== expected.mode) {
      throw new NovelBackupError(`restored project metadata does not match the selected backup: ${scanned.path}`);
    }
    await hashFileNoFollow(join(roots.projectReal, ...scanned.path.split("/")), expected, "restored project");
  }
  return { restoredFiles: manifest.files.length, removedFiles: deletions.length };
}

async function restoreUnlocked(options: NovelBackupOptions, backupIdInput: string): Promise<NovelBackupRestoreResult> {
  const projectId = checkedProjectId(options.projectId);
  const backupId = checkedBackupId(backupIdInput);
  const roots = await resolveRoots(options, false);
  const backupDirectory = join(roots.backupRoot, backupId);
  const manifest = await readManifest(backupDirectory, projectId, backupId);
  const stagedFilesRoot = await stageBackupFiles(roots, manifest);
  const stageRoot = dirname(stagedFilesRoot);
  let recoveryBackup: NovelBackupSummary | undefined;
  try {
    preflightRestore(await scanProject(roots.projectReal), manifest);
    recoveryBackup = await createBackupUnlocked(options, new Set([backupId]));
    try {
      const afterBackupScan = await scanProject(roots.projectReal);
      preflightRestore(afterBackupScan, manifest);
      const result = await applyBackupContents(roots, manifest, stagedFilesRoot);
      return {
        restored: summaryFromManifest(manifest),
        recoveryBackupId: recoveryBackup.id,
        ...result,
      };
    } catch (restoreError) {
      const recoveryErrorPrefix = `Restore failed; pre-restore backup '${recoveryBackup.id}' is available.`;
      try {
        const recoveryDirectory = join(roots.backupRoot, recoveryBackup.id);
        const recoveryManifest = await readManifest(recoveryDirectory, projectId, recoveryBackup.id);
        const rollbackFiles = await stageBackupFiles(roots, recoveryManifest);
        try { await applyBackupContents(roots, recoveryManifest, rollbackFiles); }
        finally { await rm(dirname(rollbackFiles), { recursive: true, force: true }).catch(() => undefined); }
        throw new NovelBackupError(`${recoveryErrorPrefix} The project was rolled back. ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, recoveryBackup.id);
      } catch (rollbackError) {
        if (rollbackError instanceof NovelBackupError && rollbackError.recoveryBackupId === recoveryBackup.id && rollbackError.message.includes("The project was rolled back.")) throw rollbackError;
        throw new NovelBackupError(`${recoveryErrorPrefix} Automatic rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, recoveryBackup.id);
      }
    }
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Create a complete, content-hashed snapshot outside the project tree. */
export function createNovelBackup(options: NovelBackupOptions): Promise<NovelBackupSummary> {
  return withProjectLock(options, () => createBackupUnlocked(options));
}

/** List manifests for a project's snapshots without reading every payload. */
export function listNovelBackups(options: NovelBackupOptions): Promise<readonly NovelBackupSummary[]> {
  return withProjectLock(options, () => listBackupsUnlocked(options));
}

/**
 * Restore a snapshot only after every payload file passes path, size and hash
 * validation. A pre-restore snapshot is committed before any project mutation.
 */
export function restoreNovelBackup(options: NovelBackupOptions, backupId: string): Promise<NovelBackupRestoreResult> {
  return withProjectLock(options, () => restoreUnlocked(options, backupId));
}
