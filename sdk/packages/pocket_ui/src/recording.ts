/**
 * Thin, opt-in recording/replay adapters for PocketJS.
 *
 * The input tape and the effect queue deliberately remain PocketJS-owned.  In
 * particular, this module does not install a timer, poll a host, or implement
 * another frame pump.  It only validates/exports `__pocketDevtools.dumpTape`
 * and wraps the upstream effect-driver boundary when a caller explicitly asks
 * it to do so.
 */

import { after, simulationHz, virtualFrame } from "@pocketjs/framework/clock";
import {
  installEffectDriver,
  type EffectCommand,
  type EffectDriver,
} from "@pocketjs/framework/effects";
import { expandTapeMotion, type Tape } from "@pocketjs/framework/devtools";

export type PocketJsonPrimitive = string | number | boolean | null;
export type PocketJsonValue = PocketJsonPrimitive | PocketJsonValue[] | { [key: string]: PocketJsonValue };
export type PocketBuildMetadata = { [key: string]: PocketJsonValue };
export type InputTape = Tape;

export const RECORDING_VERSION = 1 as const;
export const DEFAULT_EFFECT_MAX_ENTRIES = 1024;
export const DEFAULT_EFFECT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_EFFECT_MAX_MISMATCH_ENTRIES = 128;
export const DEFAULT_EFFECT_MAX_MISMATCH_BYTES = 64 * 1024;

export type RecordingMismatchKind =
  | "invalid-tape"
  | "invalid-recording"
  | "invalid-effect-tape"
  | "invalid-build"
  | "quota"
  | "command"
  | "command-missing"
  | "delivery-unmatched"
  | "delivery-duplicate"
  | "delivery-late"
  | "delivery-early"
  | "delivery-missing"
  | "delivery-cancelled"
  | "driver-error"
  | "host";

export interface RecordingMismatch {
  kind: RecordingMismatchKind;
  message: string;
  index?: number;
  id?: number;
  frame?: number;
  expected?: unknown;
  actual?: unknown;
}

export class RecordingValidationError extends Error {
  readonly mismatch: RecordingMismatch;

  constructor(mismatch: RecordingMismatch) {
    super(mismatch.message);
    this.name = "RecordingValidationError";
    this.mismatch = mismatch;
  }
}

export class RecordingMismatchError extends Error {
  readonly mismatch: RecordingMismatch;

  constructor(mismatch: RecordingMismatch) {
    super(mismatch.message);
    this.name = "RecordingMismatchError";
    this.mismatch = mismatch;
  }
}

interface PocketDevtoolsApi {
  dumpTape?: () => unknown;
  replay?: (tape: unknown) => void;
}

interface EffectTraceEvent {
  t: "command" | "delivery";
  frame: number;
  id: number;
  kind: string;
}

export interface RecordedError {
  name: string;
  message: string;
  code?: string;
}

export type EffectRecordStatus = "pending" | "delivered" | "thrown" | "cancelled";

/** One command in the order in which `runEffect` handed it to the driver. */
export interface EffectRecord {
  index: number;
  id: number;
  kind: string;
  commandFrame: number;
  /** JSON snapshot of the upstream `EffectCommand.payload`. */
  paramsJSON?: string;
  /** True when the payload was explicitly `undefined`. */
  paramsUndefined?: boolean;
  status: EffectRecordStatus;
  /** JSON snapshot of a non-error delivery result. */
  resultJSON?: string;
  /** True when the delivery result was explicitly `undefined`. */
  resultUndefined?: boolean;
  /** An Error-like delivery result, or the error thrown by a driver. */
  error?: RecordedError;
  /** Frame at which the upstream effect shell actually drained the delivery. */
  deliveryFrame?: number;
}

export interface EffectTape {
  v: 1;
  entries: EffectRecord[];
  mismatches?: RecordingMismatch[];
  bytes?: number;
  /** True when capture or diagnostic quotas made this tape non-replayable. */
  incomplete?: boolean;
  /** UTF-8 bytes retained by the bounded mismatch diagnostics lane. */
  mismatchBytes?: number;
}

export interface PocketRecording {
  v: typeof RECORDING_VERSION;
  tape: Tape;
  /** Build identity supplied by the host or the caller at recording time. */
  build: PocketBuildMetadata;
  effects?: EffectTape;
}

export interface RecordingLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxMismatchEntries?: number;
  maxMismatchBytes?: number;
}

export interface EffectRecorderOptions extends RecordingLimits {
  /** Also install the wrapper in the upstream host-driver precedence slot. */
  forceHostDriver?: boolean;
}

export interface EffectRecorder {
  readonly driver: EffectDriver;
  readonly firstMismatch?: RecordingMismatch;
  readonly mismatches: readonly RecordingMismatch[];
  readonly entries: readonly EffectRecord[];
  readonly incomplete: boolean;
  /** Mark an existing command as cancelled; no second RPC is emitted. */
  cancel(id: number, reason?: string): void;
  snapshot(): EffectTape;
  /** Report commands that never reached an upstream delivery frame. */
  finish(): EffectTape;
  dispose(): void;
}

export interface EffectReplayOptions extends RecordingLimits {
  /** Install the replay driver in the upstream host-driver slot as well. */
  forceHostDriver?: boolean;
}

export interface EffectReplay {
  readonly driver: EffectDriver;
  readonly firstMismatch?: RecordingMismatch;
  readonly mismatches: readonly RecordingMismatch[];
  readonly commandIndex: number;
  /** Check that every command and every delivery was observed. */
  assertComplete(): void;
  /** Stop scheduling future deliveries and restore an overridden host slot. */
  dispose(): void;
}

export interface ExportRecordingOptions {
  build?: PocketBuildMetadata;
  effects?: EffectRecorder;
}

export interface ReplayRecordingOptions extends EffectReplayOptions {
  /** Install the effect replay driver before the next guest frame. */
  installEffects?: boolean;
}

const g = globalThis as typeof globalThis & {
  __pocketDevtools?: PocketDevtoolsApi;
  __pocketApp?: unknown;
  __simHz?: unknown;
  __pocketBuildMetadata?: unknown;
  __pocketBuildMeta?: unknown;
  __pocketGuestMetadata?: unknown;
  __pocketEffectTrace?: (event: EffectTraceEvent) => void;
  __pocketEffectDriver?: EffectDriver;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is PocketJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) if (!isJsonValue(item, seen)) return false;
    seen.delete(value);
    return true;
  }
  for (const item of Object.values(value)) if (!isJsonValue(item, seen)) return false;
  seen.delete(value);
  return true;
}

