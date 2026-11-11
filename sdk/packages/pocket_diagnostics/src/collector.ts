/**
 * Portable diagnostics collector and in-memory / Web Storage adapters.
 * Zero Node/Bun built-in imports.
 */

import {
  estimateUtf8Bytes,
  normalizeContextString,
  normalizeDiagnosticContext,
  normalizeDiagnosticData,
  normalizeDiagnosticError,
  normalizeTimestamp,
  resolveNormalizationLimits,
  truncateString,
} from "./normalize.ts";
import {
  DEFAULT_MAX_RECORDS,
  DEFAULT_RECENT_LOG_LIMIT,
  DIAGNOSTICS_SCHEMA_VERSION,
  type DiagnosticClearFilter,
  type DiagnosticContext,
  type DiagnosticCrashInput,
  type DiagnosticCrashRecord,
  type DiagnosticExportBundle,
  type DiagnosticLogInput,
  type DiagnosticLogRecord,
  type DiagnosticQuery,
  type DiagnosticRecentLogSummary,
  type DiagnosticRecord,
  type DiagnosticRecordKind,
  type DiagnosticSeverity,
  type DiagnosticsCollector,
  type DiagnosticsCollectorOptions,
  type DiagnosticsStorage,
  type DiagnosticsStorageAppendOptions,
} from "./types.ts";

const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

function isValidSeverity(value: unknown): value is DiagnosticSeverity {
  return typeof value === "string" && Object.hasOwn(SEVERITY_ORDER, value);
}

function defaultIdGenerator(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") {
    try {
      return g.crypto.randomUUID();
    } catch {
      // fallback
    }
  }
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `diag-${time}-${rand}`;
}

export function matchesClearFilter(record: DiagnosticRecord, filter?: DiagnosticClearFilter): boolean {
  if (!filter) return true;
  if (filter.kind !== undefined) {
    const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
    if (!kinds.includes(record.kind)) return false;
  }
  if (filter.projectId !== undefined && record.projectId !== filter.projectId) return false;
  if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) return false;
  if (filter.runtimeId !== undefined && record.runtimeId !== filter.runtimeId) return false;
  if (filter.before !== undefined) {
    const beforeMs = filter.before instanceof Date
      ? filter.before.getTime()
      : typeof filter.before === "number"
        ? filter.before
        : Date.parse(String(filter.before));
    const recMs = Date.parse(record.timestamp);
    if (Number.isFinite(beforeMs) && Number.isFinite(recMs)) {
      if (recMs >= beforeMs) return false;
    }
  }
  return true;
}

