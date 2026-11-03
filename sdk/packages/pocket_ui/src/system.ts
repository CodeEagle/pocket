import type { HostBridge, JsonObject, JsonValue } from "./host.ts";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_PENDING_CALLS = 32;
const MAX_MAILBOX_MESSAGES = 32;
const MAX_COMPLETED_REQUESTS = 256;
const SYSTEM_UI_INSTANCE_ID = "system-ui";

export interface PocketSystemCatalogEntry {
  package: string;
  manifest: string;
  required: boolean;
  presentation?: JsonObject;
}

/** The upstream pocket.system.json v1 shape consumed by the host. */
export interface PocketSystemV1 {
  pocketSystem: 1;
  id: string;
  name?: string;
  title?: string;
  version?: string;
  roles: {
    systemUI: string;
  };
  applications: {
    installPolicy?: {
      model: string;
      mutable?: boolean;
    };
    backgroundExecution?: "suspend" | "continue";
    catalog: readonly PocketSystemCatalogEntry[];
  };
  installation: {
    installedPackages: readonly string[];
  };
}

export interface PocketAppPolicy {
  allowedOpenApps: readonly string[];
  messageTargets: readonly string[];
  sharedNamespaces: readonly string[];
}

export type PocketSystemPolicies = Readonly<Record<string, PocketAppPolicy>>;

export interface InstallPocketSystemOptions {
  bridge: HostBridge;
  policies?: PocketSystemPolicies;
  /** Resident app slots, including the non-evictable System UI. */
  maxResidentApps?: number;
}

export type PocketSystemRuntimeState =
  | "foreground"
  | "frozen"
  | "prewarmed"
  | "suspended"
  | "closing"
  | "failed";

export interface PocketSystemRuntimeSnapshot {
  appId: string;
  instanceId: string;
  state: PocketSystemRuntimeState;
  prewarmed: boolean;
  lastUsed: number;
  generation: string | number | null;
  pendingLifecycleEvents: number;
}

export interface PocketSystemStackSnapshot {
  appId: string;
  instanceId: string;
  requestId: string | null;
  callerAppId: string | null;
}

export interface PocketSystemPendingCallSnapshot {
  requestId: string;
  callerAppId: string;
  targetAppId: string;
  callerInstanceId: string;
  resumeAppId: string;
  resumeInstanceId: string;
  targetInstanceId: string;
  completionPending: boolean;
}

/** One active app binding for an official framework CompositorSurface node. */
export interface PocketSystemSurfaceBinding {
  appId: string;
  instanceId: string;
  /** Stable handle supplied by the trusted compositor registry in `ui`. */
  surfaceHandle: number;
  focused: boolean;
}

type SystemGlobal = typeof globalThis & {
  ui?: { __surfaces?: Record<string, unknown> };
};

export interface PocketSystemSnapshot {
  disposed: boolean;
  systemUI: string;
  foregroundAppId: string | null;
  foregroundInstanceId: string | null;
  maxResidentApps: number;
  residentCount: number;
  backgroundExecution: "suspend";
  catalog: readonly {
    appId: string;
    manifest: string;
    required: boolean;
    installed: boolean;
    running: boolean;
    presentation?: JsonObject;
  }[];
  stack: readonly PocketSystemStackSnapshot[];
  residents: readonly PocketSystemRuntimeSnapshot[];
  lru: readonly string[];
  pendingCalls: readonly PocketSystemPendingCallSnapshot[];
  mailboxLimit: number;
  queuedMessages: number;
}

export interface PocketSystemKernel {
  readonly ready: Promise<void>;
  snapshot(): PocketSystemSnapshot;
  /** Current visible child bindings; geometry and z-order stay in SystemUI's
   *  ordinary PocketJS layout tree. */
  surfaceBindings(): readonly PocketSystemSurfaceBinding[];
  /** Subscribe to JS policy changes without a frame callback or polling loop. */
  subscribe(listener: () => void): () => void;
  /** Present already resident children as compositor surfaces. The requested
   *  order only controls scheduling; actual DrawOps order is owned by the
   *  SystemUI layout tree. A multi-app presentation names its focused app. */
  presentSurfaces(appIds: readonly string[], focusedAppId?: string): Promise<void>;
  dispose(): void;
}

interface CatalogRecord extends PocketSystemCatalogEntry {
  installed: boolean;
}

interface RuntimeRecord {
  appId: string;
  instanceId: string;
  prewarmed: boolean;
  closing: boolean;
  awaitingResponse: boolean;
  failed: boolean;
  lastUsed: number;
  generation: string | number | null;
  lifecycleQueue: JsonObject[];
}

interface StackFrame {
  appId: string;
  instanceId: string;
  requestId: string | null;
}

type LifecycleState =
  | "onInit"
  | "onLoad"
  | "onWillAppear"
  | "onDidAppear"
  | "onWillDisappear"
  | "frozenInStack"
  | "onResume"
  | "onUnload";

interface PendingCall {
  requestId: string;
  callerAppId: string;
  targetAppId: string;
  callerInstanceId: string;
  callerGeneration: string | number | null;
  resumeAppId: string;
  resumeInstanceId: string;
  targetInstanceId: string;
  arguments: JsonValue;
  completion: AppResultMessage | null;
  launchPending: boolean;
}

interface AppResultMessage {
  cancelled: boolean;
  value: JsonValue;
  reason?: string;
}

interface PocketAppMessage {
  id: string;
  sourceAppId: string;
  targetAppId: string;
  topic: string;
  data: JsonValue;
}

interface SystemRequest {
  requestId: string;
  sourceAppId: string;
  sourceInstanceId: string;
  sourceGeneration: string | number;
  capability: string;
  params: JsonObject;
}

interface StoredResponse {
  ok: boolean;
  value?: JsonValue;
  error?: { code: string; message: string };
  /** Internal cleanup that must wait until the source RPC is acknowledged. */
  cleanupInstanceIds?: string[];
}

interface DispatchOutcome {
  value: JsonValue;
  cleanupInstanceIds?: string[];
}

class PocketSystemError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PocketSystemError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function generationKey(value: string | number): string {
  return typeof value + ":" + String(value);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function jsonSnapshot(value: unknown, field: string): JsonValue {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value === undefined ? null : value);
  } catch {
    throw new PocketSystemError("invalid_json", field + " must be JSON-safe");
  }
  if (encoded === undefined) {
    throw new PocketSystemError("invalid_json", field + " must be JSON-safe");
  }
  if (utf8ByteLength(encoded) > MAX_JSON_BYTES) {
    throw new PocketSystemError("payload_too_large", field + " exceeds 64 KiB");
  }
  try {
    return JSON.parse(encoded) as JsonValue;
  } catch {
    throw new PocketSystemError("invalid_json", field + " must be JSON-safe");
  }
}

function objectSnapshot(value: unknown, field: string): JsonObject {
  const result = jsonSnapshot(value, field);
  if (!isRecord(result)) {
    throw new PocketSystemError("invalid_params", field + " must be an object");
  }
  return result as JsonObject;
}