// QuickJS intentionally has no Web TextEncoder.  Match the pinned upstream
// UTF-8 codec's byte accounting (including U+FFFD for lone surrogates) without
// pulling an unrelated host/runtime encoder into the recording adapter.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.codePointAt(index)!;
    if (code > 0xffff) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes += 3;
    } else if (code < 0x80) {
      bytes++;
    } else if (code < 0x800) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonBytes(value: string): number {
  return utf8ByteLength(value);
}

function jsonSnapshot(value: unknown, label: string): { json?: string; undefined: boolean; bytes: number } {
  if (value === undefined) return { undefined: true, bytes: 0 };
  if (!isJsonValue(value)) throw new TypeError(`${label} must be a finite JSON value`);
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new TypeError(`${label} could not be JSON encoded`);
  return { json, undefined: false, bytes: jsonBytes(json) };
}

function parseSnapshot(json: string | undefined, label: string): PocketJsonValue {
  if (typeof json !== "string") throw new RecordingValidationError({
    kind: "invalid-effect-tape",
    message: `${label} is missing its JSON snapshot`,
  });
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new RecordingValidationError({
      kind: "invalid-effect-tape",
      message: `${label} is not valid JSON`,
    });
  }
  if (!isJsonValue(value)) throw new RecordingValidationError({
    kind: "invalid-effect-tape",
    message: `${label} must contain a JSON value`,
  });
  return value;
}

function cloneJson<T>(value: T, label: string): T {
  const snapshot = jsonSnapshot(value, label);
  if (snapshot.undefined) throw new TypeError(`${label} must not be undefined`);
  return JSON.parse(snapshot.json!) as T;
}

// The upstream exporter writes `app: undefined` when no app identity was
// supplied.  That is legal for an optional Tape member, but an arbitrary
// undefined anywhere else is not JSON and must remain a validation error.
const INPUT_TAPE_OPTIONAL_FIELDS = [
  "app",
  "analog",
  "rightAnalog",
  "touch",
  "touchSurfaces",
  "axes",
  "motion",
  "startFrame",
] as const;

function cloneInputTape(value: Tape): Tape {
  const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of INPUT_TAPE_OPTIONAL_FIELDS) {
    if (Object.hasOwn(normalized, field) && normalized[field] === undefined) delete normalized[field];
  }
  return cloneJson(normalized, "input tape") as Tape;
}

function errorSnapshot(error: unknown): RecordedError {
  if (error instanceof Error) {
    const value = error as Error & { code?: unknown };
    return {
      name: value.name || "Error",
      message: value.message || String(error),
      ...(typeof value.code === "string" ? { code: value.code } : {}),
    };
  }
  if (isRecord(error)) {
    return {
      name: typeof error.name === "string" && error.name ? error.name : "Error",
      message: typeof error.message === "string" ? error.message : String(error),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}

function restoreError(error: RecordedError): Error {
  const value = new Error(error.message);
  value.name = error.name;
  if (error.code !== undefined) (value as Error & { code?: string }).code = error.code;
  return value;
}

function mismatch(
  kind: RecordingMismatchKind,
  message: string,
  extra: Omit<RecordingMismatch, "kind" | "message"> = {},
): RecordingMismatch {
  return { kind, message, ...extra };
}

// A fixed, low-information marker is deliberately used after the diagnostic
// budget is exhausted.  It has stable bytes and cannot grow with hostile
// command ids, frames, or error messages.
const EFFECT_MISMATCH_SENTINEL: RecordingMismatch = Object.freeze({
  kind: "quota",
  message: "effect mismatch diagnostics truncated",
});
const EFFECT_MISMATCH_SENTINEL_BYTES = jsonBytes(JSON.stringify(EFFECT_MISMATCH_SENTINEL));

function mismatchLimits(limits: RecordingLimits): { entries: number; bytes: number } {
  const entries = limits.maxMismatchEntries ?? DEFAULT_EFFECT_MAX_MISMATCH_ENTRIES;
  const bytes = limits.maxMismatchBytes ?? DEFAULT_EFFECT_MAX_MISMATCH_BYTES;
  if (!isSafeInteger(entries) || entries < 1 || entries > 4096) {
    throw new RangeError("effect maxMismatchEntries must be between 1 and 4096");
  }
  if (!isSafeInteger(bytes) || bytes < EFFECT_MISMATCH_SENTINEL_BYTES || bytes > 4 * 1024 * 1024) {
    throw new RangeError(`effect maxMismatchBytes must be between ${EFFECT_MISMATCH_SENTINEL_BYTES} and 4194304`);
  }
  return { entries, bytes };
}

function diagnosticSnapshot(item: RecordingMismatch): { value: RecordingMismatch; bytes: number } | undefined {
  try {
    const json = JSON.stringify(item);
    if (typeof json !== "string") return undefined;
    return { value: JSON.parse(json) as RecordingMismatch, bytes: jsonBytes(json) };
  } catch {
    return undefined;
  }
}

/** Shared bounded lane for optional diagnostics; it never grows on quota. */
class BoundedMismatchDiagnostics {
  readonly maxEntries: number;
  readonly maxBytes: number;
  private readonly items: RecordingMismatch[] = [];
  private retainedBytes = 0;
  private truncated = false;
  private _incomplete = false;

  constructor(limits: RecordingLimits) {
    const resolved = mismatchLimits(limits);
    this.maxEntries = resolved.entries;
    this.maxBytes = resolved.bytes;
  }

  get incomplete(): boolean { return this._incomplete; }
  get bytes(): number { return this.retainedBytes; }
  get mismatches(): readonly RecordingMismatch[] {
    return this.items.map((item) => cloneJson(item, "recording mismatch"));
  }
  get firstMismatch(): RecordingMismatch | undefined {
    return this.items[0] && cloneJson(this.items[0], "recording mismatch");
  }

  add(item: RecordingMismatch): void {
    this._incomplete = true;
    if (this.truncated) return;
    const snapshot = diagnosticSnapshot(item);
    const reservedEntries = this.maxEntries - 1;
    const reservedBytes = this.maxBytes - EFFECT_MISMATCH_SENTINEL_BYTES;
    if (snapshot && this.items.length < reservedEntries && this.retainedBytes + snapshot.bytes <= reservedBytes) {
      this.items.push(snapshot.value);
      this.retainedBytes += snapshot.bytes;
      return;
    }
    this.truncated = true;
    this.items.push(EFFECT_MISMATCH_SENTINEL);
    this.retainedBytes += EFFECT_MISMATCH_SENTINEL_BYTES;
  }
}

function failValidation(kind: RecordingMismatchKind, message: string, extra: Omit<RecordingMismatch, "kind" | "message"> = {}): never {
  throw new RecordingValidationError(mismatch(kind, message, extra));
}

function validateRle(
  value: unknown,
  field: string,
  frames: number,
  maxValue = 0xffff,
): void {
  if (!Array.isArray(value)) failValidation("invalid-tape", `${field} must be an array`);
  let total = 0;
  let previous: number | undefined;
  for (const [index, pair] of value.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isSafeInteger(pair[0]) || !isSafeInteger(pair[1])) {
      failValidation("invalid-tape", `${field}[${index}] must be [value, positive run]`);
    }
    const item = pair as [number, number];
    if (item[0] < 0 || item[0] > maxValue || item[1] < 1) {
      failValidation("invalid-tape", `${field}[${index}] contains an out-of-range value`);
    }
    if (previous === item[0]) {
      failValidation("invalid-tape", `${field}[${index}] is not canonical RLE`);
    }
    previous = item[0];
    total += item[1];
    if (!Number.isSafeInteger(total) || total > frames) {
      failValidation("invalid-tape", `${field} expands beyond tape.frames`);
    }
  }
  if (total !== frames) failValidation("invalid-tape", `${field} expands to ${total}, expected ${frames}`);
}

function validateSparseFrames(
  value: unknown,
  field: string,
  frames: number,
  validateEntry: (entry: unknown, index: number) => void,
): void {
  if (!Array.isArray(value)) failValidation("invalid-tape", `${field} must be an array`);
  let previous = -1;
  for (const [index, entry] of value.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isSafeInteger(entry[0])) {
      failValidation("invalid-tape", `${field}[${index}] must be [frame, value]`);
    }
    const frame = (entry as [number, unknown])[0];
    if (frame < 0 || frame >= frames || frame <= previous) {
      failValidation("invalid-tape", `${field}[${index}] frame must be strictly increasing and in range`);
    }
    previous = frame;
    validateEntry(entry, index);
  }
}

