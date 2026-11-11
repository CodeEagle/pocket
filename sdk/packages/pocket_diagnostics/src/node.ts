/**
 * Node / Bun durable file persistence adapter for @pocket/diagnostics.
 * Uses an append-only JSONL journal with rotation, capacity/size bounds,
 * partial final line recovery, serialized concurrent writes, and explicit
 * fsync flushing for crash records.
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createDiagnosticsCollector,
  matchesClearFilter,
} from "./collector.ts";
import {
  DEFAULT_MAX_RECORDS,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticClearFilter,
  type DiagnosticRecord,
  type DiagnosticsCollector,
  type DiagnosticsCollectorOptions,
  type DiagnosticsStorage,
  type DiagnosticsStorageAppendOptions,
} from "./types.ts";

const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;

export const DEFAULT_JOURNAL_FILENAME = "diagnostics.jsonl";
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
export const DEFAULT_MAX_ROTATED_FILES = 3;

export interface FileDiagnosticsStorageOptions {
  readonly directory: string;
  readonly filename?: string;
  /** Maximum bytes per active journal segment before rotation (default: 512 KiB). */
  readonly maxFileBytes?: number;
  /** Maximum number of rotated `.1`, `.2`, ... segment files retained (default: 3). */
  readonly maxRotatedFiles?: number;
  /** Maximum total records retained across segments (default: 500). */
  readonly maxRecords?: number;
  /** Always fsync every append, even normal log entries (default: false; crashes always sync). */
  readonly syncOnLog?: boolean;
}

export interface FileDiagnosticsStorage extends DiagnosticsStorage {
  readonly directory: string;
  readonly journalPath: string;
  readonly recoveredPartialLines: number;
  readonly droppedCorruptLines: number;
}

export interface FileDiagnosticsOptions
  extends Omit<DiagnosticsCollectorOptions, "storage">,
    FileDiagnosticsStorageOptions {}

export interface FileDiagnosticsCollector extends DiagnosticsCollector {
  readonly storage: FileDiagnosticsStorage;
  readonly directory: string;
  readonly journalPath: string;
}

function validateFilename(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("\0")
  ) {
    throw new TypeError(`Invalid diagnostics journal filename: ${name}`);
  }
  return trimmed;
}

function isValidDiagnosticRecord(value: unknown): value is DiagnosticRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  if (rec.schemaVersion !== DIAGNOSTICS_SCHEMA_VERSION) return false;
  if (rec.kind !== "log" && rec.kind !== "crash") return false;
  if (typeof rec.id !== "string" || rec.id.length === 0) return false;
  if (typeof rec.timestamp !== "string" || rec.timestamp.length === 0) return false;
  if (typeof rec.severity !== "string" || typeof rec.message !== "string") return false;
  if (rec.kind === "crash") {
    if (!rec.error || typeof rec.error !== "object" || Array.isArray(rec.error)) return false;
    const err = rec.error as Record<string, unknown>;
    if (typeof err.name !== "string" || typeof err.message !== "string") return false;
  }
  return true;
}

