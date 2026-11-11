/**
 * Portable types and defaults for @pocket/diagnostics.
 * Zero Node/Bun built-in imports.
 */

export type DiagnosticPrimitive = string | number | boolean | null;
export type DiagnosticDataValue =
  | DiagnosticPrimitive
  | readonly DiagnosticDataValue[]
  | { readonly [key: string]: DiagnosticDataValue };

export type DiagnosticRecordKind = "log" | "crash";
export type DiagnosticSeverity = "debug" | "info" | "warn" | "error" | "fatal";

export interface DiagnosticContext {
  readonly source?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeId?: string;
  readonly revision?: number | string;
}

export interface NormalizedDiagnosticError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string | number;
  readonly cause?: NormalizedDiagnosticError;
  readonly details?: DiagnosticDataValue;
  readonly truncated?: boolean;
}

export interface DiagnosticRecentLogSummary {
  readonly id: string;
  readonly timestamp: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly tag?: string;
  readonly source?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeId?: string;
  readonly revision?: number | string;
}

export interface DiagnosticRecordBase extends DiagnosticContext {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly kind: DiagnosticRecordKind;
  readonly timestamp: string;
  readonly seq: number;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly tag?: string;
  readonly data?: DiagnosticDataValue;
}

export interface DiagnosticLogRecord extends DiagnosticRecordBase {
  readonly kind: "log";
  readonly durationMs?: number;
}

export interface DiagnosticCrashRecord extends DiagnosticRecordBase {
  readonly kind: "crash";
  readonly error: NormalizedDiagnosticError;
  readonly unhandled?: boolean;
  /**
   * Optional bounded recent log references or summaries.
   * When a journal storage already persists preceding log records, callers or
   * adapters can omit duplicate full log snapshots or keep lightweight IDs/summaries.
   */
  readonly recentLogIds?: readonly string[];
  readonly recentLogs?: readonly DiagnosticRecentLogSummary[];
}

export type DiagnosticRecord = DiagnosticLogRecord | DiagnosticCrashRecord;

export interface DiagnosticLogInput extends DiagnosticContext {
  readonly id?: string;
  readonly timestamp?: string | number | Date;
  readonly severity?: DiagnosticSeverity;
  readonly message: string;
  readonly tag?: string;
  readonly durationMs?: number;
  readonly data?: unknown;
}

export interface DiagnosticCrashInput extends DiagnosticContext {
  readonly id?: string;
  readonly timestamp?: string | number | Date;
  readonly severity?: "error" | "fatal";
  readonly message?: string;
  readonly tag?: string;
  readonly error?: unknown;
  readonly unhandled?: boolean;
  readonly data?: unknown;
  /** Override how many recent logs to attach or reference for this crash. */
  readonly recentLogLimit?: number;
}

export interface DiagnosticQuery {
  readonly kind?: DiagnosticRecordKind | readonly DiagnosticRecordKind[];
  readonly severity?: DiagnosticSeverity | readonly DiagnosticSeverity[];
  readonly minSeverity?: DiagnosticSeverity;
  readonly source?: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeId?: string;
  readonly revision?: number | string;
  readonly tag?: string;
  readonly since?: string | number | Date;
  readonly until?: string | number | Date;
  readonly search?: string;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

export interface DiagnosticClearFilter {
  readonly kind?: DiagnosticRecordKind | readonly DiagnosticRecordKind[];
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeId?: string;
  readonly before?: string | number | Date;
}

export interface DiagnosticNormalizationLimits {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxArrayLength?: number;
  readonly maxObjectKeys?: number;
  readonly maxStringLength?: number;
  readonly maxStackLength?: number;
  readonly maxCauseDepth?: number;
  readonly maxDataBytes?: number;
}

export interface DiagnosticExportBundle {
  readonly format: "pocket-diagnostics-export";
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly totalRecords: number;
  readonly logCount: number;
  readonly crashCount: number;
  readonly context?: DiagnosticContext;
  readonly records: readonly DiagnosticRecord[];
}

export interface DiagnosticsStorageAppendOptions {
  readonly sync?: boolean;
}

/**
 * Storage abstraction for consumer-provided or file-backed persistence.
 */
export interface DiagnosticsStorage {
  /**
   * If true, the storage durably persists log records in sequence alongside
   * crashes, so crash records can reference recent log IDs instead of duplicating
   * full log payloads unless explicitly requested.
   */
  readonly preservesLogHistory?: boolean;
  append(record: DiagnosticRecord, options?: DiagnosticsStorageAppendOptions): void | Promise<void>;
  readAll(): readonly DiagnosticRecord[] | Promise<readonly DiagnosticRecord[]>;
  clear?(filter?: DiagnosticClearFilter): number | void | Promise<number | void>;
  flush?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type RecentLogCaptureMode = "auto" | "ids" | "summaries" | "none";

export interface DiagnosticsCollectorOptions {
  readonly storage?: DiagnosticsStorage;
  readonly context?: DiagnosticContext;
  readonly maxRecords?: number;
  readonly recentLogLimit?: number;
  readonly recentLogMode?: RecentLogCaptureMode;
  readonly normalization?: DiagnosticNormalizationLimits;
  readonly now?: () => Date | string | number;
  readonly idGenerator?: () => string;
}

export interface DiagnosticsCollector {
  readonly closed: boolean;
  getContext(): DiagnosticContext;
  setContext(context: Partial<DiagnosticContext>): DiagnosticContext;
  recordLog(input: DiagnosticLogInput | string): Promise<DiagnosticLogRecord>;
  recordCrash(errorOrInput: unknown, overrides?: Omit<DiagnosticCrashInput, "error">): Promise<DiagnosticCrashRecord>;
  list(query?: DiagnosticQuery): Promise<readonly DiagnosticRecord[]>;
  listLogs(query?: Omit<DiagnosticQuery, "kind">): Promise<readonly DiagnosticLogRecord[]>;
  listCrashes(query?: Omit<DiagnosticQuery, "kind">): Promise<readonly DiagnosticCrashRecord[]>;
  getCrashRecentLogs(crash: DiagnosticCrashRecord | string, limit?: number): Promise<readonly DiagnosticLogRecord[]>;
  exportRecords(query?: DiagnosticQuery): Promise<DiagnosticExportBundle>;
  clear(filter?: DiagnosticClearFilter): Promise<number>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAX_RECORDS = 500;
export const DEFAULT_RECENT_LOG_LIMIT = 20;
export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_NODES = 512;
export const DEFAULT_MAX_ARRAY_LENGTH = 64;
export const DEFAULT_MAX_OBJECT_KEYS = 64;
export const DEFAULT_MAX_STRING_LENGTH = 4096;
export const DEFAULT_MAX_STACK_LENGTH = 16 * 1024;
export const DEFAULT_MAX_CAUSE_DEPTH = 6;
export const DEFAULT_MAX_DATA_BYTES = 32 * 1024;