function parseManifest(input: PocketSystemV1): {
  systemId: string;
  systemUI: string;
  catalog: Map<string, CatalogRecord>;
} {
  const manifest = objectSnapshot(input, "manifest") as Record<string, unknown>;
  if (manifest.pocketSystem !== 1) {
    throw new PocketSystemError("invalid_system_manifest", "pocketSystem must be 1");
  }
  if (!nonEmptyString(manifest.id)) {
    throw new PocketSystemError("invalid_system_manifest", "id must be a non-empty string");
  }
  const roles = isRecord(manifest.roles) ? manifest.roles : undefined;
  const systemUI = roles?.systemUI;
  if (!nonEmptyString(systemUI)) {
    throw new PocketSystemError("invalid_system_manifest", "roles.systemUI must name a package");
  }
  const applications = isRecord(manifest.applications) ? manifest.applications : undefined;
  if (!applications || !Array.isArray(applications.catalog)) {
    throw new PocketSystemError("invalid_system_manifest", "applications.catalog must be an array");
  }
  const backgroundExecution = applications.backgroundExecution ?? "suspend";
  if (backgroundExecution !== "suspend") {
    if (backgroundExecution === "continue") {
      throw new PocketSystemError(
        "unsupported_background_execution",
        "backgroundExecution=continue requires a host that can continue hidden guest ticks",
      );
    }
    throw new PocketSystemError("invalid_system_manifest", "backgroundExecution must be suspend");
  }
  const installation = isRecord(manifest.installation) ? manifest.installation : undefined;
  if (!installation || !Array.isArray(installation.installedPackages)) {
    throw new PocketSystemError("invalid_system_manifest", "installation.installedPackages must be an array");
  }

  const catalog = new Map<string, CatalogRecord>();
  for (const value of applications.catalog) {
    if (!isRecord(value) || !nonEmptyString(value.package) || !nonEmptyString(value.manifest)) {
      throw new PocketSystemError("invalid_system_manifest", "every catalog entry needs package and manifest");
    }
    if (typeof value.required !== "boolean") {
      throw new PocketSystemError("invalid_system_manifest", "every catalog entry needs a required boolean");
    }
    const appId = value.package;
    if (catalog.has(appId)) {
      throw new PocketSystemError("duplicate_catalog_package", "catalog package is duplicated: " + appId);
    }
    catalog.set(appId, {
      package: appId,
      manifest: value.manifest,
      required: value.required,
      installed: false,
      ...(isRecord(value.presentation)
        ? { presentation: jsonSnapshot(value.presentation, "catalog.presentation") as JsonObject }
        : {}),
    });
  }

  const installed = new Set<string>();
  for (const value of installation.installedPackages) {
    if (!nonEmptyString(value)) {
      throw new PocketSystemError("invalid_system_manifest", "installed package ids must be non-empty strings");
    }
    if (installed.has(value)) {
      throw new PocketSystemError("duplicate_installed_package", "installed package is duplicated: " + value);
    }
    if (!catalog.has(value)) {
      throw new PocketSystemError("unknown_installed_package", "installed package is absent from catalog: " + value);
    }
    installed.add(value);
  }
  for (const entry of catalog.values()) {
    entry.installed = installed.has(entry.package);
    if (entry.required && !entry.installed) {
      throw new PocketSystemError("required_package_missing", "required package is not installed: " + entry.package);
    }
  }
  const root = catalog.get(systemUI);
  if (!root || !root.required || !root.installed) {
    throw new PocketSystemError(
      "system_ui_not_installed",
      "roles.systemUI must identify a required installed catalog package",
    );
  }
  return {
    systemId: manifest.id,
    systemUI,
    catalog,
  };
}

function parsePolicies(
  input: PocketSystemPolicies | undefined,
  catalog: Map<string, CatalogRecord>,
): Map<string, PocketAppPolicy> {
  const policies = new Map<string, PocketAppPolicy>();
  if (input === undefined) return policies;
  if (!isRecord(input)) throw new PocketSystemError("invalid_policies", "policies must be an object keyed by app id");
  for (const [appId, raw] of Object.entries(input)) {
    if (!catalog.has(appId)) {
      throw new PocketSystemError("unknown_policy_app", "policy app is absent from catalog: " + appId);
    }
    if (!isRecord(raw)) throw new PocketSystemError("invalid_policy", "policy for " + appId + " must be an object");
    const parseNames = (key: string, namespace = false): string[] => {
      const value = raw[key];
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
        throw new PocketSystemError("invalid_policy", appId + "." + key + " must be a string array");
      }
      const result = [...new Set(value as string[])];
      if (result.length !== value.length) {
        throw new PocketSystemError("duplicate_policy_entry", appId + "." + key + " contains duplicates");
      }
      if (namespace) {
        for (const item of result) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item)) {
            throw new PocketSystemError("invalid_namespace", "invalid shared namespace: " + item);
          }
        }
      } else {
        for (const item of result) {
          if (!catalog.has(item)) {
            throw new PocketSystemError("unknown_policy_target", appId + "." + key + " names unknown app " + item);
          }
        }
      }
      return result;
    };
    policies.set(appId, Object.freeze({
      allowedOpenApps: Object.freeze(parseNames("allowedOpenApps")),
      messageTargets: Object.freeze(parseNames("messageTargets")),
      sharedNamespaces: Object.freeze(parseNames("sharedNamespaces", true)),
    }));
  }
  return policies;
}

function eventOf(line: string): { name: string; payload: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return undefined;
    const name = typeof value.name === "string"
      ? value.name
      : typeof value.method === "string" ? value.method : "";
    if (!name) return undefined;
    return { name, payload: value.payload ?? value.params };
  } catch {
    return undefined;
  }
}

function errorShape(error: unknown): { code: string; message: string } {
  if (error instanceof PocketSystemError) return { code: error.code, message: error.message };
  if (error && typeof error === "object") {
    const item = error as { code?: unknown; message?: unknown };
    return {
      code: typeof item.code === "string" ? item.code : "system_error",
      message: typeof item.message === "string" ? item.message : String(error),
    };
  }
  return { code: "system_error", message: String(error) };
}

class PocketSystemKernelImpl implements PocketSystemKernel {
  readonly ready: Promise<void>;
  private readonly bridge: HostBridge;
  private readonly systemId: string;
  private readonly systemUI: string;
  private readonly catalog: Map<string, CatalogRecord>;
  private readonly policies: Map<string, PocketAppPolicy>;
  private readonly maxResidentApps: number;
  private readonly records = new Map<string, RuntimeRecord>();
  private readonly instanceForApp = new Map<string, string>();
  private readonly stack: StackFrame[] = [];
  private presentedInstanceIds: string[] = [];
  private focusedInstanceId: string | null = null;
  private readonly presentationListeners = new Set<() => void>();
  private readonly calls = new Map<string, PendingCall>();
  private readonly mailbox: PocketAppMessage[] = [];
  private readonly completedRequests = new Map<string, StoredResponse>();
  private readonly target: typeof globalThis & { __pocketEvent?: (line: string) => void };
  private readonly previousEvent: ((line: string) => void) | undefined;
  private readonly receiveEvent: (line: string) => void;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private initialized = false;
  private lruSequence = 0;
  private nextCallId = 1;
  private nextMessageId = 1;

  constructor(
    manifest: PocketSystemV1,
    options: InstallPocketSystemOptions,
    parsed: ReturnType<typeof parseManifest>,
  ) {
    this.bridge = options.bridge;
    this.systemId = parsed.systemId;
    this.systemUI = parsed.systemUI;
    this.catalog = parsed.catalog;
    this.policies = parsePolicies(options.policies, this.catalog);
    this.maxResidentApps = options.maxResidentApps ?? 3;
    if (!Number.isInteger(this.maxResidentApps) || this.maxResidentApps < 1 || this.maxResidentApps > 256) {
      throw new PocketSystemError("invalid_resident_limit", "maxResidentApps must be an integer from 1 to 256");
    }
    if (!isRecord(manifest)) {
      throw new PocketSystemError("invalid_system_manifest", "manifest must be an object");
    }

    this.target = globalThis as typeof globalThis & { __pocketEvent?: (line: string) => void };
    this.previousEvent = this.target.__pocketEvent;
    this.receiveEvent = (line: string): void => {
      this.bridge.handle(line);
      const event = eventOf(line);
      if (event?.name === "system.request") {
        void this.enqueue(async () => {
          await this.handleSystemRequest(event.payload);
          await this.flushForegroundWork();
        });
      } else if (event?.name === "system.runtime.failed" || event?.name === "system.runtime.closed") {
        void this.enqueue(async () => {
          await this.handleRuntimeTermination(event.payload, event.name === "system.runtime.failed");
          await this.flushForegroundWork();
        });
      } else if (event?.name === "system.runtime.generation") {
        void this.enqueue(async () => {
          await this.handleGenerationChange(event.payload);
          await this.flushForegroundWork();
        });
      }
      try {
        this.previousEvent?.(line);
      } catch {
        // Keep the host event lane alive if an earlier subscriber fails.
      }
    };
    this.target.__pocketEvent = this.receiveEvent;
    this.ready = this.enqueue(() => this.initialize()).catch((error) => {
      this.dispose();
      throw error;
    });
  }