async function ensureSafeDirectory(dirPath: string): Promise<string> {
  const resolved = resolve(dirPath);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Diagnostics directory must be a real directory: ${resolved}`);
  }
  return await realpath(resolved);
}

async function assertRegularOrMissing(filePath: string): Promise<boolean> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Diagnostics journal path is not a regular file: ${filePath}`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface ParsedFileResult {
  readonly records: DiagnosticRecord[];
  readonly hadTrailingPartialLine: boolean;
  readonly corruptLines: number;
  readonly validLinesText: string;
}

function parseJsonlContent(raw: string): ParsedFileResult {
  if (raw.length === 0) {
    return {
      records: [],
      hadTrailingPartialLine: false,
      corruptLines: 0,
      validLinesText: "",
    };
  }

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (endsWithNewline && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const records: DiagnosticRecord[] = [];
  const validSerialized: string[] = [];
  let hadTrailingPartialLine = false;
  let corruptLines = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const isLastLine = i === lines.length - 1;
    try {
      const parsed = JSON.parse(line);
      if (isValidDiagnosticRecord(parsed)) {
        records.push(parsed);
        validSerialized.push(JSON.stringify(parsed));
      } else {
        if (isLastLine && !endsWithNewline) {
          hadTrailingPartialLine = true;
        } else {
          corruptLines += 1;
        }
      }
    } catch {
      if (isLastLine && !endsWithNewline) {
        hadTrailingPartialLine = true;
      } else {
        corruptLines += 1;
      }
    }
  }

  return {
    records,
    hadTrailingPartialLine,
    corruptLines,
    validLinesText: validSerialized.length > 0 ? `${validSerialized.join("\n")}\n` : "",
  };
}

async function atomicWriteFile(
  targetPath: string,
  directory: string,
  content: string,
): Promise<void> {
  await assertRegularOrMissing(targetPath);
  const tempPath = join(directory, `.diag-${randomUUID()}.tmp`);
  const handle = await open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollowFlag,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await assertRegularOrMissing(targetPath);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Create a durable Node/Bun file-backed DiagnosticsStorage using an append-only
 * JSONL journal with size rotation, record count bounds, and partial write recovery.
 */
export function createFileDiagnosticsStorage(
  options: FileDiagnosticsStorageOptions,
): FileDiagnosticsStorage {
  if (!options || typeof options.directory !== "string" || options.directory.trim().length === 0) {
    throw new TypeError("createFileDiagnosticsStorage requires a non-empty directory path");
  }

  const resolvedDirectory = resolve(options.directory);
  const filename = validateFilename(options.filename ?? DEFAULT_JOURNAL_FILENAME);
  const maxFileBytes =
    typeof options.maxFileBytes === "number" && Number.isFinite(options.maxFileBytes) && options.maxFileBytes >= 1024
      ? Math.floor(options.maxFileBytes)
      : DEFAULT_MAX_FILE_BYTES;
  const maxRotatedFiles =
    typeof options.maxRotatedFiles === "number" && Number.isFinite(options.maxRotatedFiles) && options.maxRotatedFiles >= 0
      ? Math.min(32, Math.floor(options.maxRotatedFiles))
      : DEFAULT_MAX_ROTATED_FILES;
  const maxRecords =
    typeof options.maxRecords === "number" && Number.isFinite(options.maxRecords) && options.maxRecords >= 1
      ? Math.floor(options.maxRecords)
      : DEFAULT_MAX_RECORDS;
  const syncOnLog = options.syncOnLog === true;

  let initialized = false;
  let canonicalDir = resolvedDirectory;
  let recoveredPartialLines = 0;
  let droppedCorruptLines = 0;
  let totalWriteCount = 0;
  let activeHandle: Awaited<ReturnType<typeof open>> | null = null;
  let activeSize = 0;

  const rotatedPath = (index: number): string => join(canonicalDir, `${filename}.${index}`);

  const closeActiveHandle = async (): Promise<void> => {
    if (!activeHandle) return;
    const h = activeHandle;
    activeHandle = null;
    await h.close().catch(() => undefined);
  };

  const ensureActiveHandle = async (): Promise<Awaited<ReturnType<typeof open>>> => {
    if (activeHandle) return activeHandle;
    const activePath = join(canonicalDir, filename);
    const exists = await assertRegularOrMissing(activePath);
    if (exists) {
      const st = await stat(activePath);
      activeSize = st.size;
    } else {
      activeSize = 0;
    }
    activeHandle = await open(
      activePath,
      fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | noFollowFlag,
      0o600,
    );
    return activeHandle;
  };

  // Serialize all file storage operations
  let opQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = opQueue.then(fn, fn);
    opQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const cleanupTempFiles = async (dir: string): Promise<void> => {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.startsWith(".diag-") && entry.endsWith(".tmp")) {
          await rm(join(dir, entry), { force: true }).catch(() => undefined);
        }
      }
    } catch {
      // ignore
    }
  };

  const initIfNeeded = async (): Promise<void> => {
    if (initialized) return;
    canonicalDir = await ensureSafeDirectory(resolvedDirectory);
    await cleanupTempFiles(canonicalDir);

    const activePath = join(canonicalDir, filename);
    const exists = await assertRegularOrMissing(activePath);
    if (exists) {
      const raw = await readFile(activePath, "utf8");
      const parsed = parseJsonlContent(raw);
      if (parsed.hadTrailingPartialLine) {
        recoveredPartialLines += 1;
      }
      if (parsed.corruptLines > 0) {
        droppedCorruptLines += parsed.corruptLines;
      }
      if (parsed.hadTrailingPartialLine || parsed.corruptLines > 0) {
        await atomicWriteFile(activePath, canonicalDir, parsed.validLinesText);
      }
      activeSize = Buffer.byteLength(parsed.validLinesText, "utf8");
    } else {
      activeSize = 0;
    }
    initialized = true;
  };

  const getSegmentPathsOldestFirst = (): string[] => {
    const paths: string[] = [];
    for (let i = maxRotatedFiles; i >= 1; i -= 1) {
      paths.push(join(canonicalDir, `${filename}.${i}`));
    }
    paths.push(join(canonicalDir, filename));
    return paths;
  };

  const readAllInternal = async (): Promise<DiagnosticRecord[]> => {
    await initIfNeeded();
    const paths = getSegmentPathsOldestFirst();
    const allRecords: DiagnosticRecord[] = [];

    for (const segPath of paths) {
      const exists = await assertRegularOrMissing(segPath);
      if (!exists) continue;
      const raw = await readFile(segPath, "utf8");
      const parsed = parseJsonlContent(raw);
      if (parsed.hadTrailingPartialLine) {
        recoveredPartialLines += 1;
      }
      if (parsed.corruptLines > 0) {
        droppedCorruptLines += parsed.corruptLines;
      }
      if (segPath === join(canonicalDir, filename) && (parsed.hadTrailingPartialLine || parsed.corruptLines > 0)) {
        await closeActiveHandle();
        await atomicWriteFile(segPath, canonicalDir, parsed.validLinesText);
        activeSize = Buffer.byteLength(parsed.validLinesText, "utf8");
      }
      allRecords.push(...parsed.records);
    }

    if (allRecords.length > maxRecords) {
      return allRecords.slice(-maxRecords);
    }
    return allRecords;
  };

  const rotateSegments = async (): Promise<void> => {
    await closeActiveHandle();
    const activePath = join(canonicalDir, filename);
    if (maxRotatedFiles <= 0) {
      const exists = await assertRegularOrMissing(activePath);
      if (!exists) return;
      const raw = await readFile(activePath, "utf8");
      const parsed = parseJsonlContent(raw);
      const keepCount = Math.max(1, Math.min(Math.floor(maxRecords / 2), Math.floor(parsed.records.length / 2)));
      const kept = parsed.records.slice(-keepCount);
      const content = kept.length > 0 ? `${kept.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
      await atomicWriteFile(activePath, canonicalDir, content);
      activeSize = Buffer.byteLength(content, "utf8");
      return;
    }

    const oldestRotated = rotatedPath(maxRotatedFiles);
    if (await assertRegularOrMissing(oldestRotated)) {
      await rm(oldestRotated, { force: true });
    }

    for (let i = maxRotatedFiles - 1; i >= 1; i -= 1) {
      const src = rotatedPath(i);
      const dst = rotatedPath(i + 1);
      if (await assertRegularOrMissing(src)) {
        await rename(src, dst);
      }
    }

    if (await assertRegularOrMissing(activePath)) {
      await rename(activePath, rotatedPath(1));
    }
    activeSize = 0;
  };

  const compactToRecords = async (records: readonly DiagnosticRecord[]): Promise<void> => {
    await closeActiveHandle();
    const bounded = records.slice(-maxRecords);
    for (let i = 1; i <= maxRotatedFiles; i += 1) {
      const p = rotatedPath(i);
      if (await assertRegularOrMissing(p)) {
        await rm(p, { force: true });
      }
    }
    const activePath = join(canonicalDir, filename);
    if (bounded.length === 0) {
      if (await assertRegularOrMissing(activePath)) {
        await rm(activePath, { force: true });
      }
      activeSize = 0;
      return;
    }

    const chunks: string[][] = [[]];
    let currentBytes = 0;
    for (const rec of bounded) {
      const line = JSON.stringify(rec);
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (chunks[chunks.length - 1]!.length > 0 && currentBytes + lineBytes > maxFileBytes) {
        chunks.push([]);
        currentBytes = 0;
      }
      chunks[chunks.length - 1]!.push(line);
      currentBytes += lineBytes;
    }

    const maxTotalSegments = maxRotatedFiles + 1;
    const retainedChunks = chunks.slice(-maxTotalSegments);
    const activeLines = retainedChunks.pop() ?? [];
    const activeContent = activeLines.length > 0 ? `${activeLines.join("\n")}\n` : "";
    await atomicWriteFile(activePath, canonicalDir, activeContent);
    activeSize = Buffer.byteLength(activeContent, "utf8");

    for (let i = 0; i < retainedChunks.length; i += 1) {
      const chunk = retainedChunks[retainedChunks.length - 1 - i]!;
      const rotPath = rotatedPath(i + 1);
      await atomicWriteFile(rotPath, canonicalDir, `${chunk.join("\n")}\n`);
    }
  };

  return {
    preservesLogHistory: true,

    get directory(): string {
      return canonicalDir;
    },

    get journalPath(): string {
      return join(canonicalDir, filename);
    },

    get recoveredPartialLines(): number {
      return recoveredPartialLines;
    },

    get droppedCorruptLines(): number {
      return droppedCorruptLines;
    },

    append(record: DiagnosticRecord, appendOptions?: DiagnosticsStorageAppendOptions): Promise<void> {
      return serialize(async () => {
        await initIfNeeded();
        const line = `${JSON.stringify(record)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");

        if (activeSize > 0 && activeSize + lineBytes > maxFileBytes) {
          await rotateSegments();
        }

        const handle = await ensureActiveHandle();
        await handle.writeFile(line, "utf8");
        activeSize += lineBytes;
        if (appendOptions?.sync || record.kind === "crash" || syncOnLog) {
          await handle.sync();
        }

        totalWriteCount += 1;
        if (totalWriteCount >= maxRecords) {
          totalWriteCount = 0;
          const all = await readAllInternal();
          if (all.length >= maxRecords) {
            await compactToRecords(all.slice(-maxRecords));
          }
        }
      });
    },

    readAll(): Promise<readonly DiagnosticRecord[]> {
      return serialize(async () => {
        return await readAllInternal();
      });
    },

    clear(filter?: DiagnosticClearFilter): Promise<number> {
      return serialize(async () => {
        await initIfNeeded();
        const all = await readAllInternal();
        if (!filter) {
          await compactToRecords([]);
          return all.length;
        }
        const kept = all.filter((rec) => !matchesClearFilter(rec, filter));
        const removed = all.length - kept.length;
        if (removed > 0) {
          await compactToRecords(kept);
        }
        return removed;
      });
    },

    flush(): Promise<void> {
      return serialize(async () => {
        await initIfNeeded();
        if (activeHandle) {
          await activeHandle.sync();
          return;
        }
        const activePath = join(canonicalDir, filename);
        if (!(await assertRegularOrMissing(activePath))) return;
        const rwHandle = await open(activePath, fsConstants.O_RDWR | noFollowFlag);
        try {
          await rwHandle.sync();
        } finally {
          await rwHandle.close();
        }
      });
    },

    close(): Promise<void> {
      return serialize(async () => {
        if (!initialized) return;
        if (activeHandle) {
          try {
            await activeHandle.sync();
          } finally {
            await closeActiveHandle();
          }
          return;
        }
        const activePath = join(canonicalDir, filename);
        if (!(await assertRegularOrMissing(activePath))) return;
        const rwHandle = await open(activePath, fsConstants.O_RDWR | noFollowFlag);
        try {
          await rwHandle.sync();
        } finally {
          await rwHandle.close();
        }
      });
    },
  };
}

