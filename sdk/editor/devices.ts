/**
 * Local Flutter device discovery and deployment for Pocket Studio.
 *
 * This module deliberately owns process orchestration only.  It does not
 * accept a path or command from an HTTP request: the server supplies trusted
 * project/consumer resolvers, while this file constructs the small, fixed
 * command sets below.  Builds remain the normal build_guest -> QJBC + PAK
 * pipeline and Flutter is started with the consumer's own host project.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultLogLines = 400;
const defaultLogLineBytes = 8 * 1024;
const defaultListTimeoutMs = 15_000;
const defaultBuildTimeoutMs = 10 * 60_000;
const defaultRunTimeoutMs = 30 * 60_000;
const defaultMaxConcurrentDeployments = 1;
const maxCommandOutputBytes = 512 * 1024;
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const deviceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const expectedBuildSystemScript = "bun scripts/build_mini_apps.ts && bun run build";
const requiredAssetFiles = ["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"] as const;

export type FlutterPlatform = "ios" | "android" | "macos" | "linux" | "windows" | "web" | "unknown";

/** The target classes that can be selected by the Editor UI. */
export type FlutterDeviceKind =
  | "ios-simulator"
  | "android-emulator"
  | "ios-device"
  | "android-device"
  | "other";

export type DeploymentTarget =
  | FlutterDeviceKind
  | "ios-sim"
  | "android"
  | "real-device";

export type FlutterMachineDevice = Record<string, unknown>;

export type FlutterDevice = {
  id: string;
  name: string;
  platform: FlutterPlatform;
  kind: FlutterDeviceKind;
  available: boolean;
  supported: boolean;
  emulator: boolean;
  targetPlatform?: string;
  sdk?: string;
  version?: string;
  category?: string;
  raw: FlutterMachineDevice;
};

export type DeploymentPhase = "manager" | "build" | "flutter";
export type DeploymentLogStream = "system" | "stdout" | "stderr";

export type DeploymentLog = {
  sequence: number;
  timestamp: string;
  phase: DeploymentPhase;
  stream: DeploymentLogStream;
  line: string;
};

export type DeploymentState =
  | "queued"
  | "building"
  | "starting"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "canceled";

export type FlutterRunMode = "debug" | "profile" | "release";

export type DeploymentRequest = {
  projectId: string;
  deviceId: string;
  /** Optional class check used by a UI that groups iOS/Android/real devices. */
  target?: DeploymentTarget;
  /** Release/profile are supported only when the consumer has those platform configs. */
  mode?: FlutterRunMode;
};

export type DeploymentBuildPlan = {
  command: string[];
  cwd: string;
  strategy: "consumer-build-system" | "build-guest";
  assetRoot: string;
  childApps: boolean;
};

export type DeploymentPlan = {
  projectId: string;
  device: FlutterDevice;
  projectRoot: string;
  flutterRoot: string;
  build: DeploymentBuildPlan;
  run: {
    command: string[];
    cwd: string;
    mode: FlutterRunMode;
  };
};

export type DeploymentSnapshot = {
  id: string;
  projectId: string;
  device: FlutterDevice;
  state: DeploymentState;
  phase: DeploymentPhase;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  cancelRequested: boolean;
  plan: DeploymentPlan;
  logs: DeploymentLog[];
};

export type DeploymentLogPage = {
  deploymentId: string;
  logs: DeploymentLog[];
  nextSequence: number;
};

export type DeviceManagerErrorCode =
  | "invalid_project_id"
  | "invalid_device_id"
  | "invalid_command"
  | "flutter_unavailable"
  | "device_discovery_failed"
  | "device_not_found"
  | "device_unavailable"
  | "device_target_mismatch"
  | "flutter_binding_missing"
  | "invalid_project_root"
  | "invalid_flutter_root"
  | "consumer_contract_mismatch"
  | "asset_missing"
  | "invalid_artifact"
  | "deployment_not_found"
  | "deployment_busy"
  | "deployment_limit"
  | "deployment_failed"
  | "deployment_canceled"
  | "deployment_timeout"
  | "manager_disposed";

export class DeviceManagerError extends Error {
  readonly code: DeviceManagerErrorCode;
  readonly status: number;
  readonly cause?: unknown;