  snapshot(): PocketSystemSnapshot {
    const foreground = this.stack[this.stack.length - 1];
    const residentRows = [...this.records.values()]
      .sort((a, b) => a.lastUsed - b.lastUsed || a.instanceId.localeCompare(b.instanceId))
      .map((record) => Object.freeze({
        appId: record.appId,
        instanceId: record.instanceId,
        state: this.runtimeState(record),
        prewarmed: record.prewarmed,
        lastUsed: record.lastUsed,
        generation: record.generation,
        pendingLifecycleEvents: record.lifecycleQueue.length,
      }));
    const catalog = [...this.catalog.values()].map((entry) => Object.freeze({
      appId: entry.package,
      manifest: entry.manifest,
      required: entry.required,
      installed: entry.installed,
      running: this.instanceForApp.has(entry.package),
      ...(entry.presentation ? { presentation: jsonSnapshot(entry.presentation, "snapshot.presentation") as JsonObject } : {}),
    }));
    return Object.freeze({
      disposed: this.disposed,
      systemUI: this.systemUI,
      foregroundAppId: foreground?.appId ?? null,
      foregroundInstanceId: foreground?.instanceId ?? null,
      maxResidentApps: this.maxResidentApps,
      residentCount: this.records.size,
      backgroundExecution: "suspend",
      catalog: Object.freeze(catalog),
      stack: Object.freeze(this.stack.map((frame, index) => Object.freeze({
        appId: frame.appId,
        instanceId: frame.instanceId,
        requestId: frame.requestId,
        callerAppId: index > 0 ? this.stack[index - 1]!.appId : null,
      }))),
      residents: Object.freeze(residentRows),
      lru: Object.freeze([...this.records.values()]
        .sort((a, b) => a.lastUsed - b.lastUsed || a.instanceId.localeCompare(b.instanceId))
        .map((record) => record.appId)),
      pendingCalls: Object.freeze([...this.calls.values()].map((call) => Object.freeze({
        requestId: call.requestId,
        callerAppId: call.callerAppId,
        targetAppId: call.targetAppId,
        callerInstanceId: call.callerInstanceId,
        resumeAppId: call.resumeAppId,
        resumeInstanceId: call.resumeInstanceId,
        targetInstanceId: call.targetInstanceId,
        completionPending: call.completion !== null,
      }))),
      mailboxLimit: MAX_MAILBOX_MESSAGES,
      queuedMessages: this.mailbox.length,
    });
  }

  surfaceBindings(): readonly PocketSystemSurfaceBinding[] {
    const registry = this.readSurfaceRegistry();
    const focusedInstanceId = this.focusedInstanceId;
    return Object.freeze(this.presentedInstanceIds.flatMap((instanceId) => {
      if (instanceId === SYSTEM_UI_INSTANCE_ID) return [];
      const record = this.records.get(instanceId);
      if (!record || record.closing || record.failed) return [];
      const surfaceHandle = registry[record.appId];
      if (surfaceHandle === undefined) {
        throw new PocketSystemError(
          "compositor_surface_missing",
          "trusted compositor registry has no handle for " + record.appId,
        );
      }
      return [Object.freeze({
        appId: record.appId,
        instanceId: record.instanceId,
        surfaceHandle,
        focused: record.instanceId === focusedInstanceId,
      })];
    }));
  }

  subscribe(listener: () => void): () => void {
    this.assertActive();
    this.presentationListeners.add(listener);
    return () => this.presentationListeners.delete(listener);
  }

  presentSurfaces(appIds: readonly string[], focusedAppId?: string): Promise<void> {
    return this.enqueue(async () => {
      if (!Array.isArray(appIds)) {
        throw new PocketSystemError("invalid_surface_presentation", "surface app IDs must be an array");
      }
      const seen = new Set<string>();
      const instanceIds: string[] = [];
      for (const appId of appIds) {
        if (!nonEmptyString(appId) || appId === this.systemUI || seen.has(appId)) {
          throw new PocketSystemError(
            "invalid_surface_presentation",
            "surface app IDs must be unique installed child packages",
          );
        }
        const entry = this.catalog.get(appId);
        if (!entry?.installed) {
          throw new PocketSystemError("app_not_installed", "surface app is not installed: " + appId);
        }
        const instanceId = this.instanceForApp.get(appId);
        const record = instanceId ? this.records.get(instanceId) : undefined;
        if (!record || record.closing || record.failed) {
          throw new PocketSystemError("app_not_running", "surface app is not resident: " + appId);
        }
        this.requireSurfaceHandle(appId);
        seen.add(appId);
        instanceIds.push(record.instanceId);
      }
      let focusedInstanceId: string | null = null;
      if (appIds.length > 0) {
        const focus = focusedAppId ?? (appIds.length === 1 ? appIds[0] : undefined);
        if (!focus || !seen.has(focus)) {
          throw new PocketSystemError(
            "invalid_surface_focus",
            "a multi-app presentation must name one visible focused app",
          );
        }
        const focused = this.instanceForApp.get(focus);
        const foreground = this.foregroundFrame();
        if (!focused || focused !== foreground.instanceId) {
          throw new PocketSystemError(
            "surface_focus_mismatch",
            "the focused surface must match the current SystemUI foreground app",
          );
        }
        focusedInstanceId = focused;
      } else {
        if (focusedAppId !== undefined) {
          throw new PocketSystemError("invalid_surface_focus", "an empty surface set cannot have a focused app");
        }
        focusedInstanceId = this.foregroundFrame().instanceId;
      }
      this.applyPresentation(instanceIds, focusedInstanceId);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.target.__pocketEvent === this.receiveEvent) {
      this.target.__pocketEvent = this.previousEvent;
    }
    this.stack.length = 0;
    this.presentedInstanceIds = [];
    this.focusedInstanceId = null;
    this.presentationListeners.clear();
    this.records.clear();
    this.instanceForApp.clear();
    this.calls.clear();
    this.mailbox.length = 0;
    this.completedRequests.clear();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.disposed) return;
      await operation();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private assertActive(): void {
    if (this.disposed) throw new PocketSystemError("system_disposed", "Pocket System kernel is disposed");
  }

  private async hostRequest(capability: string, params: JsonObject): Promise<JsonValue> {
    this.assertActive();
    const result = await this.bridge.request<JsonValue>(capability, params);
    this.assertActive();
    return result;
  }

  private async hostObject(capability: string, params: JsonObject): Promise<JsonObject> {
    const result = await this.hostRequest(capability, params);
    if (!isRecord(result)) {
      throw new PocketSystemError("host_protocol_error", capability + " must return an object");
    }
    return result as JsonObject;
  }

  private async initialize(): Promise<void> {
    const grants = [...this.catalog.values()]
      .filter((entry) => entry.installed)
      .map((entry) => entry.package)
      .sort()
      .map((appId) => ({
        appId,
        sharedNamespaces: [...(this.policies.get(appId)?.sharedNamespaces ?? [])].sort(),
      }));
    const configured = await this.hostObject("system.runtime.configure", {
      systemUI: this.systemUI,
      grants,
    });
    if (configured.systemInstanceId !== SYSTEM_UI_INSTANCE_ID) {
      throw new PocketSystemError(
        "host_protocol_error",
        "system.runtime.configure must return systemInstanceId=system-ui",
      );
    }
    const root: RuntimeRecord = {
      appId: this.systemUI,
      instanceId: SYSTEM_UI_INSTANCE_ID,
      prewarmed: false,
      closing: false,
      awaitingResponse: false,
      failed: false,
      lastUsed: this.nextLru(),
      generation: this.readGeneration(configured.generation),
      lifecycleQueue: [],
    };
    this.records.set(root.instanceId, root);
    this.instanceForApp.set(root.appId, root.instanceId);
    this.stack.push({
      appId: root.appId,
      instanceId: root.instanceId,
      requestId: null,
    });
    await this.presentTop();
    this.initialized = true;
    await this.lifecycle(root, "onInit", { source: "system.install" });
    await this.lifecycle(root, "onLoad", { source: "system.install" });
    await this.lifecycle(root, "onWillAppear", { source: "system.install" });
    await this.lifecycle(root, "onDidAppear", { source: "system.install" });
    await this.flushLifecycle(root);
  }

  private nextLru(): number {
    this.lruSequence += 1;
    return this.lruSequence;
  }

  private runtimeState(record: RuntimeRecord): PocketSystemRuntimeState {
    if (record.failed) return "failed";
    if (record.closing) return "closing";
    if (record.instanceId === this.focusedInstanceId) return "foreground";
    if (this.presentedInstanceIds.includes(record.instanceId)) return "frozen";
    if (this.stack.some((frame) => frame.instanceId === record.instanceId)) return "frozen";
    return record.prewarmed ? "prewarmed" : "suspended";
  }

  private readGeneration(value: unknown): string | number | null {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return null;
  }

  private async presentTop(): Promise<void> {
    const top = this.stack[this.stack.length - 1];
    if (!top) throw new PocketSystemError("empty_stack", "System UI root frame is missing");
    this.applyPresentation([top.instanceId], top.instanceId);
    top && this.touch(this.records.get(top.instanceId));
  }

  private applyPresentation(
    instanceIds: readonly string[],
    focusedInstanceId: string | null,
  ): void {
    const next = [...instanceIds];
    const sameVisible = next.length === this.presentedInstanceIds.length &&
      next.every((value, index) => value === this.presentedInstanceIds[index]);
    if (sameVisible && focusedInstanceId === this.focusedInstanceId) return;
    this.presentedInstanceIds = next;
    this.focusedInstanceId = focusedInstanceId;
    for (const instanceId of instanceIds) this.touch(this.records.get(instanceId));
    for (const listener of [...this.presentationListeners]) {
      try {
        listener();
      } catch {
        // The host event lane and other presentation subscribers stay live.
      }
    }
  }

  private readSurfaceRegistry(): Record<string, number> {
    const ui = (globalThis as SystemGlobal).ui;
    const raw = ui?.__surfaces;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PocketSystemError(
        "compositor_registry_unavailable",
        "SystemUI requires a trusted ui.__surfaces compositor registry",
      );
    }
    const result: Record<string, number> = {};
    const handles = new Set<number>();
    const expected = new Set([...this.catalog.values()]
      .filter((entry) => entry.installed && entry.package !== this.systemUI)
      .map((entry) => entry.package));
    for (const [appId, rawHandle] of Object.entries(raw)) {
      // Native surface ids share ui.__surfaces with System applications. Keep
      // the legacy Flutter texture and dynamic glass/platform surfaces in
      // their own reserved ranges; only catalog app handles belong here.
      if (appId === "pocket.flutter.surface" && rawHandle === 1) continue;
      if (typeof rawHandle === "number" && Number.isInteger(rawHandle) && rawHandle >= 100) continue;
      if (!expected.has(appId)) {
        throw new PocketSystemError(
          "compositor_registry_mismatch",
          "ui.__surfaces contains an app outside the installed System catalog: " + appId,
        );
      }
      if (typeof rawHandle !== "number" || !Number.isInteger(rawHandle) || rawHandle < 2 || rawHandle > 63 || handles.has(rawHandle)) {
        throw new PocketSystemError(
          "compositor_registry_invalid",
          "compositor handles must be unique integers from 2 through 63",
        );
      }
      handles.add(rawHandle);
      result[appId] = rawHandle;
    }
    if (Object.keys(result).length !== expected.size || [...expected].some((appId) => result[appId] === undefined)) {
      throw new PocketSystemError(
        "compositor_registry_mismatch",
        "ui.__surfaces must match every installed child in the System catalog",
      );
    }
    return result;
  }

