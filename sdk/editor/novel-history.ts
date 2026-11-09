/**
 * Durable storage for the Novel Editor's existing bounded undo/redo stacks.
 * The journal lives in the trusted Editor workspace, outside consumer source.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const FORMAT = "pocket-editor-novel-history";
const FORMAT_VERSION = 1;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const NOVEL_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const NOVEL_HISTORY_MAX_ENTRIES = 32;
const MAX_STORY_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS_BYTES = 512 * 1024;
const MAX_AUTHORING_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_KEY_BYTES = 1024;
const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;

export type NovelHistoryScope = "story" | "assets" | "project";

export interface NovelHistoryEntry {
  readonly scope: NovelHistoryScope;
  readonly key: string;
  readonly restore: unknown;
}

export interface NovelHistoryDraft {
  readonly story: unknown;
  readonly assets: unknown;
  readonly authoringDraft?: { readonly text: string; readonly baseline: string } | null;
}

export interface NovelHistoryValue {
  readonly draft: NovelHistoryDraft;
  readonly undo: readonly NovelHistoryEntry[];
  readonly redo: readonly NovelHistoryEntry[];
}

export type NovelHistoryReadStatus = "stale" | "corrupt";

export interface NovelHistoryResponse {
  readonly sourceToken: string;
  readonly historyRevision: number;
  readonly history: NovelHistoryValue | null;
  readonly status?: NovelHistoryReadStatus;
}

export interface NovelHistoryHeadResponse {
  readonly sourceToken: string;
  readonly historyRevision: number;
  readonly status?: NovelHistoryReadStatus;
}

export interface NovelHistoryOptions {
  /** The Editor-owned directory used for state, backups and build artifacts. */
  readonly workspaceRoot: string;
  /** The already-authorized consumer project root. */
  readonly projectRoot: string;
  readonly projectId: string;
  /** Incremented only after a successful project backup restore. */
  readonly restoreEpoch: number;
}

export interface NovelHistoryValidators {
  /** Structural validation only: reference/missing-label diagnostics are allowed. */
  readonly story: (value: unknown) => boolean;
  readonly assets: (value: unknown) => boolean;
}

export interface NovelHistoryWriteRequest {
  readonly expectedToken: string;
  readonly expectedHistoryRevision: number;
  readonly draft: NovelHistoryDraft;
  readonly undo: readonly NovelHistoryEntry[];
  readonly redo: readonly NovelHistoryEntry[];
}

export class NovelHistoryError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status = 400, code?: string) {
    super(message);
    this.name = "NovelHistoryError";
    this.status = status;
    this.code = code;
  }
}

interface StoredNovelHistory {
  readonly format: typeof FORMAT;
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly projectId: string;
  readonly sourceToken: string;
  readonly historyRevision: number;
  readonly draft: NovelHistoryDraft;
  readonly undo: readonly NovelHistoryEntry[];
  readonly redo: readonly NovelHistoryEntry[];
}

interface ExistingHistory {
  readonly status: "missing" | "valid" | "corrupt";
  readonly revision: number;
  readonly stored?: StoredNovelHistory;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every(item => isJsonValue(item, depth + 1));
}

function jsonByteLength(value: unknown): number {
  let text: string | undefined;
  try { text = JSON.stringify(value); }
  catch { return Number.POSITIVE_INFINITY; }
  return text === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(text, "utf8");
}

function checkedProjectId(options: NovelHistoryOptions): void {
  if (!PROJECT_ID_PATTERN.test(options.projectId)) throw new NovelHistoryError("projectId is invalid", 400);
  if (!Number.isSafeInteger(options.restoreEpoch) || options.restoreEpoch < 0) {
    throw new NovelHistoryError("novel restore epoch is invalid", 500);
  }
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, label: string): Promise<Buffer> {
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const parts: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new NovelHistoryError(`${label} exceeds ${maxBytes} bytes`, 413);
    parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(parts, total);
}

async function safeProjectRoot(projectRoot: string): Promise<string> {
  const absolute = resolve(projectRoot);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new NovelHistoryError("novel project root must be a real directory", 409);
  return realpath(absolute);
}