export function filterAndSortRecords(
  records: readonly DiagnosticRecord[],
  query?: DiagnosticQuery,
): DiagnosticRecord[] {
  if (!query) return [...records];

  const kinds = query.kind !== undefined
    ? (Array.isArray(query.kind) ? query.kind : [query.kind])
    : undefined;
  const severities = query.severity !== undefined
    ? (Array.isArray(query.severity) ? query.severity : [query.severity])
    : undefined;
  const minRank = query.minSeverity && isValidSeverity(query.minSeverity)
    ? SEVERITY_ORDER[query.minSeverity]
    : undefined;
  const sinceMs = query.since !== undefined
    ? (query.since instanceof Date ? query.since.getTime() : typeof query.since === "number" ? query.since : Date.parse(String(query.since)))
    : undefined;
  const untilMs = query.until !== undefined
    ? (query.until instanceof Date ? query.until.getTime() : typeof query.until === "number" ? query.until : Date.parse(String(query.until)))
    : undefined;
  const searchLower = typeof query.search === "string" && query.search.trim().length > 0
    ? query.search.trim().toLowerCase()
    : undefined;

  const matched = records.filter((rec) => {
    if (kinds && !kinds.includes(rec.kind)) return false;
    if (severities && !severities.includes(rec.severity)) return false;
    if (minRank !== undefined && (SEVERITY_ORDER[rec.severity] ?? 0) < minRank) return false;
    if (query.source !== undefined && rec.source !== query.source) return false;
    if (query.projectId !== undefined && rec.projectId !== query.projectId) return false;
    if (query.sessionId !== undefined && rec.sessionId !== query.sessionId) return false;
    if (query.runtimeId !== undefined && rec.runtimeId !== query.runtimeId) return false;
    if (query.revision !== undefined && rec.revision !== query.revision) return false;
    if (query.tag !== undefined && rec.tag !== query.tag) return false;

    if (sinceMs !== undefined && Number.isFinite(sinceMs)) {
      const recMs = Date.parse(rec.timestamp);
      if (Number.isFinite(recMs) && recMs < sinceMs) return false;
    }
    if (untilMs !== undefined && Number.isFinite(untilMs)) {
      const recMs = Date.parse(rec.timestamp);
      if (Number.isFinite(recMs) && recMs > untilMs) return false;
    }

    if (searchLower !== undefined) {
      const msgMatch = rec.message.toLowerCase().includes(searchLower);
      const tagMatch = rec.tag ? rec.tag.toLowerCase().includes(searchLower) : false;
      const errMatch = rec.kind === "crash"
        ? rec.error.message.toLowerCase().includes(searchLower) ||
          rec.error.name.toLowerCase().includes(searchLower) ||
          (rec.error.stack ? rec.error.stack.toLowerCase().includes(searchLower) : false)
        : false;
      if (!msgMatch && !tagMatch && !errMatch) return false;
    }
    return true;
  });

  if (query.order === "desc") {
    matched.reverse();
  }

  if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit >= 0) {
    const max = Math.floor(query.limit);
    if (query.order === "desc") {
      return matched.slice(0, max);
    }
    // When ascending, if limit is set, return the first `max` matching items
    return matched.slice(0, max);
  }

  return matched;
}

function summarizeLog(log: DiagnosticLogRecord): DiagnosticRecentLogSummary {
  return {
    id: log.id,
    timestamp: log.timestamp,
    severity: log.severity,
    message: truncateString(log.message, 512),
    ...(log.tag !== undefined ? { tag: log.tag } : {}),
    ...(log.source !== undefined ? { source: log.source } : {}),
    ...(log.projectId !== undefined ? { projectId: log.projectId } : {}),
    ...(log.sessionId !== undefined ? { sessionId: log.sessionId } : {}),
    ...(log.runtimeId !== undefined ? { runtimeId: log.runtimeId } : {}),
    ...(log.revision !== undefined ? { revision: log.revision } : {}),
  };
}

export interface MemoryDiagnosticsStorageOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly preservesLogHistory?: boolean;
}

/**
 * Bounded in-memory storage implementation of DiagnosticsStorage.
 */
export function createMemoryDiagnosticsStorage(
  options: MemoryDiagnosticsStorageOptions = {},
): DiagnosticsStorage {
  const maxRecords = typeof options.maxRecords === "number" && options.maxRecords > 0
    ? Math.floor(options.maxRecords)
    : DEFAULT_MAX_RECORDS;
  const maxBytes = typeof options.maxBytes === "number" && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : 2 * 1024 * 1024;
  const records: DiagnosticRecord[] = [];
  const sizes: number[] = [];
  let totalBytes = 0;

  const enforceBounds = () => {
    while (records.length > maxRecords || (records.length > 1 && totalBytes > maxBytes)) {
      records.shift();
      const removed = sizes.shift() ?? 0;
      totalBytes = Math.max(0, totalBytes - removed);
    }
  };

  return {
    preservesLogHistory: options.preservesLogHistory ?? true,
    append(record: DiagnosticRecord): void {
      const serialized = JSON.stringify(record);
      const byteLen = estimateUtf8Bytes(serialized);
      records.push(record);
      sizes.push(byteLen);
      totalBytes += byteLen;
      enforceBounds();
    },
    readAll(): readonly DiagnosticRecord[] {
      return [...records];
    },
    clear(filter?: DiagnosticClearFilter): number {
      if (!filter) {
        const count = records.length;
        records.length = 0;
        sizes.length = 0;
        totalBytes = 0;
        return count;
      }
      let removedCount = 0;
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (matchesClearFilter(records[i]!, filter)) {
          records.splice(i, 1);
          const sz = sizes.splice(i, 1)[0] ?? 0;
          totalBytes = Math.max(0, totalBytes - sz);
          removedCount += 1;
        }
      }
      return removedCount;
    },
    flush(): void {
      // no-op for memory
    },
    close(): void {
      // no-op for memory
    },
  };
}