  private requireSurfaceHandle(appId: string): number {
    const handle = this.readSurfaceRegistry()[appId];
    if (handle === undefined) {
      throw new PocketSystemError("compositor_surface_missing", "no compositor handle for " + appId);
    }
    return handle;
  }

  private touch(record: RuntimeRecord | undefined): void {
    if (!record) return;
    record.lastUsed = this.nextLru();
  }

  private foregroundFrame(): StackFrame {
    const frame = this.stack[this.stack.length - 1];
    if (!frame) throw new PocketSystemError("empty_stack", "System UI root frame is missing");
    return frame;
  }

  private requireRuntime(appId: string, instanceId: string): RuntimeRecord {
    const record = this.records.get(instanceId);
    if (!record || record.appId !== appId) {
      throw new PocketSystemError("stale_runtime", "request source is not a current runtime instance");
    }
    return record;
  }

  private checkGeneration(record: RuntimeRecord, sourceGeneration: string | number): void {
    if (record.generation === null) {
      record.generation = sourceGeneration;
      return;
    }
    if (record.generation !== sourceGeneration) {
      throw new PocketSystemError("stale_runtime", "request runtime generation does not match");
    }
  }

  private authorizeRuntime(source: SystemRequest): RuntimeRecord {
    const record = this.requireRuntime(source.sourceAppId, source.sourceInstanceId);
    this.checkGeneration(record, source.sourceGeneration);
    this.touch(record);
    return record;
  }

  private authorizeForeground(source: SystemRequest): RuntimeRecord {
    const record = this.authorizeRuntime(source);
    if (record.appId === this.systemUI && record.instanceId === SYSTEM_UI_INSTANCE_ID) {
      return record;
    }
    const current = this.foregroundFrame();
    if (current.instanceId !== record.instanceId || current.appId !== record.appId) {
      throw new PocketSystemError("caller_not_foreground", "only the foreground app may use this capability");
    }
    return record;
  }

  private parseSystemRequest(payload: unknown): SystemRequest {
    if (!isRecord(payload)) throw new PocketSystemError("invalid_system_request", "system.request payload must be an object");
    if (
      !nonEmptyString(payload.requestId) ||
      !nonEmptyString(payload.sourceAppId) ||
      !nonEmptyString(payload.sourceInstanceId) ||
      (typeof payload.sourceGeneration !== "string" && typeof payload.sourceGeneration !== "number") ||
      (typeof payload.sourceGeneration === "number" && !Number.isFinite(payload.sourceGeneration)) ||
      !nonEmptyString(payload.capability)
    ) {
      throw new PocketSystemError("invalid_system_request", "system.request is missing its caller identity or capability");
    }
    return {
      requestId: payload.requestId,
      sourceAppId: payload.sourceAppId,
      sourceInstanceId: payload.sourceInstanceId,
      sourceGeneration: payload.sourceGeneration as string | number,
      capability: payload.capability,
      params: objectSnapshot(payload.params ?? {}, "system.request.params"),
    };
  }

  private requestKey(request: SystemRequest): string {
    return request.sourceInstanceId + "\u0000" + generationKey(request.sourceGeneration) + "\u0000" + request.requestId;
  }

  private rememberResponse(key: string, response: StoredResponse): void {
    this.completedRequests.delete(key);
    this.completedRequests.set(key, response);
    while (this.completedRequests.size > MAX_COMPLETED_REQUESTS) {
      const oldest = [...this.completedRequests]
        .find(([, value]) => !value.cleanupInstanceIds?.length)?.[0];
      if (oldest === undefined) break;
      this.completedRequests.delete(oldest);
    }
  }

  private async sendResponse(requestId: string, response: StoredResponse): Promise<void> {
    const payload: JsonObject = response.ok
      ? { requestId, ok: true, value: response.value ?? null }
      : { requestId, ok: false, error: response.error ?? { code: "system_error", message: "System request failed" } };
    await this.hostRequest("system.runtime.respond", payload);
  }

  private async finishResponse(response: StoredResponse): Promise<void> {
    if (!response.ok || !response.cleanupInstanceIds) return;
    for (let index = 0; index < response.cleanupInstanceIds.length;) {
      const instanceId = response.cleanupInstanceIds[index]!;
      const record = this.records.get(instanceId);
      if (!record) {
        response.cleanupInstanceIds.splice(index, 1);
        continue;
      }
      try {
        record.awaitingResponse = false;
        await this.destroyRuntime(record);
        response.cleanupInstanceIds.splice(index, 1);
      } catch {
        index += 1;
      }
    }
    if (response.cleanupInstanceIds.length === 0) delete response.cleanupInstanceIds;
  }

  private async handleSystemRequest(payload: unknown): Promise<void> {
    this.assertActive();
    if (!this.initialized) {
      throw new PocketSystemError("system_not_ready", "Pocket System kernel is not ready");
    }
    let request: SystemRequest;
    try {
      request = this.parseSystemRequest(payload);
    } catch (error) {
      if (isRecord(payload) && nonEmptyString(payload.requestId)) {
        await this.sendResponse(payload.requestId, { ok: false, error: errorShape(error) });
      }
      return;
    }
    const key = this.requestKey(request);
    const completed = this.completedRequests.get(key);
    if (completed) {
      try {
        await this.sendResponse(request.requestId, completed);
        await this.finishResponse(completed);
      } catch {
        // Retry both acknowledgement and its deferred teardown on a duplicate.
      }
      return;
    }
    let response: StoredResponse;
    try {
      const outcome = await this.dispatch(request);
      response = {
        ok: true,
        value: jsonSnapshot(outcome.value, "system response"),
        ...(outcome.cleanupInstanceIds ? { cleanupInstanceIds: [...outcome.cleanupInstanceIds] } : {}),
      };
    } catch (error) {
      response = { ok: false, error: errorShape(error) };
    }
    this.rememberResponse(key, response);
    try {
      await this.sendResponse(request.requestId, response);
      await this.finishResponse(response);
    } catch {
      // The completed response remains cached. A duplicate request event can
      // retry the host response without repeating the system mutation.
    }
  }