async function readSourceFile(path: string, maxBytes: number, optional: boolean): Promise<Buffer | null> {
  let beforePath;
  try { beforePath = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && optional) return null;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NovelHistoryError("history source is missing", 404);
    throw error;
  }
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new NovelHistoryError("history source must be a regular file", 409);
  if (beforePath.size > maxBytes) throw new NovelHistoryError(`history source exceeds ${maxBytes} bytes`, 413);
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new NovelHistoryError("history source changed before it could be read", 409);
    }
    const contents = await readBounded(handle, maxBytes, "history source");
    const after = await handle.stat();
    if (contents.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) {
      throw new NovelHistoryError("history source changed while it was being read", 409);
    }
    if (contents.length > maxBytes) throw new NovelHistoryError(`history source exceeds ${maxBytes} bytes`, 413);
    return contents;
  } finally {
    await handle.close();
  }
}

async function sourceToken(options: NovelHistoryOptions): Promise<string> {
  checkedProjectId(options);
  const projectRoot = await safeProjectRoot(options.projectRoot);
  const hash = createHash("sha256");
  hash.update(`${FORMAT}\0${FORMAT_VERSION}\0${options.projectId}\0${options.restoreEpoch}\0`, "utf8");
  for (const source of [
    { name: "story.json", maxBytes: MAX_STORY_BYTES, optional: false },
    { name: "novel.assets.json", maxBytes: MAX_ASSETS_BYTES, optional: true },
  ] as const) {
    const path = join(projectRoot, source.name);
    if (!isInside(projectRoot, path)) throw new NovelHistoryError("history source path escapes project directory", 409);
    const contents = await readSourceFile(path, source.maxBytes, source.optional);
    hash.update(`${source.name}\0${contents === null ? "missing" : `present:${contents.length}`}\0`, "utf8");
    if (contents) hash.update(contents);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function historyDirectory(workspaceRoot: string, create: boolean): Promise<string | null> {
  const root = resolve(workspaceRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new NovelHistoryError("Editor workspace root must be a real directory", 409);
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, "novel-history");
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let info;
  try { info = await lstat(directory); }
  catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new NovelHistoryError("history directory must be a real directory", 409);
  const canonicalDirectory = await realpath(directory);
  if (!isInside(canonicalRoot, canonicalDirectory)) throw new NovelHistoryError("history directory escapes Editor workspace", 409);
  return canonicalDirectory;
}

async function sidecarPath(options: NovelHistoryOptions, create: boolean): Promise<string | null> {
  const directory = await historyDirectory(options.workspaceRoot, create);
  if (!directory) return null;
  const path = join(directory, `${options.projectId}.json`);
  if (!isInside(directory, path)) throw new NovelHistoryError("history path escapes Editor workspace", 409);
  return path;
}

async function readSidecarFile(path: string): Promise<Buffer | null> {
  let beforePath;
  try { beforePath = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new NovelHistoryError("history sidecar must be a regular file", 409);
  if (beforePath.size > NOVEL_HISTORY_MAX_BYTES) return null;
  const handle = await open(path, fsConstants.O_RDONLY | noFollowFlag);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > NOVEL_HISTORY_MAX_BYTES || before.dev !== beforePath.dev || before.ino !== beforePath.ino) return null;
    let contents: Buffer;
    try { contents = await readBounded(handle, NOVEL_HISTORY_MAX_BYTES, "history sidecar"); }
    catch (error) {
      if (error instanceof NovelHistoryError && error.status === 413) return null;
      throw error;
    }
    const after = await handle.stat();
    if (contents.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) return null;
    return contents;
  } finally {
    await handle.close();
  }
}

function safeRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validateStory(value: unknown, validators: NovelHistoryValidators): boolean {
  return isJsonValue(value) && jsonByteLength(value) <= MAX_STORY_BYTES && validators.story(value);
}

function validateAssets(value: unknown, validators: NovelHistoryValidators): boolean {
  return isJsonValue(value) && jsonByteLength(value) <= MAX_ASSETS_BYTES && validators.assets(value);
}

function validateAuthoringDraft(value: unknown): value is { readonly text: string; readonly baseline: string } | null | undefined {
  if (value === null || value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["text", "baseline"]) || typeof value.text !== "string" || typeof value.baseline !== "string") return false;
  return Buffer.byteLength(value.text, "utf8") <= MAX_AUTHORING_TEXT_BYTES &&
    Buffer.byteLength(value.baseline, "utf8") <= MAX_AUTHORING_TEXT_BYTES;
}