export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface KeyValueDiagnosticsStorageOptions {
  readonly storage: WebStorageLike;
  readonly key?: string;
  readonly maxRecords?: number;
  readonly maxBytes?: number;
}

/**
 * Bounded key-value storage adapter (e.g. browser localStorage / sessionStorage).
 */
export function createKeyValueDiagnosticsStorage(
  options: KeyValueDiagnosticsStorageOptions,
): DiagnosticsStorage {
  if (!options?.storage || typeof options.storage.getItem !== "function" || typeof options.storage.setItem !== "function") {
    throw new TypeError("KeyValueDiagnosticsStorage requires a storage object with getItem and setItem");
  }
  const key = typeof options.key === "string" && options.key.trim().length > 0
    ? options.key.trim()
    : "pocket.diagnostics.v1";
  const maxRecords = typeof options.maxRecords === "number" && options.maxRecords > 0
    ? Math.floor(options.maxRecords)
    : 200;
  const maxBytes = typeof options.maxBytes === "number" && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : 256 * 1024;

  const loadList = (): DiagnosticRecord[] => {
    try {
      const raw = options.storage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is DiagnosticRecord =>
          Boolean(item) &&
          typeof item === "object" &&
          item.schemaVersion === 1 &&
          (item.kind === "log" || item.kind === "crash") &&
          typeof item.id === "string" &&
          typeof item.timestamp === "string",
      );
    } catch {
      return [];
    }
  };

  const saveList = (items: DiagnosticRecord[]): void => {
    const trimmed = items.slice(-maxRecords);
    let serialized = JSON.stringify(trimmed);
    while (trimmed.length > 1 && estimateUtf8Bytes(serialized) > maxBytes) {
      trimmed.shift();
      serialized = JSON.stringify(trimmed);
    }
    options.storage.setItem(key, serialized);
  };

  return {
    preservesLogHistory: true,
    append(record: DiagnosticRecord): void {
      const current = loadList();
      current.push(record);
      saveList(current);
    },
    readAll(): readonly DiagnosticRecord[] {
      return loadList();
    },
    clear(filter?: DiagnosticClearFilter): number {
      const current = loadList();
      if (!filter) {
        options.storage.removeItem(key);
        return current.length;
      }
      const kept = current.filter((rec) => !matchesClearFilter(rec, filter));
      const removed = current.length - kept.length;
      if (kept.length === 0) {
        options.storage.removeItem(key);
      } else {
        saveList(kept);
      }
      return removed;
    },
  };
}

/**
 * Create a portable diagnostics collector instance.
 */