  private async dispatch(request: SystemRequest): Promise<DispatchOutcome> {
    if (request.capability === "platform.apps.list") {
      this.authorizeForeground(request);
      return { value: this.listApps() };
    }
    if (request.capability === "platform.apps.open") {
      return { value: await this.openApp(request) };
    }
    if (request.capability === "platform.apps.return") {
      return this.returnResult(request);
    }
    if (request.capability === "platform.apps.cancel") {
      return this.cancelApp(request);
    }
    if (request.capability === "platform.apps.prewarm") {
      return { value: await this.prewarmApp(request) };
    }
    if (request.capability.startsWith("platform.storage.")) {
      return { value: await this.storage(request) };
    }
    if (request.capability === "platform.messages.send") {
      return { value: await this.sendMessage(request) };
    }
    if (request.capability === "platform.messages.receive") {
      return { value: await this.receiveMessages(request) };
    }
    throw new PocketSystemError("capability_unavailable", "unsupported system capability: " + request.capability);
  }

  private listApps(): JsonValue {
    return [...this.catalog.values()].map((entry) => ({
      appId: entry.package,
      manifest: entry.manifest,
      required: entry.required,
      installed: entry.installed,
      running: this.instanceForApp.has(entry.package),
      ...(entry.presentation ? { presentation: entry.presentation } : {}),
    }));
  }

  private requireInstalled(appId: unknown): string {
    if (!nonEmptyString(appId) || !this.catalog.get(appId)?.installed) {
      throw new PocketSystemError("app_not_installed", "target app is not installed");
    }
    return appId;
  }

  private requirePolicyList(sourceAppId: string, field: "allowedOpenApps" | "messageTargets"): readonly string[] {
    return this.policies.get(sourceAppId)?.[field] ?? [];
  }

  private assertOpenAllowed(sourceAppId: string, targetAppId: string): void {
    if (sourceAppId === this.systemUI) return;
    if (!this.requirePolicyList(sourceAppId, "allowedOpenApps").includes(targetAppId)) {
      throw new PocketSystemError("open_denied", "app policy does not allow opening " + targetAppId);
    }
  }

  private async openApp(request: SystemRequest): Promise<JsonValue> {
    const caller = this.authorizeForeground(request);
    const resumeFrame = this.foregroundFrame();
    const resume = this.records.get(resumeFrame.instanceId);
    if (!resume) throw new PocketSystemError("stale_runtime", "foreground runtime is no longer resident");
    const targetAppId = this.requireInstalled(request.params.appId);
    this.assertOpenAllowed(caller.appId, targetAppId);
    if (this.stack.some((frame) => frame.appId === targetAppId)) {
      throw new PocketSystemError("app_call_cycle", "application call cycle is not allowed");
    }
    if (this.calls.size >= MAX_PENDING_CALLS) {
      throw new PocketSystemError("pending_call_limit", "too many pending app results");
    }
    const argumentsValue = jsonSnapshot(request.params.arguments ?? null, "app arguments");
    const callId = this.systemId + ":launch-" + this.nextCallId++;
    const existingId = this.instanceForApp.get(targetAppId);
    let target = existingId ? this.records.get(existingId) : undefined;
    const created = target === undefined;
    const wasPrewarmed = target?.prewarmed ?? false;
    if (created) {
      await this.ensureCapacity();
      target = await this.createRuntime(targetAppId, false);
    }
    if (!target) throw new PocketSystemError("runtime_create_failed", "target runtime could not be created");
    if (target.closing || target.failed) {
      throw new PocketSystemError("runtime_unavailable", "target runtime is closing or failed");
    }
    try {
      await this.lifecycle(resume, "onWillDisappear", { targetAppId, requestId: callId });
      await this.lifecycle(resume, "frozenInStack", { targetAppId, requestId: callId });
    } catch (error) {
      await this.lifecycle(resume, "onResume", { targetAppId, requestId: callId, rollback: true }).catch(() => {});
      await this.flushLifecycle(resume).catch(() => {});
      if (created) await this.destroyRuntime(target).catch(() => {});
      else target.prewarmed = wasPrewarmed;
      throw error;
    }
    const call: PendingCall = {
      requestId: callId,
      callerAppId: caller.appId,
      targetAppId,
      callerInstanceId: caller.instanceId,
      callerGeneration: caller.generation,
      resumeAppId: resume.appId,
      resumeInstanceId: resume.instanceId,
      targetInstanceId: target.instanceId,
      arguments: argumentsValue,
      completion: null,
      launchPending: true,
    };
    this.calls.set(callId, call);
    const frame: StackFrame = {
      appId: targetAppId,
      instanceId: target.instanceId,
      requestId: callId,
    };
    this.stack.push(frame);
    target.prewarmed = false;
    target.closing = false;
    this.touch(target);
    try {
      if (created) {
        await this.lifecycle(target, "onInit", { requestId: callId, prewarmed: false });
        await this.lifecycle(target, "onLoad", { requestId: callId, prewarmed: false });
      }
      await this.lifecycle(target, "onWillAppear", { requestId: callId });
      await this.presentTop();
      await this.awaitFirstFrame(target);
      await this.flushLifecycle(target);
      const launchAccepted = await this.post(target, "platform.launch", this.launchParams(call));
      if (!launchAccepted) {
        throw new PocketSystemError("runtime_unavailable", "target runtime did not accept its launch event");
      }
      call.launchPending = false;
      await this.lifecycle(target, "onDidAppear", { requestId: callId });
      await this.flushLifecycle(target);
      await this.flushForegroundMailbox(targetAppId);
      return {
        requestId: callId,
        targetAppId,
        targetInstanceId: target.instanceId,
      };
    } catch (error) {
      this.calls.delete(callId);
      if (this.stack[this.stack.length - 1]?.instanceId === target.instanceId) this.stack.pop();
      await this.presentTop().catch(() => {});
      await this.lifecycle(resume, "onResume", { targetAppId, requestId: callId, rollback: true }).catch(() => {});
      await this.flushLifecycle(resume).catch(() => {});
      if (created) await this.destroyRuntime(target).catch(() => {});
      else target.prewarmed = wasPrewarmed;
      throw error;
    }
  }

  private async createRuntime(appId: string, prewarmed: boolean): Promise<RuntimeRecord> {
    this.assertActive();
    const created = await this.hostObject("system.runtime.create", { appId });
    this.assertActive();
    const instanceId = created.instanceId;
    if (!nonEmptyString(instanceId) || instanceId === SYSTEM_UI_INSTANCE_ID) {
      throw new PocketSystemError("host_protocol_error", "runtime.create returned an invalid instanceId");
    }
    if (created.appId !== appId) {
      throw new PocketSystemError("host_protocol_error", "runtime.create returned a different appId");
    }
    if (this.records.has(instanceId) || this.instanceForApp.has(appId)) {
      throw new PocketSystemError("duplicate_runtime", "runtime.create returned an already resident instance");
    }
    const record: RuntimeRecord = {
      appId,
      instanceId,
      prewarmed,
      closing: false,
      awaitingResponse: false,
      failed: false,
      lastUsed: this.nextLru(),
      generation: this.readGeneration(created.generation),
      lifecycleQueue: [],
    };
    this.records.set(instanceId, record);
    this.instanceForApp.set(appId, instanceId);
    return record;
  }

  private async awaitFirstFrame(record: RuntimeRecord): Promise<void> {
    if (record.generation === null) {
      throw new PocketSystemError("host_protocol_error", "runtime.create omitted the child generation");
    }
    const ready = await this.hostObject("system.runtime.awaitFirstFrame", {
      instanceId: record.instanceId,
      generation: record.generation,
    });
    if (ready.ready !== true || ready.generation !== record.generation) {
      throw new PocketSystemError("host_protocol_error", "runtime.awaitFirstFrame returned a stale generation");
    }
  }

  private async ensureCapacity(): Promise<void> {
    if (this.records.size < this.maxResidentApps) return;
    const stackInstances = new Set(this.stack.map((frame) => frame.instanceId));
    const callInstances = new Set<string>();
    for (const call of this.calls.values()) {
      callInstances.add(call.callerInstanceId);
      callInstances.add(call.resumeInstanceId);
      callInstances.add(call.targetInstanceId);
    }
    const candidates = [...this.records.values()]
      .filter((record) =>
        record.instanceId !== SYSTEM_UI_INSTANCE_ID &&
        !stackInstances.has(record.instanceId) &&
        !callInstances.has(record.instanceId) &&
        !record.closing &&
        !record.failed)
      .sort((a, b) => a.lastUsed - b.lastUsed || a.instanceId.localeCompare(b.instanceId));
    const candidate = candidates[0];
    if (!candidate) {
      throw new PocketSystemError("resident_capacity", "resident app limit reached; no unreferenced runtime can be evicted");
    }
    await this.lifecycle(candidate, "onWillDisappear", { reason: "lru_eviction" });
    await this.lifecycle(candidate, "onUnload", { reason: "lru_eviction" });
    await this.flushLifecycle(candidate);
    candidate.closing = true;
    await this.destroyRuntime(candidate);
  }