  constructor(code: DeviceManagerErrorCode, message: string, status = 400, cause?: unknown) {
    super(message);
    this.name = "DeviceManagerError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export type ProcessLike = {
  stdout?: unknown;
  stderr?: unknown;
  exited: Promise<number>;
  kill: (signal?: string | number) => void;
};

export type SpawnOptions = {
  cwd: string;
  stdout: "pipe";
  stderr: "pipe";
  env?: Record<string, string | undefined>;
};

export type SpawnProcess = (command: readonly string[], options: SpawnOptions) => ProcessLike;

export type DeviceManagerOptions = {
  /** A trusted Editor project resolver. The project id is never a web path. */
  projectDirectory: (projectId: string) => string | Promise<string>;
  /** A trusted consumer Flutter-root resolver. Return undefined for an unbound project. */
  flutterDirectory: (projectId: string) => string | undefined | Promise<string | undefined>;
  /** Public update trust only, supplied by the trusted Editor, never HTTP argv. */
  updateConfig?: (projectId: string, device: FlutterDevice) => Promise<{ url: string; keyId: string; publicKey: string; namespace: string; debugHttpHost?: string } | undefined>;
  /** The SDK root is fixed to this checkout by default and is not request-controlled. */
  sdkRoot?: string;
  /** These executable overrides are server configuration, not request parameters. */
  flutterCommand?: string;
  bunCommand?: string;
  /** Test and embedding seam. Production uses Bun.spawn. */
  spawn?: SpawnProcess;
  now?: () => Date;
  idFactory?: () => string;
  maxLogLines?: number;
  maxLogLineBytes?: number;
  listTimeoutMs?: number;
  buildTimeoutMs?: number;
  runTimeoutMs?: number;
  maxConcurrentDeployments?: number;
  /** Number of completed snapshots retained for log/status polling. */
  maxRetainedDeployments?: number;
  /** A bounded cwd for `flutter devices`; it is not a project path. */
  commandDirectory?: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
};

type ActiveProcess = {
  process: ProcessLike;
  phase: DeploymentPhase;
};

type DeploymentJob = {
  id: string;
  request: DeploymentRequest;
  plan: DeploymentPlan;
  state: DeploymentState;
  phase: DeploymentPhase;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  cancelRequested: boolean;
  logs: DeploymentLog[];
  nextSequence: number;
  process?: ActiveProcess;
  task?: Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, fallback: string, max = 400): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.slice(0, max);
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function normalizeProjectId(projectId: string): string {
  if (typeof projectId !== "string" || !projectIdPattern.test(projectId)) {
    throw new DeviceManagerError("invalid_project_id", "projectId must match [a-z][a-z0-9-]{0,47}");
  }
  return projectId;
}

function normalizeDeviceId(deviceId: string): string {
  if (typeof deviceId !== "string" || !deviceIdPattern.test(deviceId) || deviceId.startsWith("--")) {
    throw new DeviceManagerError("invalid_device_id", "deviceId contains unsupported characters");
  }
  return deviceId;
}

function validateCommandOverride(value: string | undefined, defaultValue: string, label: string): string {
  const command = value ?? defaultValue;
  if (!command || command.includes("\0") || command.includes("\n") || command.includes("\r")) {
    throw new DeviceManagerError("invalid_command", `${label} is not a valid executable`, 500);
  }
  const name = basename(command).toLowerCase();
  if (label === "flutter" && !["flutter", "flutter.bat"].includes(name)) {
    throw new DeviceManagerError("invalid_command", "flutter executable must be named flutter", 500);
  }
  if (label === "bun" && !["bun", "bun.exe"].includes(name)) {
    throw new DeviceManagerError("invalid_command", "bun executable must be named bun", 500);
  }
  return command;
}

function safePath(value: string, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value)) {
    throw new DeviceManagerError("invalid_command", `${label} must be an absolute path`, 500);
  }
  return resolve(value);
}

function trustedDirectory(value: string | undefined, label: string, code: "invalid_project_root" | "invalid_flutter_root"): string {
  if (!value) {
    throw new DeviceManagerError(
      code === "invalid_flutter_root" ? "flutter_binding_missing" : code,
      code === "invalid_flutter_root" ? "project has no trusted Flutter consumer binding" : `${label} is not configured`,
      code === "invalid_flutter_root" ? 422 : 400,
    );
  }
  const path = safePath(value, label);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw new DeviceManagerError(code, `${label} does not exist: ${path}`, 400, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new DeviceManagerError(code, `${label} must be a real directory: ${path}`);
  }
  try {
    return realpathSync(path);
  } catch (error) {
    throw new DeviceManagerError(code, `${label} cannot be resolved: ${path}`, 400, error);
  }
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    throw new DeviceManagerError("consumer_contract_mismatch", `invalid JSON in ${path}`, 400, error);
  }
}

function platformFromDevice(raw: FlutterMachineDevice, targetPlatform: string, sdk: string, name: string): FlutterPlatform {
  const text = `${targetPlatform} ${sdk} ${name}`.toLowerCase();
  if (text.includes("android")) return "android";
  if (text.includes("ios") || text.includes("iphone") || text.includes("ipad") || text.includes("darwin")) {
    if (text.includes("macos") || text.includes("mac os")) return "macos";
    // Flutter reports Apple mobile simulators as darwin-arm64 on current SDKs;
    // deviceClass/sdk/name below keeps macOS separate.
    const category = String(raw.deviceClass ?? raw.category ?? "").toLowerCase();
    if (category.includes("desktop") && !text.includes("iphone") && !text.includes("ipad")) return "macos";
    return "ios";
  }
  if (text.includes("linux")) return "linux";
  if (text.includes("windows")) return "windows";
  if (text.includes("chrome") || text.includes("web")) return "web";
  return "unknown";
}