function validateTapeShape(value: unknown): asserts value is Tape {
  if (!isRecord(value)) failValidation("invalid-tape", "input tape must be an object");
  if (!isSafeInteger(value.v) || value.v < 1 || value.v > 5) {
    failValidation("invalid-tape", "input tape.v must be an integer from 1 through 5");
  }
  if (!isSafeInteger(value.frames) || value.frames < 0 || value.frames > 36000) {
    failValidation("invalid-tape", "input tape.frames must be between 0 and 36000");
  }
  if (value.app !== undefined && typeof value.app !== "string") failValidation("invalid-tape", "input tape.app must be a string");
  validateRle(value.masks, "input tape.masks", value.frames);
  if (value.analog !== undefined) validateRle(value.analog, "input tape.analog", value.frames);
  if (value.rightAnalog !== undefined) validateRle(value.rightAnalog, "input tape.rightAnalog", value.frames);
  if (value.startFrame !== undefined && (!isSafeInteger(value.startFrame) || value.startFrame < 0)) {
    failValidation("invalid-tape", "input tape.startFrame must be a non-negative integer");
  }
  if (value.v < 2 && value.touch !== undefined) failValidation("invalid-tape", "touch requires tape version 2 or newer");
  if (value.v < 3 && value.touchSurfaces !== undefined) failValidation("invalid-tape", "touchSurfaces requires tape version 3 or newer");
  if (value.v < 4 && value.axes !== undefined) failValidation("invalid-tape", "axes requires tape version 4 or newer");
  if (value.v < 5 && value.motion !== undefined) failValidation("invalid-tape", "motion requires tape version 5");
  if (value.touch !== undefined) {
    validateSparseFrames(value.touch, "input tape.touch", value.frames, (entry, index) => {
      const contacts = (entry as [number, unknown])[1];
      if (!Array.isArray(contacts) || contacts.length > 16 || contacts.some((word) => !isSafeInteger(word) || word < -2147483648 || word > 0xffffffff)) {
        failValidation("invalid-tape", `input tape.touch[${index}] has invalid packed contacts`);
      }
    });
  }
  if (value.touchSurfaces !== undefined) {
    validateSparseFrames(value.touchSurfaces, "input tape.touchSurfaces", value.frames, (entry, index) => {
      const surfaces = (entry as [number, unknown])[1];
      if (!Array.isArray(surfaces) || surfaces.length > 16 || surfaces.some((surface) => surface !== 0 && surface !== 1)) {
        failValidation("invalid-tape", `input tape.touchSurfaces[${index}] has invalid surface lanes`);
      }
    });
  }
  if (value.axes !== undefined) {
    validateSparseFrames(value.axes, "input tape.axes", value.frames, (entry, index) => {
      const axes = (entry as [number, unknown])[1];
      if (!Array.isArray(axes)) failValidation("invalid-tape", `input tape.axes[${index}] must contain an array`);
      for (const delta of axes) {
        if (!isRecord(delta) || !isSafeInteger(delta.axis) || (delta.axis !== 0 && delta.axis !== 1) || !isSafeInteger(delta.delta) || delta.delta < -2147483648 || delta.delta > 2147483647) {
          failValidation("invalid-tape", `input tape.axes[${index}] contains an invalid axis delta`);
        }
      }
    });
  }
  if (value.motion !== undefined) {
    // Keep frame/index checks here, then let the pinned upstream replay
    // expansion perform the complete f32/quality/reference-frame/epoch
    // validation.  This avoids a second motion contract in the SDK.
    validateSparseFrames(value.motion, "input tape.motion", value.frames, () => {});
    try {
      expandTapeMotion(value as unknown as Tape);
    } catch (error) {
      failValidation(
        "invalid-tape",
        `input tape.motion is not a valid upstream motion state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Throw on malformed input and return an isolated JSON copy. */
export function validateInputTape(value: unknown): Tape {
  validateTapeShape(value);
  return cloneInputTape(value);
}

/** Non-throwing validation for UI/debug panels. */
export function checkInputTape(value: unknown): { ok: true; tape: Tape } | { ok: false; firstMismatch: RecordingMismatch } {
  try {
    return { ok: true, tape: validateInputTape(value) };
  } catch (error) {
    if (error instanceof RecordingValidationError) return { ok: false, firstMismatch: error.mismatch };
    throw error;
  }
}

function currentDevtools(): PocketDevtoolsApi {
  const api = g.__pocketDevtools;
  if (!api || typeof api.dumpTape !== "function" || typeof api.replay !== "function") {
    throw new RecordingValidationError({
      kind: "invalid-tape",
      message: "PocketJS __pocketDevtools.dumpTape/replay is not installed; mount the upstream guest first",
    });
  }
  return api;
}

/** Export the current upstream flight recorder; this never creates another input recorder. */
export function dumpInputTape(): Tape {
  return validateInputTape(currentDevtools().dumpTape!());
}

/** Strictly validate then delegate replay to the upstream devtools shim. */
export function replayInputTape(value: unknown): void {
  const tape = validateInputTape(value);
  currentDevtools().replay!(tape);
}

export const getInputTape = dumpInputTape;
export const dumpCurrentInputTape = dumpInputTape;
export const captureUpstreamTape = dumpInputTape;
export const validateTape = validateInputTape;
export const replayTape = replayInputTape;

function buildMetadataSource(): unknown {
  return g.__pocketBuildMetadata ?? g.__pocketBuildMeta ?? g.__pocketGuestMetadata;
}

/**
 * Read the host-provided build identity without guessing hashes.  Hosts should
 * set `globalThis.__pocketBuildMetadata` before mounting the guest.  The app
 * and simulation rate are harmless fallbacks for headless consumers.
 */
export function currentBuildMetadata(explicit?: PocketBuildMetadata): PocketBuildMetadata {
  const source = explicit ?? buildMetadataSource();
  const value: Record<string, unknown> = isRecord(source) ? source : {};
  const out: Record<string, unknown> = { ...value };
  if (out.app === undefined && typeof g.__pocketApp === "string") out.app = g.__pocketApp;
  if (out.simulationHz === undefined && isFiniteNumber(g.__simHz)) out.simulationHz = g.__simHz;
  if (!isJsonValue(out)) {
    throw new RecordingValidationError({ kind: "invalid-build", message: "build metadata must be a JSON object" });
  }
  return cloneJson(out, "build metadata") as PocketBuildMetadata;
}

/** Optional host bootstrap hook; no polling or frame work is installed. */
export function setBuildMetadata(metadata: PocketBuildMetadata): void {
  g.__pocketBuildMetadata = currentBuildMetadata(metadata);
}

function validateBuild(value: unknown): asserts value is PocketBuildMetadata {
  if (!isRecord(value) || !isJsonValue(value)) failValidation("invalid-build", "recording.build must be a JSON object");
}

function normalizeRecordedError(value: unknown, field: string): RecordedError {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name || typeof value.message !== "string") {
    failValidation("invalid-effect-tape", `${field} must be {name,message}`);
  }
  if (value.code !== undefined && typeof value.code !== "string") failValidation("invalid-effect-tape", `${field}.code must be a string`);
  return {
    name: value.name,
    message: value.message,
    ...(value.code === undefined ? {} : { code: value.code }),
  };
}

function validateEffectTapeShape(value: unknown, limits: RecordingLimits = {}): asserts value is EffectTape {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries)) {
    failValidation("invalid-effect-tape", "effect tape must be {v:1,entries:[]}");
  }
  if (value.incomplete !== undefined && typeof value.incomplete !== "boolean") {
    failValidation("invalid-effect-tape", "effect incomplete must be a boolean");
  }
  if (value.incomplete === true) {
    failValidation("invalid-effect-tape", "effect tape is incomplete and cannot be replayed");
  }
  const maxEntries = limits.maxEntries ?? DEFAULT_EFFECT_MAX_ENTRIES;
  if (!isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 36000) failValidation("invalid-effect-tape", "effect maxEntries must be between 1 and 36000");
  if (value.entries.length > maxEntries) failValidation("invalid-effect-tape", "effect tape exceeds maxEntries");
  let diagnosticLimits: { entries: number; bytes: number };
  try {
    diagnosticLimits = mismatchLimits(limits);
  } catch (error) {
    failValidation("invalid-effect-tape", error instanceof Error ? error.message : String(error));
  }
  if (Object.hasOwn(value, "mismatches") && value.mismatches === undefined) {
    failValidation("invalid-effect-tape", "effect mismatches must not be undefined");
  }
  let bytes = 0;
  const ids = new Set<number>();
  for (const [index, raw] of value.entries.entries()) {
    if (!isRecord(raw) || !isSafeInteger(raw.index) || raw.index !== index || !isSafeInteger(raw.id) || raw.id < 1 || typeof raw.kind !== "string" || !raw.kind || !isSafeInteger(raw.commandFrame) || raw.commandFrame < 0 || typeof raw.status !== "string") {
      failValidation("invalid-effect-tape", `effect entries[${index}] has an invalid command`);
    }
    if (ids.has(raw.id)) failValidation("invalid-effect-tape", `effect entries[${index}] repeats an id`);
    ids.add(raw.id);
    const hasParamsJSON = Object.hasOwn(raw, "paramsJSON");
    const hasParamsUndefined = Object.hasOwn(raw, "paramsUndefined");
    if (hasParamsJSON && hasParamsUndefined) {
      failValidation("invalid-effect-tape", `effect entries[${index}] records both paramsJSON and paramsUndefined`);
    }
    if (hasParamsJSON) {
      if (typeof raw.paramsJSON !== "string") failValidation("invalid-effect-tape", `effect entries[${index}].paramsJSON must be a string`);
      parseSnapshot(raw.paramsJSON, `effect entries[${index}].paramsJSON`);
      bytes += jsonBytes(raw.paramsJSON);
    } else if (!hasParamsUndefined) {
      failValidation("invalid-effect-tape", `effect entries[${index}] must record paramsJSON or paramsUndefined`);
    }
    if (hasParamsUndefined && raw.paramsUndefined !== true) failValidation("invalid-effect-tape", `effect entries[${index}].paramsUndefined must be true when present`);
    if (raw.status !== "pending" && raw.status !== "delivered" && raw.status !== "thrown" && raw.status !== "cancelled") failValidation("invalid-effect-tape", `effect entries[${index}].status is invalid`);
    const hasResultJSON = Object.hasOwn(raw, "resultJSON");
    const hasResultUndefined = Object.hasOwn(raw, "resultUndefined");
    const hasError = Object.hasOwn(raw, "error");
    if (hasResultJSON && hasResultUndefined) {
      failValidation("invalid-effect-tape", `effect entries[${index}] records both resultJSON and resultUndefined`);
    }
    if (hasResultJSON && hasError) {
      failValidation("invalid-effect-tape", `effect entries[${index}] records both a result and error`);
    }
    if (hasResultJSON) {
      if (typeof raw.resultJSON !== "string") failValidation("invalid-effect-tape", `effect entries[${index}].resultJSON must be a string`);
      parseSnapshot(raw.resultJSON, `effect entries[${index}].resultJSON`);
      bytes += jsonBytes(raw.resultJSON);
    }
    if (hasResultUndefined && raw.resultUndefined !== true) failValidation("invalid-effect-tape", `effect entries[${index}].resultUndefined must be true when present`);
    if (hasError) {
      normalizeRecordedError(raw.error, `effect entries[${index}].error`);
      bytes += jsonBytes(JSON.stringify(raw.error));
    }
    const hasDeliveryFrame = Object.hasOwn(raw, "deliveryFrame");
    if (hasDeliveryFrame && (!isSafeInteger(raw.deliveryFrame) || raw.deliveryFrame < raw.commandFrame)) {
      failValidation("invalid-effect-tape", `effect entries[${index}].deliveryFrame must be >= commandFrame`);
    }
    if (raw.status === "delivered") {
      if (!hasDeliveryFrame || (!hasResultJSON && !hasResultUndefined && !hasError)) {
        failValidation("invalid-effect-tape", `effect entries[${index}] delivered without a frame/result`);
      }
    } else if (raw.status === "thrown") {
      if (!hasError || hasDeliveryFrame || hasResultJSON || hasResultUndefined) {
        failValidation("invalid-effect-tape", `effect entries[${index}] thrown status is inconsistent`);
      }
    } else if (raw.status === "pending" || raw.status === "cancelled") {
      if (hasDeliveryFrame || hasResultJSON || hasResultUndefined || (raw.status === "pending" && hasError) || (raw.status === "cancelled" && !hasError)) {
        failValidation("invalid-effect-tape", `effect entries[${index}] ${raw.status} status has a delivery`);
      }
    }
  }
  if (value.mismatches !== undefined) {
    if (!Array.isArray(value.mismatches)) failValidation("invalid-effect-tape", "effect mismatches must be an array");
    if (value.mismatches.length > diagnosticLimits.entries) failValidation("invalid-effect-tape", "effect mismatches exceeds maxMismatchEntries");
    let mismatchBytes = 0;
    for (const [index, item] of value.mismatches.entries()) {
      if (!isRecord(item) || typeof item.kind !== "string" || typeof item.message !== "string") failValidation("invalid-effect-tape", `effect mismatches[${index}] is invalid`);
      const snapshot = diagnosticSnapshot(item as RecordingMismatch);
      if (!snapshot) failValidation("invalid-effect-tape", `effect mismatches[${index}] is not JSON serializable`);
      mismatchBytes += snapshot.bytes;
      if (!Number.isSafeInteger(mismatchBytes) || mismatchBytes > diagnosticLimits.bytes) failValidation("invalid-effect-tape", "effect mismatches exceeds maxMismatchBytes");
    }
    if (Object.hasOwn(value, "mismatchBytes") && value.mismatchBytes !== mismatchBytes) failValidation("invalid-effect-tape", "effect mismatchBytes does not match diagnostics");
    if (value.mismatches.length > 0) failValidation("invalid-effect-tape", "effect tape carries mismatch diagnostics and is not replayable");
  } else if (Object.hasOwn(value, "mismatchBytes") && value.mismatchBytes !== 0) {
    failValidation("invalid-effect-tape", "effect mismatchBytes must be zero without diagnostics");
  }
  if (Object.hasOwn(value, "mismatchBytes") && (!isSafeInteger(value.mismatchBytes) || value.mismatchBytes < 0)) failValidation("invalid-effect-tape", "effect mismatchBytes must be a non-negative integer");
  if (Object.hasOwn(value, "bytes") && (!isSafeInteger(value.bytes) || value.bytes < 0)) failValidation("invalid-effect-tape", "effect bytes must be a non-negative integer");
  const maxBytes = limits.maxBytes ?? DEFAULT_EFFECT_MAX_BYTES;
  if (!isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) failValidation("invalid-effect-tape", "effect maxBytes is out of range");
  if (bytes > maxBytes) failValidation("invalid-effect-tape", "effect tape exceeds maxBytes");
}

export function validateEffectTape(value: unknown, limits: RecordingLimits = {}): EffectTape {
  validateEffectTapeShape(value, limits);
  return cloneJson(value, "effect tape") as EffectTape;
}

function validateRecordingShape(value: unknown): asserts value is PocketRecording {
  if (!isRecord(value) || value.v !== RECORDING_VERSION || value.tape === undefined || value.build === undefined) {
    failValidation("invalid-recording", "recording must be {v:1,tape,build}");
  }
  validateTapeShape(value.tape);
  validateBuild(value.build);
  if (value.effects !== undefined) validateEffectTapeShape(value.effects);
}

export function validateRecording(value: unknown): PocketRecording {
  validateRecordingShape(value);
  return cloneJson(value, "recording") as PocketRecording;
}

function recordClone(entry: EffectRecord): EffectRecord {
  return cloneJson(entry, "effect entry");
}

class EffectRecorderImpl implements EffectRecorder {
  readonly driver: EffectDriver;
  private active = true;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly diagnostics: BoundedMismatchDiagnostics;
  private bytesUsed = 0;
  private readonly recorded: EffectRecord[] = [];
  private readonly byId = new Map<number, EffectRecord>();
  private readonly previousTrace: ((event: EffectTraceEvent) => void) | undefined;
  private readonly trace: (event: EffectTraceEvent) => void;
  private finished = false;

  private readonly previousHostDriver: EffectDriver | undefined;

  constructor(private readonly underlying: EffectDriver, limits: EffectRecorderOptions = {}) {
    if (typeof underlying !== "function") throw new TypeError("effect recording requires an upstream EffectDriver");
    this.maxEntries = limits.maxEntries ?? DEFAULT_EFFECT_MAX_ENTRIES;
    this.maxBytes = limits.maxBytes ?? DEFAULT_EFFECT_MAX_BYTES;
    if (!isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > 36000) throw new RangeError("effect maxEntries must be between 1 and 36000");
    if (!isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 64 * 1024 * 1024) throw new RangeError("effect maxBytes is out of range");
    this.diagnostics = new BoundedMismatchDiagnostics(limits);
    this.previousTrace = g.__pocketEffectTrace;
    this.previousHostDriver = g.__pocketEffectDriver;
    this.trace = (event) => {
      this.previousTrace?.(event);
      this.onTrace(event);
    };
    g.__pocketEffectTrace = this.trace;
    this.driver = (command, deliver) => this.invoke(command, deliver);
    if (limits.forceHostDriver) g.__pocketEffectDriver = this.driver;
  }

  get entries(): readonly EffectRecord[] { return this.recorded.map(recordClone); }
  get mismatches(): readonly RecordingMismatch[] { return this.diagnostics.mismatches; }
  get firstMismatch(): RecordingMismatch | undefined { return this.diagnostics.firstMismatch; }
  get incomplete(): boolean { return this.diagnostics.incomplete; }

  private problem(item: RecordingMismatch): void {
    this.diagnostics.add(item);
  }

  private storeError(entry: EffectRecord, error: unknown, frame: number): void {
    const captured = errorSnapshot(error);
    const errorBytes = jsonBytes(JSON.stringify(captured));
    if (this.bytesUsed + errorBytes > this.maxBytes) {
      entry.error = { name: "QuotaExceeded", message: `effect recorder exceeded maxBytes=${this.maxBytes}` };
      this.problem(mismatch("quota", `effect recorder exceeded maxBytes=${this.maxBytes}`, { id: entry.id, frame }));
      return;
    }
    entry.error = captured;
    this.bytesUsed += errorBytes;
  }

  private invoke(command: EffectCommand, deliver: (result: unknown) => void): void {
    let entry: EffectRecord | undefined;
    try {
      if (!this.active) {
        this.problem(mismatch("delivery-cancelled", "effect driver used after recorder disposal", { id: command.id, frame: command.frame }));
      } else if (this.recorded.length >= this.maxEntries) {
        this.problem(mismatch("quota", `effect recorder exceeded maxEntries=${this.maxEntries}`, { id: command.id, frame: command.frame }));
      } else {
        const params = jsonSnapshot(command.payload, `effect ${command.kind} params`);
        const commandBytes = jsonBytes(command.kind) + params.bytes;
        if (this.bytesUsed + commandBytes > this.maxBytes) {
          this.problem(mismatch("quota", `effect recorder exceeded maxBytes=${this.maxBytes}`, { id: command.id, frame: command.frame }));
        } else {
          entry = {
            index: this.recorded.length,
            id: command.id,
            kind: command.kind,
            commandFrame: command.frame,
            ...(params.undefined ? { paramsUndefined: true } : { paramsJSON: params.json }),
            status: "pending",
          };
          this.recorded.push(entry);
          this.byId.set(command.id, entry);
          this.bytesUsed += commandBytes;
        }
      }
    } catch (error) {
      this.problem(mismatch("command", error instanceof Error ? error.message : String(error), { id: command.id, frame: command.frame }));
    }

    let called = false;
    const wrappedDeliver = (result: unknown): void => {
      if (!this.active) {
        this.problem(mismatch("delivery-cancelled", `effect ${command.id} delivered after recorder disposal`, { id: command.id, frame: virtualFrame() }));
        deliver(result);
        return;
      }
      if (this.finished) {
        this.problem(mismatch("delivery-late", `effect ${command.id} delivered after recording finished`, { id: command.id, frame: virtualFrame() }));
        deliver(result);
        return;
      }
      if (called) {
        this.problem(mismatch("delivery-duplicate", `effect ${command.id} delivered more than once`, { id: command.id, frame: virtualFrame() }));
        return;
      }
      called = true;
      if (entry) {
        if (entry.status === "cancelled") {
          this.problem(mismatch("delivery-cancelled", `effect ${command.id} delivered after cancellation`, { id: command.id, frame: virtualFrame() }));
          deliver(result);
          return;
        }
        try {
          if (result instanceof Error) {
            this.storeError(entry, result, virtualFrame());
          } else {
            const snapshot = jsonSnapshot(result, `effect ${command.kind} result`);
            if (this.bytesUsed + snapshot.bytes > this.maxBytes) {
              entry.status = "cancelled";
              entry.error = { name: "QuotaExceeded", message: `effect recorder exceeded maxBytes=${this.maxBytes}` };
              this.problem(mismatch("quota", `effect recorder exceeded maxBytes=${this.maxBytes}`, { id: command.id, frame: virtualFrame() }));
            } else if (snapshot.undefined) {
              entry.resultUndefined = true;
              this.bytesUsed += snapshot.bytes;
            } else {
              entry.resultJSON = snapshot.json;
              this.bytesUsed += snapshot.bytes;
            }
          }
        } catch (error) {
          this.storeError(entry, error, virtualFrame());
          this.problem(mismatch("command", error instanceof Error ? error.message : String(error), { id: command.id, frame: virtualFrame() }));
        }
      } else {
        this.problem(mismatch("delivery-unmatched", `effect ${command.id} delivered without a recorded command`, { id: command.id, frame: virtualFrame() }));
      }
      // Preserve live app behavior even when the diagnostic budget is full.
      deliver(result);
    };

    try {
      this.underlying(command, wrappedDeliver);
    } catch (error) {
      if (entry) {
        entry.status = "thrown";
        this.storeError(entry, error, command.frame);
      }
      throw error;
    }
  }

  private onTrace(event: EffectTraceEvent): void {
    if (!event || (event.t !== "command" && event.t !== "delivery")) return;
    if (event.t !== "delivery") return;
    const entry = this.byId.get(event.id);
    if (!entry) {
      this.problem(mismatch("delivery-unmatched", `effect delivery ${event.id} has no recorded command`, { id: event.id, frame: event.frame }));
      return;
    }
    if (entry.deliveryFrame !== undefined) {
      this.problem(mismatch("delivery-duplicate", `effect ${event.id} delivery trace repeated`, { id: event.id, frame: event.frame }));
      return;
    }
    if (event.kind !== entry.kind) {
      this.problem(mismatch("delivery-unmatched", `effect ${event.id} delivery kind ${event.kind} does not match ${entry.kind}`, { id: event.id, frame: event.frame, expected: entry.kind, actual: event.kind }));
    }
    if (entry.status === "cancelled") {
      this.problem(mismatch("delivery-cancelled", `effect ${event.id} delivered after cancellation`, { id: event.id, frame: event.frame }));
      return;
    }
    if (event.frame < entry.commandFrame) {
      this.problem(mismatch("delivery-late", `effect ${event.id} delivered before its command frame`, { id: event.id, frame: event.frame, expected: entry.commandFrame, actual: event.frame }));
    }
    if (entry.resultJSON === undefined && !entry.resultUndefined && !entry.error) {
      this.problem(mismatch("delivery-unmatched", `effect ${event.id} delivery had no recorded result`, { id: event.id, frame: event.frame }));
    }
    entry.deliveryFrame = event.frame;
    entry.status = "delivered";
  }

  cancel(id: number, reason = "effect cancelled"): void {
    const entry = this.byId.get(id);
    if (!entry) {
      this.problem(mismatch("delivery-unmatched", `cannot cancel unknown effect ${id}`, { id }));
      return;
    }
    if (entry.status !== "pending") {
      this.problem(mismatch("delivery-cancelled", `effect ${id} was cancelled after ${entry.status}`, { id, frame: virtualFrame() }));
      return;
    }
    entry.status = "cancelled";
    this.storeError(entry, { name: "Cancellation", message: reason }, virtualFrame());
    this.problem(mismatch("delivery-cancelled", `effect ${id} was cancelled`, { id, frame: virtualFrame() }));
  }

  snapshot(): EffectTape {
    return {
      v: 1,
      entries: this.recorded.map(recordClone),
      ...(this.mismatches.length ? { mismatches: this.mismatches as RecordingMismatch[] } : {}),
      bytes: this.bytesUsed,
      incomplete: this.incomplete,
      mismatchBytes: this.diagnostics.bytes,
    };
  }

  finish(): EffectTape {
    this.finished = true;
    for (const entry of this.recorded) {
      if (entry.status === "pending") {
        this.problem(mismatch("delivery-missing", `effect ${entry.id} never reached an upstream delivery frame`, { id: entry.id, frame: virtualFrame(), index: entry.index }));
      }
    }
    return this.snapshot();
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    if (g.__pocketEffectTrace === this.trace) g.__pocketEffectTrace = this.previousTrace;
    if (g.__pocketEffectDriver === this.driver) g.__pocketEffectDriver = this.previousHostDriver;
  }
}

/** Wrap a caller-supplied upstream driver. Nothing is installed until requested. */
export function createEffectRecorder(driver: EffectDriver, limits: EffectRecorderOptions = {}): EffectRecorder {
  return new EffectRecorderImpl(driver, limits);
}

/** Install a recorder through the upstream app-driver API. */
export function installEffectRecordingDriver(driver: EffectDriver, limits: EffectRecorderOptions = {}): EffectRecorder {
  const recorder = createEffectRecorder(driver, limits);
  installEffectDriver(recorder.driver);
  return recorder;
}

function sameSnapshot(a: EffectRecord, command: EffectCommand): boolean {
  const actual = jsonSnapshot(command.payload, `effect ${command.kind} params`);
  if (a.paramsUndefined) return actual.undefined;
  return !actual.undefined && actual.json === a.paramsJSON;
}

function replayResult(entry: EffectRecord): unknown {
  if (entry.error !== undefined) return restoreError(entry.error);
  if (entry.resultUndefined) return undefined;
  return parseSnapshot(entry.resultJSON, `effect ${entry.id} result`);
}

class EffectReplayImpl implements EffectReplay {
  readonly driver: EffectDriver;
  private readonly expected: EffectRecord[];
  private readonly diagnostics: BoundedMismatchDiagnostics;
  private readonly pending = new Map<number, { entry: EffectRecord; dispose: () => void; called: boolean }>();
  private readonly previousTrace: ((event: EffectTraceEvent) => void) | undefined;
  private readonly trace: (event: EffectTraceEvent) => void;
  private readonly previousHostDriver: EffectDriver | undefined;
  private active = true;
  private next = 0;

  constructor(tape: EffectTape, options: EffectReplayOptions = {}) {
    this.diagnostics = new BoundedMismatchDiagnostics(options);
    this.expected = validateEffectTape(tape, options).entries.map(recordClone);
    this.previousTrace = g.__pocketEffectTrace;
    this.trace = (event) => {
      this.previousTrace?.(event);
      this.onTrace(event);
    };
    g.__pocketEffectTrace = this.trace;
    this.previousHostDriver = g.__pocketEffectDriver;
    this.driver = (command, deliver) => this.invoke(command, deliver);
    installEffectDriver(this.driver);
    if (options.forceHostDriver ?? true) g.__pocketEffectDriver = this.driver;
  }

  get commandIndex(): number { return this.next; }
  get mismatches(): readonly RecordingMismatch[] { return this.diagnostics.mismatches; }
  get firstMismatch(): RecordingMismatch | undefined { return this.diagnostics.firstMismatch; }

  private fail(item: RecordingMismatch): never {
    this.diagnostics.add(item);
    throw new RecordingMismatchError(item);
  }

  private invoke(command: EffectCommand, deliver: (result: unknown) => void): void {
    if (!this.active) this.fail(mismatch("delivery-cancelled", "effect replay used after dispose", { id: command.id, frame: command.frame }));
    const entry = this.expected[this.next];
    if (!entry) this.fail(mismatch("command", `unmatched effect command ${command.kind}#${command.id}`, { id: command.id, frame: command.frame, index: this.next }));
    let paramsMatch = false;
    try {
      paramsMatch = sameSnapshot(entry, command);
    } catch (error) {
      this.fail(mismatch("command", error instanceof Error ? error.message : String(error), { id: command.id, frame: command.frame, index: this.next }));
    }
    if (entry.id !== command.id || entry.kind !== command.kind || entry.commandFrame !== command.frame || !paramsMatch) {
      this.fail(mismatch("command", `effect command mismatch at index ${this.next}`, {
        id: command.id,
        frame: command.frame,
        index: this.next,
        expected: { id: entry.id, kind: entry.kind, frame: entry.commandFrame, paramsJSON: entry.paramsJSON, paramsUndefined: entry.paramsUndefined },
        actual: { id: command.id, kind: command.kind, frame: command.frame },
      }));
    }
    this.next++;
    if (entry.status === "thrown") {
      // Preserve the upstream driver's throw semantics.  runEffect() has
      // already installed the pending command, exactly as it does for the
      // live driver; the caller owns any subsequent cancellation/reset.
      throw restoreError(entry.error!);
    }
    if (entry.status === "cancelled") {
      this.fail(mismatch("delivery-cancelled", `effect ${entry.id} was cancelled in the recording`, { id: entry.id, frame: command.frame }));
    }
    if (entry.status !== "delivered" || entry.deliveryFrame === undefined) {
      this.fail(mismatch("invalid-effect-tape", `effect ${entry.id} has no replayable delivery`, { id: entry.id, frame: command.frame }));
    }

    let called = false;
    const deliverAt = (): void => {
      if (!this.active) {
        this.fail(mismatch("delivery-cancelled", `effect ${entry.id} was cancelled before delivery`, { id: entry.id, frame: virtualFrame() }));
      }
      const now = virtualFrame();
      if (now < entry.deliveryFrame!) {
        // The upstream clock should only invoke after() at its due frame. A
        // host that does otherwise has violated the replay transaction.
        this.fail(mismatch("delivery-early", `effect ${entry.id} delivered before recorded frame`, { id: entry.id, frame: now, expected: entry.deliveryFrame, actual: now }));
      }
      if (now > entry.deliveryFrame!) {
        this.fail(mismatch("delivery-late", `effect ${entry.id} delivery missed recorded frame`, { id: entry.id, frame: now, expected: entry.deliveryFrame, actual: now }));
      }
      if (called) {
        this.fail(mismatch("delivery-duplicate", `effect ${entry.id} replay callback ran twice`, { id: entry.id, frame: now }));
      }
      called = true;
      const waiter = this.pending.get(entry.id);
      if (waiter) waiter.called = true;
      deliver(replayResult(entry));
    };

    const now = virtualFrame();
    let cancel: () => void = () => {};
    if (entry.deliveryFrame === now) deliverAt();
    else if (entry.deliveryFrame > now) cancel = after((entry.deliveryFrame - now) / simulationHz(), deliverAt);
    else this.fail(mismatch("delivery-late", `effect ${entry.id} was already past its recorded delivery frame`, { id: entry.id, frame: now, expected: entry.deliveryFrame, actual: now }));
    this.pending.set(entry.id, { entry, dispose: cancel, called });
  }

  private onTrace(event: EffectTraceEvent): void {
    if (!event || event.t !== "delivery") return;
    const waiter = this.pending.get(event.id);
    if (!waiter) return this.fail(mismatch("delivery-unmatched", `unmatched replay delivery ${event.id}`, { id: event.id, frame: event.frame }));
    if (event.kind !== waiter.entry.kind) this.fail(mismatch("delivery-unmatched", `replay delivery ${event.id} kind differs`, { id: event.id, frame: event.frame, expected: waiter.entry.kind, actual: event.kind }));
    if (event.frame < waiter.entry.deliveryFrame!) this.fail(mismatch("delivery-early", `replay delivery ${event.id} arrived early`, { id: event.id, frame: event.frame, expected: waiter.entry.deliveryFrame, actual: event.frame }));
    if (event.frame > waiter.entry.deliveryFrame!) this.fail(mismatch("delivery-late", `replay delivery ${event.id} arrived late`, { id: event.id, frame: event.frame, expected: waiter.entry.deliveryFrame, actual: event.frame }));
    if (!waiter.called) this.fail(mismatch("delivery-unmatched", `replay delivery ${event.id} was not produced by the driver`, { id: event.id, frame: event.frame }));
    this.pending.delete(event.id);
  }

  assertComplete(): void {
    const first = this.firstMismatch;
    if (first) throw new RecordingMismatchError(first);
    if (this.next < this.expected.length) {
      const entry = this.expected[this.next]!;
      this.fail(mismatch("command-missing", `recorded effect command ${entry.kind}#${entry.id} was not issued`, { id: entry.id, frame: virtualFrame(), index: this.next }));
    }
    const pending = [...this.pending.values()].find((item) => !item.called);
    if (pending) this.fail(mismatch("delivery-missing", `effect ${pending.entry.id} did not reach its recorded delivery`, { id: pending.entry.id, frame: virtualFrame(), expected: pending.entry.deliveryFrame }));
    if (this.pending.size) {
      const first = this.pending.values().next().value as { entry: EffectRecord } | undefined;
      if (!first) return;
      const entry = first.entry;
      this.fail(mismatch("delivery-missing", `effect ${entry.id} delivery trace was not observed`, { id: entry.id, frame: virtualFrame(), expected: entry.deliveryFrame }));
    }
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    for (const waiter of this.pending.values()) waiter.dispose();
    this.pending.clear();
    if (g.__pocketEffectTrace === this.trace) g.__pocketEffectTrace = this.previousTrace;
    if (g.__pocketEffectDriver === this.driver) g.__pocketEffectDriver = this.previousHostDriver;
  }
}

/** Create and install a strict replay driver backed by an effect tape. */
export function createEffectReplayDriver(tape: EffectTape, options: EffectReplayOptions = {}): EffectReplay {
  return new EffectReplayImpl(tape, options);
}

export const installEffectReplayDriver = createEffectReplayDriver;

export function exportRecording(options: ExportRecordingOptions = {}): PocketRecording {
  const recording: PocketRecording = {
    v: RECORDING_VERSION,
    tape: dumpInputTape(),
    build: currentBuildMetadata(options.build),
    ...(options.effects ? { effects: options.effects.snapshot() } : {}),
  };
  validateRecording(recording);
  return cloneJson(recording, "recording") as PocketRecording;
}

export const dumpRecording = exportRecording;
export const captureRecording = exportRecording;

export function replayRecording(value: unknown, options: ReplayRecordingOptions = {}): EffectReplay | undefined {
  const recording = validateRecording(value);
  let replay: EffectReplay | undefined;
  if (recording.effects !== undefined && options.installEffects !== false) {
    replay = createEffectReplayDriver(recording.effects, options);
  }
  replayInputTape(recording.tape);
  return replay;
}