  private async destroyRuntime(record: RuntimeRecord): Promise<void> {
    if (record.instanceId === SYSTEM_UI_INSTANCE_ID) {
      throw new PocketSystemError("system_ui_pinned", "System UI is a non-evictable runtime");
    }
    const stillReferenced = this.stack.some((frame) => frame.instanceId === record.instanceId) ||
      [...this.calls.values()].some((call) =>
        call.callerInstanceId === record.instanceId || call.resumeInstanceId === record.instanceId ||
        call.targetInstanceId === record.instanceId);
    if (stillReferenced) {
      throw new PocketSystemError("runtime_referenced", "runtime still has a stack or result reference");
    }
    await this.hostRequest("system.runtime.destroy", { instanceId: record.instanceId });
    this.assertActive();
    this.records.delete(record.instanceId);
    if (this.instanceForApp.get(record.appId) === record.instanceId) {
      this.instanceForApp.delete(record.appId);
    }
    record.prewarmed = false;
  }

  private async prewarmApp(request: SystemRequest): Promise<JsonValue> {
    const source = this.authorizeForeground(request);
    const appId = this.requireInstalled(request.params.appId);
    this.assertOpenAllowed(source.appId, appId);
    if (this.stack.some((frame) => frame.appId === appId)) {
      const current = this.instanceForApp.get(appId);
      return { appId, prewarmed: false, instanceId: current ?? null };
    }
    const existingId = this.instanceForApp.get(appId);
    if (existingId) {
      const existing = this.records.get(existingId)!;
      this.touch(existing);
      return { appId, prewarmed: existing.prewarmed, instanceId: existing.instanceId, reused: true };
    }
    await this.ensureCapacity();
    const record = await this.createRuntime(appId, true);
    await this.lifecycle(record, "onInit", { prewarmed: true });
    await this.lifecycle(record, "onLoad", { prewarmed: true });
    await this.lifecycle(record, "frozenInStack", { prewarmed: true });
    await this.flushLifecycle(record);
    return { appId, prewarmed: true, instanceId: record.instanceId };
  }

  private async returnResult(request: SystemRequest): Promise<DispatchOutcome> {
    const source = this.authorizeForeground(request);
    const frame = this.foregroundFrame();
    if (frame.instanceId !== source.instanceId || !frame.requestId) {
      throw new PocketSystemError("no_pending_result", "foreground app has no caller waiting for a result");
    }
    const call = this.calls.get(frame.requestId);
    if (!call || call.targetInstanceId !== source.instanceId) {
      throw new PocketSystemError("no_pending_result", "foreground app has no pending result token");
    }
    if (call.completion) {
      throw new PocketSystemError("result_already_completed", "launch result has already been completed");
    }
    const value = jsonSnapshot(request.params.value ?? null, "app result");
    const delivered = await this.completeTopCall(call, {
      cancelled: false,
      value,
    }, true);
    return {
      value: { returned: true, requestId: call.requestId, delivered },
      ...(delivered ? { cleanupInstanceIds: [call.targetInstanceId] } : {}),
    };
  }

  private async cancelApp(request: SystemRequest): Promise<DispatchOutcome> {
    const source = this.authorizeForeground(request);
    if (!nonEmptyString(request.params.requestId)) {
      throw new PocketSystemError("invalid_request_id", "cancel needs a launch requestId");
    }
    const call = this.calls.get(request.params.requestId);
    if (!call) throw new PocketSystemError("launch_not_pending", "launch request is not pending");
    if (call.completion) {
      throw new PocketSystemError("result_already_completed", "launch result has already been completed");
    }
    const targetIndex = this.stack.findIndex((frame) => frame.requestId === call.requestId);
    if (targetIndex < 1) throw new PocketSystemError("launch_not_active", "launch is not active");
    if (source.appId !== this.systemUI && source.instanceId !== call.targetInstanceId) {
      throw new PocketSystemError("cancel_denied", "only the foreground target or System UI may cancel this launch");
    }
    const deferTargetCleanup = source.instanceId === call.targetInstanceId;
    const delivered = await this.cancelStackFrom(targetIndex, "cancelled", deferTargetCleanup);
    return {
      value: { cancelled: true, requestId: call.requestId, delivered },
      ...(delivered && deferTargetCleanup ? { cleanupInstanceIds: [call.targetInstanceId] } : {}),
    };
  }

  private async completeTopCall(
    call: PendingCall,
    completion: AppResultMessage,
    deferTargetCleanup = false,
  ): Promise<boolean> {
    const target = this.records.get(call.targetInstanceId);
    const caller = this.records.get(call.callerInstanceId);
    const resume = this.records.get(call.resumeInstanceId);
    if (!target || !caller || !resume) {
      this.calls.delete(call.requestId);
      throw new PocketSystemError("stale_launch", "caller or target runtime no longer exists");
    }
    if (this.foregroundFrame().instanceId !== target.instanceId) {
      throw new PocketSystemError("caller_not_foreground", "only the foreground target may return a result");
    }
    call.completion = {
      cancelled: completion.cancelled,
      value: jsonSnapshot(completion.value, "app result"),
      ...(completion.reason ? { reason: completion.reason } : {}),
    };
    await this.lifecycle(target, "onWillDisappear", {
      requestId: call.requestId,
      reason: completion.reason ?? "returned",
    });
    if (this.stack[this.stack.length - 1]?.instanceId !== target.instanceId) {
      throw new PocketSystemError("stack_changed", "target is no longer at the top of the app stack");
    }
    this.stack.pop();
    target.closing = true;
    target.awaitingResponse = deferTargetCleanup;
    target.prewarmed = false;
    await this.presentTop();
    await this.lifecycle(target, "onUnload", { requestId: call.requestId, reason: completion.reason ?? "returned" });
    await this.lifecycle(resume, "onResume", { requestId: call.requestId, result: true });
    await this.flushLifecycle(resume);
    await this.flushForegroundMailbox(resume.appId);
    try {
      const delivered = await this.tryDeliverResult(call, deferTargetCleanup);
      if (!delivered && deferTargetCleanup) target.awaitingResponse = false;
      return delivered;
    } catch (error) {
      if (deferTargetCleanup) target.awaitingResponse = false;
      throw error;
    }
  }

  private async cancelStackFrom(index: number, reason: string, deferPrimaryCleanup = false): Promise<boolean> {
    if (index < 1 || index >= this.stack.length) {
      throw new PocketSystemError("launch_not_active", "launch is not on the app stack");
    }
    const frames = this.stack.slice(index);
    const primary = frames[0]!;
    const primaryCall = primary.requestId ? this.calls.get(primary.requestId) : undefined;
    if (!primaryCall) throw new PocketSystemError("launch_not_pending", "launch result token is missing");
    const target = this.records.get(primary.instanceId);
    if (!target) throw new PocketSystemError("stale_launch", "target runtime no longer exists");

    for (let frameIndex = frames.length - 1; frameIndex > 0; frameIndex -= 1) {
      const frame = frames[frameIndex]!;
      const nestedCall = frame.requestId ? this.calls.get(frame.requestId) : undefined;
      if (nestedCall) this.calls.delete(nestedCall.requestId);
    }
    primaryCall.completion = { cancelled: true, value: null, reason };
    for (let frameIndex = this.stack.length - 1; frameIndex > index; frameIndex -= 1) {
      const frame = this.stack[frameIndex]!;
      const nested = this.records.get(frame.instanceId);
      if (nested) {
        if (!nested.failed) {
          await this.lifecycle(nested, "onWillDisappear", { reason });
          await this.lifecycle(nested, "onUnload", { reason });
        }
        nested.closing = true;
        nested.prewarmed = false;
      }
    }
    for (let frameIndex = this.stack.length - 1; frameIndex >= index; frameIndex -= 1) {
      this.stack.pop();
    }
    for (let frameIndex = frames.length - 1; frameIndex > 0; frameIndex -= 1) {
      const nested = this.records.get(frames[frameIndex]!.instanceId);
      if (nested) await this.destroyDetachedRuntime(nested);
    }
    target.closing = true;
    target.awaitingResponse = deferPrimaryCleanup;
    target.prewarmed = false;
    if (!target.failed) {
      await this.lifecycle(target, "onWillDisappear", { requestId: primaryCall.requestId, reason });
    }
    await this.presentTop();
    if (!target.failed) await this.lifecycle(target, "onUnload", { requestId: primaryCall.requestId, reason });
    const resume = this.records.get(primaryCall.resumeInstanceId);
    if (resume) {
      await this.lifecycle(resume, "onResume", { requestId: primaryCall.requestId, reason });
      await this.flushLifecycle(resume);
      await this.flushForegroundMailbox(resume.appId);
    }
    try {
      const delivered = await this.tryDeliverResult(primaryCall, deferPrimaryCleanup);
      if (!delivered && deferPrimaryCleanup) target.awaitingResponse = false;
      return delivered;
    } catch (error) {
      if (deferPrimaryCleanup) target.awaitingResponse = false;
      throw error;
    }
  }