function classifyDevice(raw: FlutterMachineDevice): FlutterDevice {
  const id = boundedString(raw.id ?? raw.deviceId, "");
  if (!deviceIdPattern.test(id)) throw new DeviceManagerError("device_discovery_failed", "Flutter returned a device without a safe id", 502);
  const name = boundedString(raw.name, id, 240);
  const targetPlatform = boundedString(raw.targetPlatform, "", 120);
  const sdk = boundedString(raw.sdk, "", 160);
  const version = boundedString(raw.version, "", 160);
  const category = boundedString(raw.deviceClass ?? raw.category, "", 80);
  const platform = platformFromDevice(raw, targetPlatform, sdk, name);
  const emulator = raw.emulator === true || /^emulator[-_]/i.test(id) || /simulator|emulator/i.test(`${name} ${targetPlatform}`);
  const mobileName = /iphone|ipad|ipod/i.test(name) || /ios|darwin/i.test(`${sdk} ${targetPlatform}`);
  let kind: FlutterDeviceKind = "other";
  if (platform === "android") kind = emulator ? "android-emulator" : "android-device";
  else if (platform === "ios" && mobileName) kind = emulator ? "ios-simulator" : "ios-device";
  // Flutter can enumerate web/desktop targets even though this Pocket host
  // only owns the native Flutter runtime. Keep those entries visible for an
  // honest device list, but never let the deployment path treat Chrome or an
  // unknown target as a supported Pocket host.
  const platformSupported = platform !== "web" && platform !== "unknown";
  const supported = platformSupported && (raw.isSupported === undefined ? true : raw.isSupported === true);
  const available = raw.available === undefined ? true : raw.available === true;
  return {
    id,
    name,
    platform,
    kind,
    available,
    supported,
    emulator,
    ...(targetPlatform ? { targetPlatform } : {}),
    ...(sdk ? { sdk } : {}),
    ...(version ? { version } : {}),
    ...(category ? { category } : {}),
    raw,
  };
}

/** Parse Flutter's `devices --machine` JSON without accepting arbitrary commands. */
export function parseFlutterDevices(output: string): FlutterDevice[] {
  if (typeof output !== "string" || output.length > maxCommandOutputBytes) {
    throw new DeviceManagerError("device_discovery_failed", "Flutter device output is too large", 502);
  }
  const trimmed = output.trim();
  if (!trimmed) throw new DeviceManagerError("device_discovery_failed", "Flutter returned no device data", 502);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // A Flutter wrapper can print one informational line before machine JSON.
    // Recover only a complete JSON array; never treat arbitrary text as an
    // empty device list.
    const begin = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (begin < 0 || end <= begin) throw new DeviceManagerError("device_discovery_failed", `cannot parse flutter devices --machine output: ${trimmed.slice(0, 240)}`, 502);
    try {
      value = JSON.parse(trimmed.slice(begin, end + 1));
    } catch (error) {
      throw new DeviceManagerError("device_discovery_failed", "invalid Flutter machine device JSON", 502, error);
    }
  }
  if (!Array.isArray(value)) throw new DeviceManagerError("device_discovery_failed", "Flutter machine device output must be an array", 502);
  const devices: FlutterDevice[] = [];
  for (const item of value) {
    if (!isRecord(item)) throw new DeviceManagerError("device_discovery_failed", "Flutter returned a malformed device entry", 502);
    devices.push(classifyDevice(item));
  }
  return devices;
}

function normalizeTarget(target: DeploymentTarget | undefined): FlutterDeviceKind | FlutterPlatform | undefined {
  if (!target) return undefined;
  if (target === "ios-sim") return "ios-simulator";
  if (target === "android") return "android";
  if (target === "real-device") return undefined;
  return target;
}

function targetMatches(device: FlutterDevice, target: DeploymentTarget | undefined): boolean {
  if (!target) return true;
  if (target === "real-device") return device.kind === "ios-device" || device.kind === "android-device";
  const normalized = normalizeTarget(target);
  if (normalized === undefined) return true;
  return normalized === "android" ? device.platform === "android" : device.kind === normalized;
}

function flutterRunCommand(flutterCommand: string, deviceId: string, mode: FlutterRunMode): string[] {
  const modeArgs = mode === "debug" ? [] : [
    `--${mode}`,
  ];
  return [flutterCommand, "run", "--machine", ...modeArgs, "-d", deviceId, "--no-pub"];
}

function parseMachineEvent(line: string): { event?: string; params?: Record<string, unknown> } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    const eventValue = Array.isArray(value)
      ? value.find((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.event === "string")
      : value;
    if (!isRecord(eventValue)) return undefined;
    return {
      ...(typeof eventValue.event === "string" ? { event: eventValue.event } : {}),
      ...(isRecord(eventValue.params) ? { params: eventValue.params } : {}),
    };
  } catch {
    return undefined;
  }
}