function normalizeDraft(value: unknown, validators: NovelHistoryValidators): NovelHistoryDraft | null {
  const authoringDraft = isRecord(value) ? value.authoringDraft : undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, ["story", "assets", "authoringDraft"]) ||
      !Object.hasOwn(value, "story") || !Object.hasOwn(value, "assets") ||
      !validateStory(value.story, validators) || !validateAssets(value.assets, validators) ||
      !validateAuthoringDraft(authoringDraft)) return null;
  if (authoringDraft === undefined || authoringDraft === null) {
    return { story: value.story, assets: value.assets, ...(Object.hasOwn(value, "authoringDraft") ? { authoringDraft: null } : {}) };
  }
  return {
    story: value.story,
    assets: value.assets,
    authoringDraft: { text: authoringDraft.text, baseline: authoringDraft.baseline },
  };
}

function validateSnapshot(scope: NovelHistoryScope, value: unknown, validators: NovelHistoryValidators): boolean {
  if (scope === "story") return validateStory(value, validators);
  if (scope === "assets") return validateAssets(value, validators);
  return isRecord(value) && hasOnlyKeys(value, ["story", "assets"]) &&
    Object.hasOwn(value, "story") && Object.hasOwn(value, "assets") &&
    validateStory(value.story, validators) && validateAssets(value.assets, validators);
}

function normalizeStack(value: unknown, validators: NovelHistoryValidators): readonly NovelHistoryEntry[] | null {
  if (!Array.isArray(value) || value.length > NOVEL_HISTORY_MAX_ENTRIES) return null;
  const entries: NovelHistoryEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["scope", "key", "restore"]) ||
        !(item.scope === "story" || item.scope === "assets" || item.scope === "project") ||
        typeof item.key !== "string" || item.key.length === 0 || Buffer.byteLength(item.key, "utf8") > MAX_HISTORY_KEY_BYTES ||
        /[\u0000-\u001f]/.test(item.key) || !Object.hasOwn(item, "restore") ||
        !validateSnapshot(item.scope, item.restore, validators)) return null;
    entries.push({ scope: item.scope, key: item.key, restore: item.restore });
  }
  return entries;
}

function recordRevisionHint(value: unknown): number {
  return isRecord(value) && safeRevision(value.historyRevision) ? value.historyRevision : 0;
}

function parseStoredHistory(contents: Buffer, options: NovelHistoryOptions, validators: NovelHistoryValidators): ExistingHistory {
  let parsed: unknown;
  try { parsed = JSON.parse(contents.toString("utf8")); }
  catch { return { status: "corrupt", revision: 0 }; }
  const revision = recordRevisionHint(parsed);
  if (!isRecord(parsed) || parsed.format !== FORMAT || parsed.formatVersion !== FORMAT_VERSION ||
      parsed.projectId !== options.projectId || typeof parsed.sourceToken !== "string" || !SHA256_PATTERN.test(parsed.sourceToken) ||
      !safeRevision(parsed.historyRevision)) return { status: "corrupt", revision };
  const draft = normalizeDraft(parsed.draft, validators);
  const undo = normalizeStack(parsed.undo, validators);
  const redo = normalizeStack(parsed.redo, validators);
  if (!draft || !undo || !redo || !hasOnlyKeys(parsed, ["format", "formatVersion", "projectId", "sourceToken", "historyRevision", "draft", "undo", "redo"])) {
    return { status: "corrupt", revision };
  }
  const stored: StoredNovelHistory = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    projectId: options.projectId,
    sourceToken: parsed.sourceToken,
    historyRevision: parsed.historyRevision,
    draft,
    undo,
    redo,
  };
  return { status: "valid", revision, stored };
}