  private async destroyDetachedRuntime(record: RuntimeRecord): Promise<void> {
    const stackIndex = this.stack.findIndex((frame) => frame.instanceId === record.instanceId);
    if (stackIndex >= 0) {
      throw new PocketSystemError("runtime_referenced", "cannot destroy a runtime before it leaves the stack");
    }
    const hasCalls = [...this.calls.values()].some((call) =>
      call.callerInstanceId === record.instanceId || call.resumeInstanceId === record.instanceId ||
      call.targetInstanceId === record.instanceId);
    if (hasCalls) {
      throw new PocketSystemError("runtime_referenced", "cannot destroy a runtime with pending result references");
    }
    await this.hostRequest("system.runtime.destroy", { instanceId: record.instanceId });
    this.records.delete(record.instanceId);
    if (this.instanceForApp.get(record.appId) === record.instanceId) this.instanceForApp.delete(record.appId);
    record.prewarmed = false;
  }

  private async tryDeliverResult(call: PendingCall, deferTargetCleanup = false): Promise<boolean> {
    if (!call.completion) return false;
    const caller = this.records.get(call.callerInstanceId);
    if (!caller || caller.appId !== call.callerAppId) {
      this.calls.delete(call.requestId);
      const target = this.records.get(call.targetInstanceId);
      if (!deferTargetCleanup && target && !this.stack.some((frame) => frame.instanceId === target.instanceId)) {
        await this.destroyRuntime(target);
      }
      return false;
    }
    if (this.foregroundFrame().instanceId !== caller.instanceId && caller.appId !== this.systemUI) return false;
    const result: JsonObject = {
      requestId: call.requestId,
      appId: call.targetAppId,
      cancelled: call.completion.cancelled,
      value: call.completion.value,
      ...(call.completion.reason ? { reason: call.completion.reason } : {}),
    };
    const accepted = await this.post(caller, "platform.result", result);
    if (!accepted) return false;
    this.calls.delete(call.requestId);
    const target = this.records.get(call.targetInstanceId);
    if (!deferTargetCleanup && target && !this.stack.some((frame) => frame.instanceId === target.instanceId)) {
      await this.destroyRuntime(target);
    }
    return true;
  }

  private async storage(request: SystemRequest): Promise<JsonValue> {
    // Storage may be requested by an app's hidden first-frame boot before a
    // prewarmed runtime is presented. The host still gates suspended JS ticks;
    // this authorizes only the explicit in-flight I/O request.
    const source = this.authorizeRuntime(request);
    const operation = request.capability.slice("platform.storage.".length);
    if (!["get", "set", "remove", "keys"].includes(operation)) {
      throw new PocketSystemError("capability_unavailable", "unsupported storage operation");
    }
    const namespace = request.params.namespace;
    if (namespace !== undefined) {
      if (!nonEmptyString(namespace)) throw new PocketSystemError("invalid_namespace", "namespace must be a string");
      const allowed = this.policies.get(source.appId)?.sharedNamespaces ?? [];
      if (!allowed.includes(namespace)) {
        throw new PocketSystemError("shared_namespace_denied", "app is not granted shared namespace " + namespace);
      }
    }
    const params: JsonObject = { appId: source.appId };
    if (operation !== "keys") {
      if (!nonEmptyString(request.params.key)) {
        throw new PocketSystemError("invalid_storage_key", "storage key must be a non-empty string");
      }
      params.key = request.params.key;
    }
    if (namespace !== undefined) params.namespace = namespace;
    if (operation === "set") {
      params.value = jsonSnapshot(request.params.value ?? null, "storage value");
    }
    return await this.hostRequest("system.storage." + operation, params);
  }

  private async sendMessage(request: SystemRequest): Promise<JsonValue> {
    const source = this.authorizeForeground(request);
    const targetAppId = this.requireInstalled(request.params.appId);
    if (!this.requirePolicyList(source.appId, "messageTargets").includes(targetAppId) && source.appId !== this.systemUI) {
      throw new PocketSystemError("message_denied", "app policy does not allow messaging " + targetAppId);
    }
    const topic = request.params.topic === undefined ? "default" : request.params.topic;
    if (!nonEmptyString(topic)) throw new PocketSystemError("invalid_topic", "message topic must be a non-empty string");
    const message: PocketAppMessage = {
      id: this.systemId + ":message-" + this.nextMessageId++,
      sourceAppId: source.appId,
      targetAppId,
      topic,
      data: jsonSnapshot(request.params.data ?? null, "message data"),
    };
    const targetInstanceId = this.instanceForApp.get(targetAppId);
    const targetRecord = targetInstanceId ? this.records.get(targetInstanceId) : undefined;
    const foreground = this.foregroundFrame();
    if (targetRecord && foreground.instanceId === targetRecord.instanceId) {
      const accepted = await this.post(targetRecord, "platform.message", message as unknown as JsonObject);
      if (accepted) return { sent: true, queued: false, messageId: message.id };
    }
    if (this.mailbox.length >= MAX_MAILBOX_MESSAGES) {
      throw new PocketSystemError("mailbox_full", "system message queue is full");
    }
    this.mailbox.push(message);
    return { sent: true, queued: true, messageId: message.id };
  }

  private async receiveMessages(request: SystemRequest): Promise<JsonValue> {
    const source = this.authorizeForeground(request);
    const before = this.mailbox.filter((message) => message.targetAppId === source.appId).length;
    await this.flushForegroundMailbox(source.appId);
    const after = this.mailbox.filter((message) => message.targetAppId === source.appId).length;
    return { delivered: before - after, pending: after };
  }

  private async flushForegroundWork(): Promise<void> {
    if (this.disposed || !this.initialized) return;
    await this.flushPendingLaunches();
    await this.flushPendingResults();
    const frame = this.foregroundFrame();
    const runtime = this.records.get(frame.instanceId);
    if (runtime) {
      await this.flushLifecycle(runtime);
      await this.flushForegroundMailbox(runtime.appId);
    }
    await this.flushClosingRuntimes();
  }