async function* streamChunks(stream: unknown): AsyncGenerator<string> {
  if (!stream) return;
  if (typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream as AsyncIterable<unknown>) {
      if (typeof chunk === "string") yield chunk;
      else if (chunk instanceof Uint8Array) yield new TextDecoder().decode(chunk);
      else if (chunk instanceof ArrayBuffer) yield new TextDecoder().decode(new Uint8Array(chunk));
      else yield String(chunk);
    }
    return;
  }
  const candidate = stream as { getReader?: () => { read: () => Promise<{ done: boolean; value?: unknown }>; releaseLock?: () => void } };
  if (typeof candidate.getReader !== "function") return;
  const reader = candidate.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (typeof value === "string") yield value;
      else if (value instanceof Uint8Array) yield new TextDecoder().decode(value);
      else if (value instanceof ArrayBuffer) yield new TextDecoder().decode(new Uint8Array(value));
      else if (value !== undefined) yield String(value);
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function consumeLines(
  stream: unknown,
  maxLineBytes: number,
  onLine: (line: string) => void,
  collect?: { text: string; bytes: number },
): Promise<void> {
  let buffer = "";
  for await (const chunk of streamChunks(stream)) {
    if (collect && collect.bytes < maxCommandOutputBytes) {
      const remaining = maxCommandOutputBytes - collect.bytes;
      const addition = chunk.slice(0, remaining);
      collect.text += addition;
      collect.bytes += Buffer.byteLength(addition);
    }
    buffer += chunk;
    // Keep a bounded partial line as well as bounded complete lines. A tool
    // that writes a huge binary blob must not grow the editor process heap.
    if (Buffer.byteLength(buffer) > maxLineBytes * 2) {
      const prefix = buffer.slice(0, maxLineBytes);
      onLine(`${prefix}…`);
      buffer = buffer.slice(maxLineBytes);
    }
    let newline = buffer.search(/\r?\n/);
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      const match = buffer.slice(newline).match(/^\r?\n/);
      const separatorLength = match?.[0].length ?? 1;
      onLine(line.slice(0, maxLineBytes) + (line.length > maxLineBytes ? "…" : ""));
      buffer = buffer.slice(newline + separatorLength);
      newline = buffer.search(/\r?\n/);
    }
  }
  if (buffer) onLine(buffer.slice(0, maxLineBytes) + (buffer.length > maxLineBytes ? "…" : ""));
}

function defaultSpawn(command: readonly string[], options: SpawnOptions): ProcessLike {
  return Bun.spawn(command, options) as unknown as ProcessLike;
}

function commandFailure(command: readonly string[], result: CommandResult, timeoutCode: DeviceManagerErrorCode = "deployment_failed"): DeviceManagerError | undefined {
  if (result.timedOut) return new DeviceManagerError("deployment_timeout", `${command[0]} timed out`, 504);
  if (result.exitCode !== 0) return new DeviceManagerError(timeoutCode, `${command[0]} exited with status ${result.exitCode}`, 502);
  return undefined;
}

function killProcess(process: ProcessLike, signal: string): void {
  try {
    process.kill(signal);
  } catch {
    // The child may have exited between the status check and cancellation.
  }
}

function assertArtifactDirectory(assetRoot: string, label: string): void {
  for (const name of requiredAssetFiles) {
    const path = join(assetRoot, name);
    if (!existsSync(path)) throw new DeviceManagerError("asset_missing", `${label} is missing ${name}`, 422);
    let info: ReturnType<typeof statSync>;
    try { info = statSync(path); } catch (error) { throw new DeviceManagerError("asset_missing", `${label} cannot read ${name}`, 422, error); }
    if (!info.isFile() || info.size <= 0) throw new DeviceManagerError("invalid_artifact", `${label}/${name} must be a non-empty file`, 422);
  }
  let bytecode: Buffer;
  try { bytecode = readFileSync(join(assetRoot, "app.qjbc")); } catch (error) { throw new DeviceManagerError("invalid_artifact", `${label}/app.qjbc cannot be read`, 422, error); }
  if (bytecode.byteLength < 4 || bytecode.subarray(0, 4).toString("ascii") !== "PJBC") {
    throw new DeviceManagerError("invalid_artifact", `${label}/app.qjbc is not a PocketJS bytecode envelope`, 422);
  }
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(assetRoot, "app.bytecode.json"), "utf8"));
    if (!isRecord(parsed)) throw new Error("metadata is not an object");
    metadata = parsed;
  } catch (error) {
    throw new DeviceManagerError("invalid_artifact", `${label}/app.bytecode.json is invalid`, 422, error);
  }
  if (metadata.entryFormat !== "quickjs-bytecode" || metadata.bytecodeBytes !== bytecode.byteLength) {
    throw new DeviceManagerError("invalid_artifact", `${label} metadata does not describe the QJBC bytes`, 422);
  }
  const pak = readFileSync(join(assetRoot, "app.pak"));
  if (pak.byteLength < 4 || pak.subarray(0, 4).toString("ascii") !== "DCPK") {
    throw new DeviceManagerError("invalid_artifact", `${label}/app.pak is not a PocketJS PAK`, 422);
  }
}

function ensurePubspecAssets(flutterRoot: string, assetRoot: string, childApps: boolean): void {
  const pubspecPath = join(flutterRoot, "pubspec.yaml");
  if (!existsSync(pubspecPath)) throw new DeviceManagerError("consumer_contract_mismatch", `Flutter consumer has no pubspec.yaml: ${flutterRoot}`, 422);
  const pubspec = readFileSync(pubspecPath, "utf8");
  const required = requiredAssetFiles.map((name) => `assets/${name}`);
  if (childApps && existsSync(join(assetRoot, "apps"))) {
    for (const child of requireDirectoryNames(join(assetRoot, "apps"))) required.push(`assets/apps/${child}/`);
  }
  const missing = required.filter((asset) => !pubspec.includes(asset));
  if (missing.length) throw new DeviceManagerError("consumer_contract_mismatch", `Flutter pubspec does not declare generated assets: ${missing.join(", ")}`, 422);
}