async function readExisting(options: NovelHistoryOptions, validators: NovelHistoryValidators): Promise<ExistingHistory> {
  const path = await sidecarPath(options, false);
  if (!path) return { status: "missing", revision: 0 };
  const contents = await readSidecarFile(path);
  return contents ? parseStoredHistory(contents, options, validators) : (await pathExists(path) ? { status: "corrupt", revision: 0 } : { status: "missing", revision: 0 });
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function getNovelHistory(
  options: NovelHistoryOptions,
  validators: NovelHistoryValidators,
  headOnly = false,
): Promise<NovelHistoryResponse | NovelHistoryHeadResponse> {
  checkedProjectId(options);
  const token = await sourceToken(options);
  const existing = await readExisting(options, validators);
  const status: NovelHistoryReadStatus | undefined = existing.status === "corrupt"
    ? "corrupt"
    : existing.status === "valid" && existing.stored!.sourceToken !== token
      ? "stale"
      : undefined;
  const revision = existing.revision;
  if (headOnly) return { sourceToken: token, historyRevision: revision, ...(status ? { status } : {}) };
  if (status || existing.status !== "valid") {
    return {
      sourceToken: token,
      historyRevision: revision,
      history: null,
      ...(status ? { status } : {}),
    };
  }
  const stored = existing.stored!;
  return {
    sourceToken: token,
    historyRevision: revision,
    history: { draft: stored.draft, undo: stored.undo, redo: stored.redo },
  };
}

function normalizeWriteRequest(value: unknown, validators: NovelHistoryValidators): NovelHistoryWriteRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["expectedToken", "expectedHistoryRevision", "draft", "undo", "redo"]) ||
      typeof value.expectedToken !== "string" || !SHA256_PATTERN.test(value.expectedToken) ||
      !Number.isSafeInteger(value.expectedHistoryRevision) || Number(value.expectedHistoryRevision) < 0) {
    throw new NovelHistoryError("history write request is invalid", 400);
  }
  const draft = normalizeDraft(value.draft, validators);
  const undo = normalizeStack(value.undo, validators);
  const redo = normalizeStack(value.redo, validators);
  if (!draft || !undo || !redo) throw new NovelHistoryError("history draft or stacks are invalid", 422);
  return {
    expectedToken: value.expectedToken,
    expectedHistoryRevision: Number(value.expectedHistoryRevision),
    draft,
    undo,
    redo,
  };
}

async function atomicWrite(path: string, directory: string, content: string): Promise<void> {
  const targetInfo = await pathExists(path) ? await lstat(path) : null;
  if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) {
    throw new NovelHistoryError("history sidecar must be a regular file", 409);
  }
  const temporary = join(directory, `.history-${randomUUID()}.tmp`);
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    const currentDirectory = await realpath(directory);
    if (currentDirectory !== directory) throw new NovelHistoryError("history directory changed during write", 409);
    const currentTarget = await pathExists(path) ? await lstat(path) : null;
    if (currentTarget && (currentTarget.isSymbolicLink() || !currentTarget.isFile())) {
      throw new NovelHistoryError("history sidecar changed during write", 409);
    }
    await rename(temporary, path);
    const directoryHandle = await open(dirname(path), fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function putNovelHistory(
  options: NovelHistoryOptions,
  input: unknown,
  validators: NovelHistoryValidators,
): Promise<{ readonly sourceToken: string; readonly historyRevision: number }> {
  checkedProjectId(options);
  const request = normalizeWriteRequest(input, validators);
  const token = await sourceToken(options);
  if (token !== request.expectedToken) throw new NovelHistoryError("novel source changed while editing history", 409, "novel_history_conflict");
  const existing = await readExisting(options, validators);
  if (existing.revision !== request.expectedHistoryRevision) {
    throw new NovelHistoryError("another Editor window changed the history journal", 409, "novel_history_conflict");
  }
  if (existing.revision >= Number.MAX_SAFE_INTEGER) throw new NovelHistoryError("history revision limit reached", 409);
  const revision = existing.revision + 1;
  const stored: StoredNovelHistory = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    projectId: options.projectId,
    sourceToken: token,
    historyRevision: revision,
    draft: request.draft,
    undo: request.undo,
    redo: request.redo,
  };
  const content = `${JSON.stringify(stored)}\n`;
  if (Buffer.byteLength(content, "utf8") > NOVEL_HISTORY_MAX_BYTES) {
    throw new NovelHistoryError(`history journal exceeds ${NOVEL_HISTORY_MAX_BYTES} bytes`, 413);
  }
  // Recheck immediately before the atomic replacement so an external editor
  // cannot make the stored journal claim a source baseline that has changed.
  if (await sourceToken(options) !== token) throw new NovelHistoryError("novel source changed while saving history", 409, "novel_history_conflict");
  const path = await sidecarPath(options, true);
  if (!path) throw new NovelHistoryError("history workspace is unavailable", 503);
  const directory = dirname(path);
  await atomicWrite(path, directory, content);
  if (await sourceToken(options) !== token) throw new NovelHistoryError("novel source changed while committing history", 409, "novel_history_conflict");
  return { sourceToken: token, historyRevision: revision };
}