  private async flushClosingRuntimes(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (!record.closing || record.awaitingResponse) continue;
      const referenced = this.stack.some((frame) => frame.instanceId === record.instanceId) ||
        [...this.calls.values()].some((call) =>
          call.callerInstanceId === record.instanceId || call.resumeInstanceId === record.instanceId ||
          call.targetInstanceId === record.instanceId);
      if (referenced) continue;
      try { await this.destroyRuntime(record); } catch { /* Retry on the next host event. */ }
    }
  }

  private launchParams(call: PendingCall): JsonObject {
    return {
      requestId: call.requestId,
      appId: call.targetAppId,
      callerAppId: call.callerAppId,
      callerInstanceId: call.callerInstanceId,
      arguments: call.arguments,
    };
  }

  private async flushPendingLaunches(): Promise<void> {
    for (const call of [...this.calls.values()]) {
      if (this.disposed || !call.launchPending) continue;
      const target = this.records.get(call.targetInstanceId);
      if (!target || target.failed || target.closing || target.lifecycleQueue.length > 0) continue;
      const frameIndex = this.stack.findIndex((frame) => frame.requestId === call.requestId);
      if (frameIndex !== this.stack.length - 1) continue;
      if (await this.post(target, "platform.launch", this.launchParams(call))) {
        call.launchPending = false;
      }
    }
  }

  private async flushPendingResults(): Promise<void> {
    for (const call of [...this.calls.values()]) {
      if (this.disposed) return;
      if (!call.completion) continue;
      if (this.foregroundFrame().instanceId !== call.callerInstanceId && call.callerAppId !== this.systemUI) continue;
      await this.tryDeliverResult(call);
    }
  }

  private async flushForegroundMailbox(appId: string): Promise<void> {
    const frame = this.foregroundFrame();
    if (frame.appId !== appId) return;
    const instanceId = this.instanceForApp.get(appId);
    const runtime = instanceId ? this.records.get(instanceId) : undefined;
    if (!runtime || runtime.instanceId !== frame.instanceId) return;
    for (let index = 0; index < this.mailbox.length;) {
      const message = this.mailbox[index]!;
      if (message.targetAppId !== appId) {
        index += 1;
        continue;
      }
      const accepted = await this.post(runtime, "platform.message", message as unknown as JsonObject);
      if (!accepted) break;
      this.mailbox.splice(index, 1);
    }
  }

  private async lifecycle(
    record: RuntimeRecord,
    state: LifecycleState,
    extra: JsonObject = {},
  ): Promise<void> {
    const params: JsonObject = {
      appId: record.appId,
      instanceId: record.instanceId,
      state,
      ...extra,
    };
    const accepted = await this.post(record, "platform.lifecycle", params);
    if (!accepted && record.lifecycleQueue.length < 32) {
      record.lifecycleQueue.push(params);
    }
  }

  private async flushLifecycle(record: RuntimeRecord): Promise<void> {
    while (!this.disposed && record.lifecycleQueue.length > 0) {
      const params = record.lifecycleQueue[0]!;
      const accepted = await this.post(record, "platform.lifecycle", params);
      if (!accepted) return;
      record.lifecycleQueue.shift();
    }
  }

  private async post(record: RuntimeRecord, event: string, params: JsonObject): Promise<boolean> {
    const response = await this.hostObject("system.runtime.post", {
      instanceId: record.instanceId,
      event,
      params,
    });
    return response.accepted === true;
  }

  private async handleRuntimeTermination(payload: unknown, failed: boolean): Promise<void> {
    if (!isRecord(payload) || !nonEmptyString(payload.instanceId) || !nonEmptyString(payload.appId)) return;
    const instanceId = payload.instanceId;
    const record = this.records.get(instanceId);
    if (!record || record.appId !== payload.appId) return;
    const error = payload.error;
    const reason = failed
      ? (isRecord(error) && nonEmptyString(error.code) ? error.code : "runtime_failed")
      : "closed";
    record.failed = true;
    record.awaitingResponse = false;
    const index = this.stack.findIndex((frame) => frame.instanceId === instanceId);
    if (index > 0) {
      await this.cancelStackFrom(index, reason);
      return;
    }
    if (index === 0) {
      this.initialized = false;
      this.dispose();
      return;
    }
    if (index < 0) {
      record.closing = true;
      await this.destroyRuntime(record).catch(() => {});
    }
  }

  private async handleGenerationChange(payload: unknown): Promise<void> {
    if (
      !isRecord(payload) ||
      !nonEmptyString(payload.instanceId) ||
      !nonEmptyString(payload.appId) ||
      (typeof payload.previousGeneration !== "string" && typeof payload.previousGeneration !== "number") ||
      (typeof payload.generation !== "string" && typeof payload.generation !== "number") ||
      (typeof payload.previousGeneration === "number" && !Number.isFinite(payload.previousGeneration)) ||
      (typeof payload.generation === "number" && !Number.isFinite(payload.generation))
    ) return;
    const instanceId = payload.instanceId;
    const record = this.records.get(instanceId);
    if (
      !record ||
      record.appId !== payload.appId ||
      record.failed ||
      record.closing ||
      record.generation !== payload.previousGeneration ||
      record.generation === payload.generation
    ) return;

    const oldGeneration = payload.previousGeneration;
    const oldPrefix = instanceId + "\u0000" + generationKey(oldGeneration) + "\u0000";
    for (const key of [...this.completedRequests.keys()]) {
      if (key.startsWith(oldPrefix)) this.completedRequests.delete(key);
    }

    const oldCallerCalls = [...this.calls.values()].filter((call) =>
      call.callerInstanceId === instanceId && call.callerGeneration === oldGeneration);
    const activeTargetIndexes = oldCallerCalls
      .map((call) => this.stack.findIndex((frame) => frame.requestId === call.requestId))
      .filter((index) => index > 0);
    if (activeTargetIndexes.length > 0) {
      await this.abandonStackFrom(Math.min(...activeTargetIndexes), "caller_generation_changed");
    }
    for (const call of oldCallerCalls) {
      if (!this.calls.delete(call.requestId)) continue;
      const target = this.records.get(call.targetInstanceId);
      if (target && !this.stack.some((frame) => frame.instanceId === target.instanceId)) {
        target.closing = true;
        await this.destroyRuntime(target).catch(() => {});
      }
    }

    record.generation = payload.generation;
    record.lifecycleQueue.length = 0;
    const frameIndex = this.stack.findIndex((frame) => frame.instanceId === instanceId);
    const isForeground = frameIndex === this.stack.length - 1;
    if (isForeground) await this.presentTop();
    await this.lifecycle(record, "onInit", { generationChanged: true });
    await this.lifecycle(record, "onLoad", { generationChanged: true });
    if (isForeground) {
      await this.lifecycle(record, "onWillAppear", { generationChanged: true });
      await this.lifecycle(record, "onDidAppear", { generationChanged: true });
    } else {
      await this.lifecycle(record, "frozenInStack", { generationChanged: true });
    }
    await this.flushLifecycle(record);

    const frame = frameIndex >= 0 ? this.stack[frameIndex] : undefined;
    const launchCall = frame?.requestId ? this.calls.get(frame.requestId) : undefined;
    if (launchCall) {
      // The new guest has no retained listeners or launch props from the old
      // generation. Rehydrate its open context from the bounded JS call record.
      launchCall.launchPending = true;
      await this.flushPendingLaunches();
    }
  }

  private async abandonStackFrom(index: number, reason: string): Promise<void> {
    if (index < 1 || index >= this.stack.length) return;
    const removedFrames = this.stack.slice(index);
    const removedInstanceIds = new Set(removedFrames.map((frame) => frame.instanceId));
    const removedRequestIds = new Set(removedFrames.flatMap((frame) => frame.requestId ? [frame.requestId] : []));
    const orphanTargets = new Set<string>();
    for (let frameIndex = removedFrames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const record = this.records.get(removedFrames[frameIndex]!.instanceId);
      if (record && !record.failed) {
        await this.lifecycle(record, "onWillDisappear", { reason });
        await this.lifecycle(record, "onUnload", { reason });
      }
    }
    for (const [requestId, call] of this.calls) {
      if (
        removedRequestIds.has(requestId) ||
        removedInstanceIds.has(call.callerInstanceId) ||
        removedInstanceIds.has(call.targetInstanceId)
      ) {
        this.calls.delete(requestId);
        if (!removedInstanceIds.has(call.targetInstanceId)) orphanTargets.add(call.targetInstanceId);
      }
    }
    while (this.stack.length > index) this.stack.pop();
    for (let frameIndex = removedFrames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const record = this.records.get(removedFrames[frameIndex]!.instanceId);
      if (record) {
        record.closing = true;
        try { await this.destroyDetachedRuntime(record); } catch { /* Retry after the generation event. */ }
      }
    }
    for (const instanceId of orphanTargets) {
      const record = this.records.get(instanceId);
      if (record && !this.stack.some((frame) => frame.instanceId === instanceId)) {
        record.closing = true;
        await this.destroyRuntime(record).catch(() => {});
      }
    }
    await this.presentTop();
    const caller = this.records.get(this.foregroundFrame().instanceId);
    if (caller) {
      await this.lifecycle(caller, "onResume", { reason });
      await this.flushLifecycle(caller);
      await this.flushForegroundMailbox(caller.appId);
    }
  }
}

/** Install the JS-owned app registry, stack, result router and resident policy. */
export function installPocketSystem(
  manifest: PocketSystemV1,
  options: InstallPocketSystemOptions,
): PocketSystemKernel {
  if (!options || !options.bridge || typeof options.bridge.request !== "function") {
    throw new PocketSystemError("invalid_options", "installPocketSystem needs a HostBridge");
  }
  const parsed = parseManifest(manifest);
  return new PocketSystemKernelImpl(manifest, options, parsed);
}