/**
 * Convenience factory for Studio / Node / Bun hosts: creates a durable file-backed
 * DiagnosticsCollector in one call.
 */
export function createFileDiagnostics(
  options: FileDiagnosticsOptions,
): FileDiagnosticsCollector {
  const storage = createFileDiagnosticsStorage(options);
  const collector = createDiagnosticsCollector({
    ...options,
    storage,
  });

  return {
    get closed(): boolean {
      return collector.closed;
    },
    get storage(): FileDiagnosticsStorage {
      return storage;
    },
    get directory(): string {
      return storage.directory;
    },
    get journalPath(): string {
      return storage.journalPath;
    },
    getContext: () => collector.getContext(),
    setContext: (ctx) => collector.setContext(ctx),
    recordLog: (input) => collector.recordLog(input),
    recordCrash: (errorOrInput, overrides) => collector.recordCrash(errorOrInput, overrides),
    list: (query) => collector.list(query),
    listLogs: (query) => collector.listLogs(query),
    listCrashes: (query) => collector.listCrashes(query),
    getCrashRecentLogs: (crash, limit) => collector.getCrashRecentLogs(crash, limit),
    exportRecords: (query) => collector.exportRecords(query),
    clear: (filter) => collector.clear(filter),
    flush: () => collector.flush(),
    close: () => collector.close(),
  };
}