function requireDirectoryNames(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry: { isDirectory: () => boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => entry.name)
      .filter((name: string) => /^[A-Za-z0-9._-]{1,64}$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

export class EditorDeviceManager {
  private readonly projectDirectory: DeviceManagerOptions["projectDirectory"];
  private readonly flutterDirectory: DeviceManagerOptions["flutterDirectory"];
  private readonly updateConfig: DeviceManagerOptions["updateConfig"];
  private readonly sdkDirectory: string;
  private readonly flutterCommand: string;
  private readonly bunCommand: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maxLogLines: number;
  private readonly maxLogLineBytes: number;
  private readonly listTimeoutMs: number;
  private readonly buildTimeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly maxConcurrentDeployments: number;
  private readonly maxRetainedDeployments: number;
  private readonly commandDirectory: string;
  private readonly jobs = new Map<string, DeploymentJob>();
  private readonly pendingProjects = new Set<string>();
  private readonly ownedProcesses = new Set<ProcessLike>();
  private pendingStarts = 0;
  private disposed = false;

  constructor(options: DeviceManagerOptions) {
    this.projectDirectory = options.projectDirectory;
    this.flutterDirectory = options.flutterDirectory;
    this.updateConfig = options.updateConfig;
    this.sdkDirectory = safePath(options.sdkRoot ?? sdkRoot, "sdkRoot");
    this.flutterCommand = validateCommandOverride(options.flutterCommand ?? process.env.FLUTTER_BIN, "flutter", "flutter");
    this.bunCommand = validateCommandOverride(options.bunCommand, "bun", "bun");
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.maxLogLines = assertPositiveInteger(options.maxLogLines ?? defaultLogLines, "maxLogLines");
    this.maxLogLineBytes = assertPositiveInteger(options.maxLogLineBytes ?? defaultLogLineBytes, "maxLogLineBytes");
    this.listTimeoutMs = assertPositiveInteger(options.listTimeoutMs ?? defaultListTimeoutMs, "listTimeoutMs");
    this.buildTimeoutMs = assertPositiveInteger(options.buildTimeoutMs ?? defaultBuildTimeoutMs, "buildTimeoutMs");
    this.runTimeoutMs = assertPositiveInteger(options.runTimeoutMs ?? defaultRunTimeoutMs, "runTimeoutMs");
    this.maxConcurrentDeployments = assertPositiveInteger(options.maxConcurrentDeployments ?? defaultMaxConcurrentDeployments, "maxConcurrentDeployments");
    this.maxRetainedDeployments = assertPositiveInteger(options.maxRetainedDeployments ?? 20, "maxRetainedDeployments");
    this.commandDirectory = safePath(options.commandDirectory ?? process.cwd(), "commandDirectory");
  }

  /** Enumerate actual Flutter devices; no empty/mock fallback is provided. */
  async listDevices(): Promise<FlutterDevice[]> {
    this.assertLive();
    const result = await this.runCommand([this.flutterCommand, "devices", "--machine"], this.commandDirectory, this.listTimeoutMs);
    const failure = commandFailure([this.flutterCommand, "devices", "--machine"], result, "device_discovery_failed");
    if (failure) {
      if (result.exitCode === 127) throw new DeviceManagerError("flutter_unavailable", "flutter devices could not be started", 502);
      throw failure;
    }
    return parseFlutterDevices(result.stdout);
  }

  async planDeployment(request: DeploymentRequest): Promise<DeploymentPlan> {
    this.assertLive();
    const projectId = normalizeProjectId(request.projectId);
    const deviceId = normalizeDeviceId(request.deviceId);
    const mode = request.mode ?? "debug";
    if (mode !== "debug" && mode !== "profile" && mode !== "release") {
      throw new DeviceManagerError("consumer_contract_mismatch", `unsupported Flutter run mode: ${String(mode)}`);
    }
    const devices = await this.listDevices();
    const device = devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new DeviceManagerError("device_not_found", `Flutter device is not currently connected: ${deviceId}`, 404);
    if (!device.available || !device.supported) throw new DeviceManagerError("device_unavailable", `Flutter device is not available: ${device.name}`, 409);
    if (!targetMatches(device, request.target)) throw new DeviceManagerError("device_target_mismatch", `device ${device.name} is ${device.kind}, not ${String(request.target)}`, 400);
    return this.resolvePlan(projectId, device, mode);
  }

  /** Start a build + Flutter run asynchronously and return its deployment id immediately. */
  async startDeployment(request: DeploymentRequest): Promise<DeploymentSnapshot> {
    this.assertLive();
    const projectId = normalizeProjectId(request.projectId);
    const deviceId = normalizeDeviceId(request.deviceId);
    const duplicate = [...this.jobs.values()].find((job) =>
      job.request.projectId === projectId && this.isActive(job.state),
    );
    if (duplicate) throw new DeviceManagerError("deployment_busy", `project ${projectId} already has deployment ${duplicate.id}`, 409);
    if (this.pendingProjects.has(projectId)) throw new DeviceManagerError("deployment_busy", `project ${projectId} already has a deployment being planned`, 409);
    const activeCount = [...this.jobs.values()].filter((job) => this.isActive(job.state)).length;
    if (activeCount + this.pendingStarts >= this.maxConcurrentDeployments) throw new DeviceManagerError("deployment_limit", "deployment capacity is currently full", 409);
    // Device discovery is asynchronous. Reserve both the project and one
    // capacity slot before awaiting it, otherwise two simultaneous POSTs can
    // both pass the preflight check and start duplicate Flutter processes.
    this.pendingStarts += 1;
    this.pendingProjects.add(projectId);
    try {
      const plan = await this.planDeployment({ ...request, projectId, deviceId });
      this.assertLive();
      const activeAfterPlan = [...this.jobs.values()].find((job) =>
        job.request.projectId === projectId && this.isActive(job.state),
      );
      if (activeAfterPlan) throw new DeviceManagerError("deployment_busy", `project ${projectId} already has deployment ${activeAfterPlan.id}`, 409);
      const id = this.makeDeploymentId();
      const job: DeploymentJob = {
        id,
        request: { ...request, projectId, deviceId },
        plan,
        state: "queued",
        phase: "manager",
        cancelRequested: false,
        logs: [],
        nextSequence: 0,
      };
      this.jobs.set(id, job);
      job.task = this.runDeployment(job);
      return this.snapshot(job);
    } finally {
      this.pendingStarts -= 1;
      this.pendingProjects.delete(projectId);
    }
  }

  getStatus(deploymentId: string): DeploymentSnapshot {
    return this.snapshot(this.getJob(deploymentId));
  }

  getLogs(deploymentId: string, afterSequence = 0): DeploymentLogPage {
    const job = this.getJob(deploymentId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new DeviceManagerError("consumer_contract_mismatch", "afterSequence must be a non-negative integer");
    return {
      deploymentId: job.id,
      logs: job.logs.filter((entry) => entry.sequence > afterSequence).map((entry) => ({ ...entry })),
      nextSequence: job.nextSequence,
    };
  }

  /** True while this project owns a queued/build/run deployment. */
  isBusy(projectId: string): boolean {
    const normalized = normalizeProjectId(projectId);
    return this.pendingProjects.has(normalized) || [...this.jobs.values()].some((job) => job.request.projectId === normalized && this.isActive(job.state));
  }

  async cancel(deploymentId: string): Promise<DeploymentSnapshot> {
    const job = this.getJob(deploymentId);
    if (!this.isActive(job.state)) return this.snapshot(job);
    job.cancelRequested = true;
    job.state = "stopping";
    this.log(job, "system", "manager", "cancellation requested");
    if (job.process) {
      this.log(job, "system", "manager", `stopping owned ${job.process.phase} process`);
      const owned = job.process.process;
      killProcess(owned, "SIGINT");
      // Flutter normally forwards SIGINT to its tool child. If it does not,
      // escalate only against the exact ProcessLike object this manager
      // spawned; never search for or signal a user's unrelated service.
      void (async () => {
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
        if (job.process?.process !== owned) return;
        killProcess(owned, "SIGTERM");
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
        if (job.process?.process === owned) killProcess(owned, "SIGKILL");
      })();
    }
    return this.snapshot(job);
  }

  listDeployments(): DeploymentSnapshot[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = [...this.jobs.values()].filter((job) => this.isActive(job.state));
    for (const process of this.ownedProcesses) killProcess(process, "SIGINT");
    await Promise.all(active.map((job) => this.cancel(job.id).then(() => job.task).catch(() => undefined)));
    for (const process of this.ownedProcesses) killProcess(process, "SIGTERM");
  }

  private assertLive(): void {
    if (this.disposed) throw new DeviceManagerError("manager_disposed", "device manager has been disposed", 410);
  }

  private makeDeploymentId(): string {
    const suffix = String(this.idFactory()).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    const id = `deployment-${Date.now().toString(36)}-${suffix || randomUUID().replaceAll("-", "")}`;
    if (this.jobs.has(id)) return this.makeDeploymentId();
    return id;
  }

  private isActive(state: DeploymentState): boolean {
    return state === "queued" || state === "building" || state === "starting" || state === "running" || state === "stopping";
  }

  private getJob(deploymentId: string): DeploymentJob {
    if (typeof deploymentId !== "string" || !/^deployment-[A-Za-z0-9_-]{3,160}$/.test(deploymentId)) throw new DeviceManagerError("deployment_not_found", "deployment id is invalid", 404);
    const job = this.jobs.get(deploymentId);
    if (!job) throw new DeviceManagerError("deployment_not_found", `deployment not found: ${deploymentId}`, 404);
    return job;
  }

  private snapshot(job: DeploymentJob): DeploymentSnapshot {
    return {
      id: job.id,
      projectId: job.request.projectId,
      device: { ...job.plan.device, raw: { ...job.plan.device.raw } },
      state: job.state,
      phase: job.phase,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      ...(job.error ? { error: job.error } : {}),
      cancelRequested: job.cancelRequested,
      plan: {
        ...job.plan,
        device: { ...job.plan.device, raw: { ...job.plan.device.raw } },
        build: { ...job.plan.build, command: [...job.plan.build.command] },
        run: { ...job.plan.run, command: [...job.plan.run.command] },
      },
      logs: job.logs.map((entry) => ({ ...entry })),
    };
  }

  private log(job: DeploymentJob, stream: DeploymentLogStream, phase: DeploymentPhase, line: string): void {
    const text = String(line).slice(0, this.maxLogLineBytes);
    job.logs.push({ sequence: job.nextSequence++, timestamp: this.now().toISOString(), phase, stream, line: text });
    if (job.logs.length > this.maxLogLines) job.logs.splice(0, job.logs.length - this.maxLogLines);
  }

  private async resolvePlan(projectId: string, device: FlutterDevice, mode: FlutterRunMode): Promise<DeploymentPlan> {
    const projectRoot = trustedDirectory(await this.projectDirectory(projectId), "JS project root", "invalid_project_root");
    const flutterRootValue = await this.flutterDirectory(projectId);
    const flutterRoot = trustedDirectory(flutterRootValue, "Flutter consumer root", "invalid_flutter_root");
    if (!existsSync(join(projectRoot, "package.json"))) throw new DeviceManagerError("consumer_contract_mismatch", `JS project has no package.json: ${projectRoot}`, 422);
    if (!existsSync(join(projectRoot, "manifest.json")) || !existsSync(join(projectRoot, "pocket.json"))) {
      throw new DeviceManagerError("consumer_contract_mismatch", "JS project must contain manifest.json and pocket.json", 422);
    }
    if (!existsSync(join(flutterRoot, "pubspec.yaml"))) throw new DeviceManagerError("consumer_contract_mismatch", `Flutter consumer has no pubspec.yaml: ${flutterRoot}`, 422);
    if (device.platform === "web" || device.platform === "unknown") {
      throw new DeviceManagerError("device_unavailable", `Pocket Flutter host does not support ${device.name} (${device.platform})`, 409);
    }
    if (device.platform === "macos" || device.platform === "linux" || device.platform === "windows") {
      const platformDirectory = join(flutterRoot, device.platform);
      let platformInfo: ReturnType<typeof lstatSync> | undefined;
      try { platformInfo = lstatSync(platformDirectory); } catch { platformInfo = undefined; }
      if (!platformInfo || platformInfo.isSymbolicLink() || !platformInfo.isDirectory()) {
        throw new DeviceManagerError("consumer_contract_mismatch", `Flutter consumer has no ${device.platform} platform folder`, 422);
      }
    }
    const packageJson = readJsonObject(join(projectRoot, "package.json")) ?? {};
    const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
    const buildSystem = scripts["build:system"];
    const assetRoot = resolve(flutterRoot, "assets");
    let build: DeploymentBuildPlan;
    if (buildSystem !== undefined) {
      if (buildSystem !== expectedBuildSystemScript) {
        throw new DeviceManagerError("consumer_contract_mismatch", "build:system is not the pinned PocketJS consumer pipeline", 422);
      }
      // The checked-in Showcase contract is demo/js -> demo. Running its
      // package script keeps mini-app outputs and the root guest in lockstep.
      if (resolve(dirname(projectRoot)) !== resolve(flutterRoot)) {
        throw new DeviceManagerError("consumer_contract_mismatch", "consumer JS root must be a direct child of its Flutter root for build:system", 422);
      }
      build = {
        command: [this.bunCommand, "run", "build:system"],
        cwd: projectRoot,
        strategy: "consumer-build-system",
        assetRoot,
        childApps: true,
      };
    } else {
      build = {
        command: [
          this.bunCommand,
          join(this.sdkDirectory, "scripts/build_guest.ts"),
          `--project-root=${projectRoot}`,
          `--copy-assets-to=${assetRoot}`,
          `--keep-source=${join(projectRoot, ".pocket-build/app.js")}`,
        ],
        cwd: projectRoot,
        strategy: "build-guest",
        assetRoot,
        childApps: false,
      };
    }
    const runCommand = flutterRunCommand(this.flutterCommand, device.id, mode);
    const updates = await this.updateConfig?.(projectId, device);
    if (updates) {
      const url = new URL(updates.url);
      if (!['http:', 'https:'].includes(url.protocol) || !updates.keyId || !updates.publicKey || !/^[A-Za-z0-9_-]+$/.test(updates.namespace)) {
        throw new DeviceManagerError("consumer_contract_mismatch", "Editor update trust configuration is invalid", 422);
      }
      if (updates.debugHttpHost !== undefined && updates.debugHttpHost !== url.hostname) {
        throw new DeviceManagerError("consumer_contract_mismatch", "Editor debug HTTP host must match its update URL", 422);
      }
      for (const [name, value] of Object.entries({ ...(updates.debugHttpHost ? { POCKET_UPDATE_DEBUG_HTTP_HOST: updates.debugHttpHost } : {}), POCKET_UPDATE_URL: updates.url, POCKET_UPDATE_KEY_ID: updates.keyId, POCKET_UPDATE_PUBLIC_KEY: updates.publicKey, POCKET_STORE_NAMESPACE: updates.namespace })) {
        runCommand.push(`--dart-define=${name}=${value}`);
      }
    }
    return {
      projectId,
      device,
      projectRoot,
      flutterRoot,
      build,
      run: {
        command: runCommand,
        cwd: flutterRoot,
        mode,
      },
    };
  }

  private async runCommand(command: readonly string[], cwd: string, timeoutMs: number, onLine?: (line: string, stream: DeploymentLogStream) => void, job?: DeploymentJob): Promise<CommandResult> {
    let child: ProcessLike;
    try {
      child = this.spawnProcess(command, { cwd, stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      const code = command[0] === this.flutterCommand ? "flutter_unavailable" : "deployment_failed";
      throw new DeviceManagerError(code, `cannot start ${command[0]}`, 502, error);
    }
    if (job) job.process = { process: child, phase: job.phase };
    this.ownedProcesses.add(child);
    const stdout: { text: string; bytes: number } = { text: "", bytes: 0 };
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<void>((resolveTimer) => {
      timeout = setTimeout(() => {
        timedOut = true;
        if (job) this.log(job, "system", job.phase, `${command[0]} exceeded ${timeoutMs}ms; terminating only the owned process`);
        killProcess(child, "SIGTERM");
        resolveTimer();
      }, timeoutMs);
    });
    const readStdout = consumeLines(child.stdout, this.maxLogLineBytes, (line) => onLine?.(line, "stdout"), stdout);
    const readStderr = consumeLines(child.stderr, this.maxLogLineBytes, (line) => onLine?.(line, "stderr"));
    const exited = Promise.resolve(child.exited);
    let exitCode = 1;
    try {
      const completed = await Promise.race([
        (async () => { exitCode = await exited; return "exited" as const; })(),
        timer.then(() => "timed-out" as const),
      ]);
      if (completed === "timed-out") {
        // Flutter/Bun normally exits after SIGTERM; wait for the owned child
        // briefly, then escalate only to that same ProcessLike instance.
        await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
        if (exitCode === 1) killProcess(child, "SIGKILL");
        exitCode = await Promise.race([exited, Promise.resolve(1)]);
      }
      await Promise.all([readStdout, readStderr]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.ownedProcesses.delete(child);
      if (job?.process?.process === child) delete job.process;
    }
    return { exitCode, stdout: stdout.text, timedOut };
  }

  private async runDeployment(job: DeploymentJob): Promise<void> {
    job.startedAt = this.now().toISOString();
    this.log(job, "system", "manager", `deployment ${job.id} queued for ${job.plan.device.name}`);
    try {
      if (job.cancelRequested) throw new DeviceManagerError("deployment_canceled", "deployment canceled before build", 409);
      job.state = "building";
      job.phase = "build";
      this.log(job, "system", "build", `$ ${job.plan.build.command.map((part) => JSON.stringify(part)).join(" ")}`);
      const built = await this.runCommand(job.plan.build.command, job.plan.build.cwd, this.buildTimeoutMs, (line, stream) => this.log(job, stream, "build", line), job);
      if (job.cancelRequested) throw new DeviceManagerError("deployment_canceled", "deployment canceled during build", 409);
      const buildFailure = commandFailure(job.plan.build.command, built);
      if (buildFailure) throw buildFailure;
      assertArtifactDirectory(job.plan.build.assetRoot, "consumer assets");
      if (job.plan.build.childApps) {
        const appsRoot = join(job.plan.build.assetRoot, "apps");
        const childApps = requireDirectoryNames(appsRoot);
        if (childApps.length === 0) throw new DeviceManagerError("asset_missing", "consumer build:system produced no sub-application assets", 422);
        for (const name of childApps) assertArtifactDirectory(join(appsRoot, name), `consumer assets/apps/${name}`);
      }
      ensurePubspecAssets(job.plan.flutterRoot, job.plan.build.assetRoot, job.plan.build.childApps);
      this.log(job, "system", "build", "verified real QJBC + PAK consumer assets");

      if (job.cancelRequested) throw new DeviceManagerError("deployment_canceled", "deployment canceled before Flutter run", 409);
      job.state = "starting";
      job.phase = "flutter";
      this.log(job, "system", "flutter", `$ ${job.plan.run.command.map((part) => JSON.stringify(part)).join(" ")}`);
      const runResult = await this.runCommand(job.plan.run.command, job.plan.run.cwd, this.runTimeoutMs, (line, stream) => {
        this.log(job, stream, "flutter", line);
        const event = parseMachineEvent(line);
        if (event?.event === "app.started" || event?.event === "app.debugPort") job.state = "running";
      }, job);
      job.exitCode = runResult.exitCode;
      if (job.cancelRequested) {
        job.state = "canceled";
        job.error = "deployment canceled";
      } else if (runResult.timedOut) {
        job.state = "failed";
        job.error = `Flutter run exceeded ${this.runTimeoutMs}ms`;
      } else if (runResult.exitCode !== 0) {
        job.state = "failed";
        job.error = `flutter run exited with status ${runResult.exitCode}`;
      } else {
        job.state = "succeeded";
      }
    } catch (error) {
      if (job.cancelRequested || (error instanceof DeviceManagerError && error.code === "deployment_canceled")) {
        job.state = "canceled";
        job.error = "deployment canceled";
      } else {
        job.state = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
      this.log(job, "system", job.phase, `ERROR: ${job.error}`);
    } finally {
      if (job.process) {
        killProcess(job.process.process, "SIGTERM");
        delete job.process;
      }
      job.finishedAt = this.now().toISOString();
      if (job.state === "stopping") job.state = job.cancelRequested ? "canceled" : "failed";
      this.evictCompleted();
    }
  }

  private evictCompleted(): void {
    if (this.jobs.size <= this.maxRetainedDeployments) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxRetainedDeployments) break;
      if (!this.isActive(job.state)) this.jobs.delete(id);
    }
  }
}

export function createEditorDeviceManager(options: DeviceManagerOptions): EditorDeviceManager {
  return new EditorDeviceManager(options);
}