export function createDiagnosticsCollector(
  options: DiagnosticsCollectorOptions = {},
): DiagnosticsCollector {
  const maxRecords = typeof options.maxRecords === "number" && options.maxRecords > 0
    ? Math.floor(options.maxRecords)
    : DEFAULT_MAX_RECORDS;
  const defaultRecentLogLimit = typeof options.recentLogLimit === "number" && options.recentLogLimit >= 0
    ? Math.min(200, Math.floor(options.recentLogLimit))
    : DEFAULT_RECENT_LOG_LIMIT;
  const recentLogMode = options.recentLogMode ?? "auto";
  const normLimits = resolveNormalizationLimits(options.normalization);
  const nowFn = options.now ?? (() => new Date());
  const idGen = options.idGenerator ?? defaultIdGenerator;

  const storage: DiagnosticsStorage =
    options.storage ?? createMemoryDiagnosticsStorage({ maxRecords });

  let baseContext: DiagnosticContext = normalizeDiagnosticContext(options.context);
  let closed = false;
  let seqCounter = 0;

  // Keep a small rolling ring of recent logs only when needed for crash context
  // if the underlying storage does not already preserve log history, or to supply
  // fast recent log IDs without reading the full journal on every crash.
  const recentLogsWindow: DiagnosticLogRecord[] = [];
  const pushRecentLog = (record: DiagnosticLogRecord): void => {
    if (defaultRecentLogLimit <= 0 && recentLogMode === "none") return;
    recentLogsWindow.push(record);
    const cap = Math.max(defaultRecentLogLimit, 50);
    if (recentLogsWindow.length > cap) {
      recentLogsWindow.splice(0, recentLogsWindow.length - cap);
    }
  };

  // Serialized async operation queue so concurrent recordLog / recordCrash / clear / flush
  // execute in deterministic order without overlapping storage writes.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const assertOpen = (): void => {
    if (closed) {
      throw new Error("DiagnosticsCollector is closed");
    }
  };

  const mergeContext = (override?: DiagnosticContext): DiagnosticContext => {
    const normalizedOverride = normalizeDiagnosticContext(override);
    return {
      ...(baseContext.source !== undefined ? { source: baseContext.source } : {}),
      ...(baseContext.projectId !== undefined ? { projectId: baseContext.projectId } : {}),
      ...(baseContext.sessionId !== undefined ? { sessionId: baseContext.sessionId } : {}),
      ...(baseContext.runtimeId !== undefined ? { runtimeId: baseContext.runtimeId } : {}),
      ...(baseContext.revision !== undefined ? { revision: baseContext.revision } : {}),
      ...normalizedOverride,
    };
  };

  const buildLogRecord = (input: DiagnosticLogInput | string): DiagnosticLogRecord => {
    const normalizedInput: DiagnosticLogInput =
      typeof input === "string" ? { message: input } : input;
    if (!normalizedInput || typeof normalizedInput !== "object") {
      throw new TypeError("recordLog input must be a string or object");
    }
    const rawMsg = typeof normalizedInput.message === "string"
      ? normalizedInput.message
      : String(normalizedInput.message ?? "");
    const message = truncateString(rawMsg, normLimits.maxStringLength);
    const severity: DiagnosticSeverity = isValidSeverity(normalizedInput.severity)
      ? normalizedInput.severity
      : "info";
    const id = normalizeContextString(normalizedInput.id, 128) ?? idGen();
    const timestamp = normalizeTimestamp(normalizedInput.timestamp, nowFn);
    const tag = normalizeContextString(normalizedInput.tag, 128);
    const durationMs =
      typeof normalizedInput.durationMs === "number" &&
      Number.isFinite(normalizedInput.durationMs) &&
      normalizedInput.durationMs >= 0
        ? normalizedInput.durationMs
        : undefined;
    const ctx = mergeContext(normalizedInput);
    const data = normalizeDiagnosticData(normalizedInput.data, normLimits);
    seqCounter += 1;

    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      id,
      kind: "log",
      timestamp,
      seq: seqCounter,
      severity,
      message,
      ...(tag !== undefined ? { tag } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...ctx,
      ...(data !== undefined ? { data } : {}),
    };
  };

  const buildCrashRecord = (
    errorOrInput: unknown,
    overrides?: Omit<DiagnosticCrashInput, "error">,
  ): DiagnosticCrashRecord => {
    let crashInput: DiagnosticCrashInput;
    if (
      overrides === undefined &&
      errorOrInput &&
      typeof errorOrInput === "object" &&
      !(errorOrInput instanceof Error) &&
      ("error" in errorOrInput || "unhandled" in errorOrInput || "recentLogLimit" in errorOrInput)
    ) {
      crashInput = errorOrInput as DiagnosticCrashInput;
    } else {
      crashInput = {
        ...overrides,
        error: errorOrInput,
      };
    }

    const rawError = crashInput.error !== undefined ? crashInput.error : errorOrInput;
    const normalizedError = normalizeDiagnosticError(rawError, normLimits);
    const rawMsg =
      typeof crashInput.message === "string" && crashInput.message.trim().length > 0
        ? crashInput.message
        : normalizedError.message || normalizedError.name || "Unhandled crash";
    const message = truncateString(rawMsg, normLimits.maxStringLength);
    const severity: "error" | "fatal" =
      crashInput.severity === "error" || crashInput.severity === "fatal"
        ? crashInput.severity
        : "fatal";
    const id = normalizeContextString(crashInput.id, 128) ?? idGen();
    const timestamp = normalizeTimestamp(crashInput.timestamp, nowFn);
    const tag = normalizeContextString(crashInput.tag, 128);
    const ctx = mergeContext(crashInput);
    const data = normalizeDiagnosticData(crashInput.data, normLimits);

    const limit =
      typeof crashInput.recentLogLimit === "number" && Number.isFinite(crashInput.recentLogLimit)
        ? Math.max(0, Math.min(200, Math.floor(crashInput.recentLogLimit)))
        : defaultRecentLogLimit;

    // Filter recent logs matching project/session if set on crash, or all recent logs
    const relevantLogs = limit > 0
      ? recentLogsWindow
          .filter((log) => {
            if (ctx.projectId && log.projectId && log.projectId !== ctx.projectId) return false;
            if (ctx.sessionId && log.sessionId && log.sessionId !== ctx.sessionId) return false;
            return true;
          })
          .slice(-limit)
      : [];

    const effectiveMode =
      recentLogMode === "auto"
        ? storage.preservesLogHistory
          ? "ids"
          : "summaries"
        : recentLogMode;

    const recentLogIds =
      effectiveMode === "ids" && relevantLogs.length > 0
        ? relevantLogs.map((l) => l.id)
        : undefined;
    const recentLogs =
      effectiveMode === "summaries" && relevantLogs.length > 0
        ? relevantLogs.map(summarizeLog)
        : undefined;

    seqCounter += 1;

    return {
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      id,
      kind: "crash",
      timestamp,
      seq: seqCounter,
      severity,
      message,
      ...(tag !== undefined ? { tag } : {}),
      ...ctx,
      error: normalizedError,
      ...(typeof crashInput.unhandled === "boolean" ? { unhandled: crashInput.unhandled } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(recentLogIds !== undefined ? { recentLogIds } : {}),
      ...(recentLogs !== undefined ? { recentLogs } : {}),
    };
  };

  return {
    get closed(): boolean {
      return closed;
    },

    getContext(): DiagnosticContext {
      return { ...baseContext };
    },

    setContext(next: Partial<DiagnosticContext>): DiagnosticContext {
      baseContext = normalizeDiagnosticContext({ ...baseContext, ...next });
      return { ...baseContext };
    },

    recordLog(input: DiagnosticLogInput | string): Promise<DiagnosticLogRecord> {
      assertOpen();
      const record = buildLogRecord(input);
      pushRecentLog(record);
      return enqueue(async () => {
        await storage.append(record, { sync: false });
        return record;
      });
    },

    recordCrash(
      errorOrInput: unknown,
      overrides?: Omit<DiagnosticCrashInput, "error">,
    ): Promise<DiagnosticCrashRecord> {
      assertOpen();
      const record = buildCrashRecord(errorOrInput, overrides);
      return enqueue(async () => {
        await storage.append(record, { sync: true });
        if (typeof storage.flush === "function") {
          await storage.flush();
        }
        return record;
      });
    },

    list(query?: DiagnosticQuery): Promise<readonly DiagnosticRecord[]> {
      return enqueue(async () => {
        const all = await storage.readAll();
        return filterAndSortRecords(all, query);
      });
    },

    async listLogs(query?: Omit<DiagnosticQuery, "kind">): Promise<readonly DiagnosticLogRecord[]> {
      const records = await this.list({ ...query, kind: "log" });
      return records as readonly DiagnosticLogRecord[];
    },

    async listCrashes(query?: Omit<DiagnosticQuery, "kind">): Promise<readonly DiagnosticCrashRecord[]> {
      const records = await this.list({ ...query, kind: "crash" });
      return records as readonly DiagnosticCrashRecord[];
    },

    getCrashRecentLogs(
      crashOrId: DiagnosticCrashRecord | string,
      limit = defaultRecentLogLimit,
    ): Promise<readonly DiagnosticLogRecord[]> {
      return enqueue(async () => {
        const all = await storage.readAll();
        const crash =
          typeof crashOrId === "string"
            ? (all.find((r): r is DiagnosticCrashRecord => r.kind === "crash" && r.id === crashOrId) ?? null)
            : crashOrId;
        if (!crash) return [];

        if (crash.recentLogIds && crash.recentLogIds.length > 0) {
          const idSet = new Set(crash.recentLogIds.slice(-limit));
          const found = all.filter((r): r is DiagnosticLogRecord => r.kind === "log" && idSet.has(r.id));
          if (found.length > 0) return found;
        }

        // Otherwise resolve from preceding journal log entries up to crash timestamp/seq
        const crashIndex = all.findIndex((r) => r.id === crash.id);
        const candidates = crashIndex >= 0 ? all.slice(0, crashIndex) : all;
        const logs = candidates.filter((r): r is DiagnosticLogRecord => {
          if (r.kind !== "log") return false;
          if (crash.projectId && r.projectId && r.projectId !== crash.projectId) return false;
          if (crash.sessionId && r.sessionId && r.sessionId !== crash.sessionId) return false;
          return true;
        });
        return logs.slice(-Math.max(0, limit));
      });
    },

    exportRecords(query?: DiagnosticQuery): Promise<DiagnosticExportBundle> {
      return enqueue(async () => {
        const all = await storage.readAll();
        const matched = filterAndSortRecords(all, query);
        let logCount = 0;
        let crashCount = 0;
        for (const r of matched) {
          if (r.kind === "log") logCount += 1;
          else if (r.kind === "crash") crashCount += 1;
        }
        return {
          format: "pocket-diagnostics-export",
          schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
          exportedAt: normalizeTimestamp(undefined, nowFn),
          totalRecords: matched.length,
          logCount,
          crashCount,
          ...(Object.keys(baseContext).length > 0 ? { context: { ...baseContext } } : {}),
          records: matched,
        };
      });
    },

    clear(filter?: DiagnosticClearFilter): Promise<number> {
      assertOpen();
      return enqueue(async () => {
        if (!filter) {
          recentLogsWindow.length = 0;
        } else {
          for (let i = recentLogsWindow.length - 1; i >= 0; i -= 1) {
            if (matchesClearFilter(recentLogsWindow[i]!, filter)) {
              recentLogsWindow.splice(i, 1);
            }
          }
        }
        if (typeof storage.clear === "function") {
          const result = await storage.clear(filter);
          return typeof result === "number" ? result : 0;
        }
        return 0;
      });
    },

    flush(): Promise<void> {
      return enqueue(async () => {
        if (typeof storage.flush === "function") {
          await storage.flush();
        }
      });
    },

    close(): Promise<void> {
      if (closed) return queue.then(() => undefined);
      closed = true;
      return enqueue(async () => {
        if (typeof storage.flush === "function") {
          await storage.flush();
        }
        if (typeof storage.close === "function") {
          await storage.close();
        }
      });
    },
  };
}

export type {
  DiagnosticRecordKind,
  DiagnosticsStorageAppendOptions,
};
