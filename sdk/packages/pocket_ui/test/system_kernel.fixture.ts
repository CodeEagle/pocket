import { strict as assert } from "node:assert";

import type { HostBridge, JsonObject, JsonValue } from "../src/host.ts";
import { installPocketSystem, type PocketSystemV1 } from "../src/system.ts";

const SYSTEM_UI = "pocket.host.demo";
const PROFILE = "pocket.demo.profile";
const LOBBY = "pocket.demo.lobby";
const NOTES = "pocket.demo.notes";

const manifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: "pocket.demo.system",
  roles: { systemUI: SYSTEM_UI },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: SYSTEM_UI, manifest: "pocket.json", required: true },
      { package: PROFILE, manifest: "apps/profile/pocket.json", required: true },
      { package: LOBBY, manifest: "apps/lobby/pocket.json", required: true },
      { package: NOTES, manifest: "apps/notes/pocket.json", required: false },
    ],
  },
  installation: { installedPackages: [SYSTEM_UI, PROFILE, LOBBY, NOTES] },
};

const policies = {
  [SYSTEM_UI]: {
    allowedOpenApps: [PROFILE, LOBBY, NOTES],
    messageTargets: [PROFILE, LOBBY, NOTES],
    sharedNamespaces: ["identity"],
  },
  [PROFILE]: {
    allowedOpenApps: [SYSTEM_UI, LOBBY],
    messageTargets: [SYSTEM_UI],
    sharedNamespaces: ["identity"],
  },
  [LOBBY]: {
    allowedOpenApps: [],
    messageTargets: [SYSTEM_UI],
    sharedNamespaces: ["identity"],
  },
  [NOTES]: {
    allowedOpenApps: [],
    messageTargets: [],
    sharedNamespaces: [],
  },
} as const;

interface HostCall {
  capability: string;
  params: JsonObject;
}

interface CallWaiter {
  after: number;
  matches: (call: HostCall) => boolean;
  resolve: (call: HostCall) => void;
}

class FakeHost implements HostBridge {
  readonly calls: HostCall[] = [];
  readonly posted: Array<{ instanceId: string; event: string; params: JsonObject }> = [];
  readonly destroyed: string[] = [];
  readonly generations = new Map<string, string>();
  readonly storage = new Map<string, JsonValue>();
  readonly handled: Array<string | Record<string, unknown>> = [];
  readonly rejectedPostEvents: string[] = [];
  failRespondRequestId: string | null = null;
  ticks = 0;
  disposed = false;
  private nextInstance = 1;
  private readonly waiters: CallWaiter[] = [];

  request<T extends JsonValue = JsonValue>(capability: string, params: JsonObject = {}): Promise<T> {
    const call: HostCall = { capability, params };
    this.calls.push(call);
    this.wakeWaiters(call, this.calls.length - 1);
    return Promise.resolve(this.respond(capability, params) as T);
  }

  handle(packet: string | Record<string, unknown>): boolean {
    this.handled.push(packet);
    return false;
  }

  tick(): void {
    this.ticks += 1;
  }

  dispose(): void {
    this.disposed = true;
  }

  waitForCall(matches: (call: HostCall) => boolean, after = 0): Promise<HostCall> {
    const found = this.calls.slice(after).find(matches);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => this.waiters.push({ after, matches, resolve }));
  }

  private wakeWaiters(call: HostCall, index: number): void {
    for (let waiterIndex = this.waiters.length - 1; waiterIndex >= 0; waiterIndex -= 1) {
      const waiter = this.waiters[waiterIndex]!;
      if (index < waiter.after || !waiter.matches(call)) continue;
      this.waiters.splice(waiterIndex, 1);
      waiter.resolve(call);
    }
  }

  private respond(capability: string, params: JsonObject): JsonValue {
    if (capability === "system.runtime.configure") {
      return { systemInstanceId: "system-ui" };
    }
    if (capability === "system.runtime.create") {
      const appId = String(params.appId);
      const instanceId = `instance-${this.nextInstance++}`;
      const generation = `generation-${instanceId}`;
      this.generations.set(instanceId, generation);
      return { appId, instanceId, generation };
    }
    if (capability === "system.runtime.awaitFirstFrame") {
      return { ready: true, generation: params.generation };
    }
    if (capability === "system.runtime.destroy") {
      this.destroyed.push(String(params.instanceId));
      return null;
    }
    if (capability === "system.runtime.post") {
      const instanceId = String(params.instanceId);
      const event = String(params.event);
      const eventParams = params.params as JsonObject;
      this.posted.push({ instanceId, event, params: eventParams });
      const rejectedIndex = this.rejectedPostEvents.indexOf(event);
      if (rejectedIndex >= 0) {
        this.rejectedPostEvents.splice(rejectedIndex, 1);
        return { accepted: false };
      }
      return { accepted: true };
    }
    if (capability === "system.runtime.respond") {
      if (params.requestId === this.failRespondRequestId) {
        this.failRespondRequestId = null;
        throw new Error("simulated response transport failure");
      }
      return null;
    }
    if (capability.startsWith("system.storage.")) return this.respondStorage(capability, params);
    throw new Error(`unexpected host capability ${capability}`);
  }

  private respondStorage(capability: string, params: JsonObject): JsonValue {
    const appId = String(params.appId);
    const namespace = typeof params.namespace === "string" ? params.namespace : "private";
    const prefix = `${appId}\u0000${namespace}\u0000`;
    const key = typeof params.key === "string" ? prefix + params.key : undefined;
    if (capability === "system.storage.set") {
      this.storage.set(key!, params.value ?? null);
      return { stored: true };
    }
    if (capability === "system.storage.get") return this.storage.get(key!) ?? null;
    if (capability === "system.storage.remove") return { removed: this.storage.delete(key!) };
    if (capability === "system.storage.keys") {
      return [...this.storage.keys()]
        .filter((item) => item.startsWith(prefix))
        .map((item) => item.slice(prefix.length));
    }
    throw new Error(`unexpected storage capability ${capability}`);
  }
}

const globalObject = globalThis as typeof globalThis & {
  __pocketEvent?: (line: string) => void;
  ui?: { __surfaces?: Record<string, number> };
};
globalObject.ui = {
  __surfaces: {
    [PROFILE]: 2,
    [LOBBY]: 3,
    [NOTES]: 4,
  },
};
const forwarded: string[] = [];
const previousEvent = (line: string): void => forwarded.push(line);
globalObject.__pocketEvent = previousEvent;

const host = new FakeHost();
const kernel = installPocketSystem(manifest, {
  bridge: host,
  maxResidentApps: 3,
  policies,
});
await kernel.ready;

assert.deepEqual(host.calls.slice(0, 1), [
  { capability: "system.runtime.configure", params: {
    systemUI: SYSTEM_UI,
    grants: [
      { appId: LOBBY, sharedNamespaces: ["identity"] },
      { appId: NOTES, sharedNamespaces: [] },
      { appId: PROFILE, sharedNamespaces: ["identity"] },
      { appId: SYSTEM_UI, sharedNamespaces: ["identity"] },
    ],
  } },
]);
assert.equal(host.calls.some((call) => call.capability === "system.runtime.create"), false, "the host boots SystemUI");
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.equal(kernel.snapshot().residentCount, 1, "the pinned SystemUI uses one resident slot");
assert.equal(kernel.snapshot().maxResidentApps, 3);

let requestNumber = 0;
function request(
  sourceAppId: string,
  sourceInstanceId: string,
  capability: string,
  params: JsonObject = {},
  sourceGeneration?: string,
  requestId?: string,
): JsonObject {
  return {
    requestId: requestId ?? `rpc-${++requestNumber}`,
    sourceAppId,
    sourceInstanceId,
    sourceGeneration: sourceGeneration ?? (sourceInstanceId === "system-ui"
      ? "system-ui-generation"
      : host.generations.get(sourceInstanceId) ?? "missing-generation"),
    capability,
    params,
  };
}

function sendEvent(name: string, payload: JsonObject): void {
  const sink = globalObject.__pocketEvent;
  assert.equal(typeof sink, "function", "kernel should chain the existing event callback");
  sink!(JSON.stringify({ type: "event", name, payload }));
}

async function invoke(payload: JsonObject): Promise<JsonObject> {
  const start = host.calls.length;
  const responseCall = host.waitForCall((call) => call.capability === "system.runtime.respond", start);
  sendEvent("system.request", payload);
  return await responseCall.then((call) => call.params);
}

function valueOf(response: JsonObject): JsonValue {
  assert.equal(response.ok, true, `expected success, received ${JSON.stringify(response.error)}`);
  return response.value ?? null;
}

function errorCode(response: JsonObject): string {
  assert.equal(response.ok, false, "expected a rejected request");
  return String((response.error as JsonObject | undefined)?.code);
}

function instanceOf(appId: string): string {
  const record = kernel.snapshot().residents.find((item) => item.appId === appId);
  assert.ok(record, `expected ${appId} to be resident`);
  return record.instanceId;
}

function launchId(value: JsonValue): string {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const requestId = (value as JsonObject).requestId;
  assert.equal(typeof requestId, "string");
  return requestId as string;
}

// The request queue serializes duplicate launch RPCs: one runtime and one
// stack transition, followed by the cached response replay.
const profileOpen = request(SYSTEM_UI, "system-ui", "platform.apps.open", {
  appId: PROFILE,
  arguments: { source: "system" },
}, undefined, "duplicate-open");
const profileOpened = await invoke(profileOpen);
const profileDuplicate = await invoke(profileOpen);
assert.deepEqual(profileDuplicate, profileOpened);
assert.equal(host.calls.filter((call) => call.capability === "system.runtime.create" && call.params.appId === PROFILE).length, 1);
assert.equal(launchId(valueOf(profileOpened)), launchId(valueOf(profileDuplicate)));
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
const profileInstance = instanceOf(PROFILE);
const profileFrameWait = host.calls.find((call) =>
  call.capability === "system.runtime.awaitFirstFrame" && call.params.instanceId === profileInstance,
);
assert.deepEqual(profileFrameWait?.params, {
  instanceId: profileInstance,
  generation: host.generations.get(profileInstance),
}, "open waits for the child's frame through an event response");
assert.deepEqual(kernel.surfaceBindings(), [{
  appId: PROFILE,
  instanceId: profileInstance,
  surfaceHandle: 2,
  focused: true,
}]);
const registry = globalObject.ui.__surfaces;
registry["pocket.flutter.surface"] = 1;
registry["pocket.glass.blur"] = 100;
registry["pocket.platform.camera"] = 101;
assert.deepEqual(kernel.surfaceBindings(), [{
  appId: PROFILE,
  instanceId: profileInstance,
  surfaceHandle: 2,
  focused: true,
}], "legacy Flutter and dynamic glass/platform handles coexist in ui.__surfaces");
delete registry["pocket.flutter.surface"];
delete registry["pocket.glass.blur"];
delete registry["pocket.platform.camera"];
registry[LOBBY] = 2;
assert.throws(() => kernel.surfaceBindings(), /handles must be unique/);
registry[LOBBY] = 3;
registry["pocket.app.untrusted"] = 5;
assert.throws(() => kernel.surfaceBindings(), /app outside the installed System catalog/);
delete registry["pocket.app.untrusted"];

// A stale generation cannot act as the current runtime.
assert.equal(errorCode(await invoke(request(PROFILE, profileInstance, "platform.apps.list", {}, "stale-generation"))), "stale_runtime");

// Each source can only mutate the foreground stack; the trusted SystemUI may
// continue routing requests from its always-live control realm.
const directSystemOpen = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", {
  appId: LOBBY,
  arguments: { source: "system-ui-control" },
})));
const directSystemLobby = instanceOf(LOBBY);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE, LOBBY]);
assert.equal(kernel.snapshot().pendingCalls.at(-1)?.callerAppId, SYSTEM_UI);
assert.equal(kernel.snapshot().pendingCalls.at(-1)?.resumeAppId, PROFILE);
const directSystemReturn = await invoke(request(LOBBY, directSystemLobby, "platform.apps.return", {
  value: { fromSystem: true },
}));
assert.equal((valueOf(directSystemReturn) as JsonObject).delivered, true);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
assert.ok(host.posted.some((post) => post.instanceId === "system-ui" && post.event === "platform.result" &&
  post.params.requestId === launchId(directSystemOpen)));
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === directSystemLobby);

const lobbyOpened = await invoke(request(PROFILE, profileInstance, "platform.apps.open", { appId: LOBBY }));
const lobbyInstance = instanceOf(LOBBY);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE, LOBBY]);
let presentationChanges = 0;
const stopPresentations = kernel.subscribe(() => { presentationChanges += 1; });
await kernel.presentSurfaces([PROFILE, LOBBY], LOBBY);
assert.deepEqual(kernel.surfaceBindings(), [
  { appId: PROFILE, instanceId: profileInstance, surfaceHandle: 2, focused: false },
  { appId: LOBBY, instanceId: lobbyInstance, surfaceHandle: 3, focused: true },
]);
assert.equal(
  host.calls.some((call) => call.capability === "system.runtime.present"),
  false,
  "DrawOps visibility is the only host surface fact; Dart does not mirror a System presentation list",
);
assert.equal(presentationChanges, 1, "surface consumers wake from a policy event, not a poll");
await assert.rejects(
  kernel.presentSurfaces([PROFILE, LOBBY], PROFILE),
  /focused surface must match/,
);
assert.equal(presentationChanges, 1, "a rejected focus change does not publish a partial presentation");
stopPresentations();
assert.equal(errorCode(await invoke(request(PROFILE, profileInstance, "platform.apps.return", { value: null }))), "caller_not_foreground");
assert.equal(errorCode(await invoke(request(LOBBY, lobbyInstance, "platform.apps.open", { appId: PROFILE }))), "open_denied");

const lobbyReturned = await invoke(request(LOBBY, lobbyInstance, "platform.apps.return", {
  value: { joined: true },
}));
assert.equal(valueOf(lobbyReturned) && (valueOf(lobbyReturned) as JsonObject).returned, true);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
assert.ok(host.posted.some((post) => post.instanceId === profileInstance && post.event === "platform.result" &&
  post.params.requestId === launchId(valueOf(lobbyOpened))));
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === lobbyInstance);
assert.ok(host.destroyed.includes(lobbyInstance));

const profileReturn = await invoke(request(PROFILE, profileInstance, "platform.apps.return", {
  value: { profile: "done" },
}));
assert.equal((valueOf(profileReturn) as JsonObject).returned, true);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.deepEqual(kernel.surfaceBindings(), [], "return removes the child surface binding");
assert.ok(host.posted.some((post) => post.instanceId === "system-ui" && post.event === "platform.result" &&
  post.params.requestId === launchId(valueOf(profileOpened))));
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === profileInstance);
assert.ok(host.destroyed.includes(profileInstance));

// A SystemUI cancellation unwinds every nested caller and target, clearing both
// result references before attempting native teardown.
const nestedProfile = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", { appId: PROFILE })));
const nestedProfileInstance = instanceOf(PROFILE);
const nestedLobby = valueOf(await invoke(request(PROFILE, nestedProfileInstance, "platform.apps.open", { appId: LOBBY })));
const nestedLobbyInstance = instanceOf(LOBBY);
const cancelResult = await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.cancel", {
  requestId: launchId(nestedProfile),
}));
assert.equal((valueOf(cancelResult) as JsonObject).cancelled, true);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.equal(kernel.snapshot().pendingCalls.length, 0);
assert.ok(host.destroyed.includes(nestedProfileInstance));
assert.ok(host.destroyed.includes(nestedLobbyInstance));
assert.ok(host.posted.some((post) => post.instanceId === "system-ui" && post.event === "platform.result" &&
  post.params.requestId === launchId(nestedProfile)));
assert.ok(launchId(nestedLobby).length > 0);

// A target remount keeps its parent result token and replays its bounded launch
// arguments into the new generation. The old generation's cached request must
// not replay a success after the host advances the generation.
const targetRemountOpen = request(SYSTEM_UI, "system-ui", "platform.apps.open", {
  appId: PROFILE,
  arguments: { route: "after-update" },
});
const targetRemountToken = valueOf(await invoke(targetRemountOpen));
const targetRemountInstance = instanceOf(PROFILE);
const targetPreviousGeneration = host.generations.get(targetRemountInstance)!;
const oldGenerationCache = request(PROFILE, targetRemountInstance, "platform.apps.list", {}, targetPreviousGeneration, "old-generation-cache");
assert.equal(valueOf(await invoke(oldGenerationCache)) instanceof Array, true);
const targetNextGeneration = `${targetPreviousGeneration}-remount`;
host.generations.set(targetRemountInstance, targetNextGeneration);
const targetRemountStart = host.calls.length;
const targetLifecycle = host.waitForCall((call) => call.capability === "system.runtime.post" &&
  call.params.event === "platform.lifecycle" &&
  (call.params.params as JsonObject).state === "onInit" &&
  (call.params.params as JsonObject).generationChanged === true, targetRemountStart);
const targetLaunchReplay = host.waitForCall((call) => call.capability === "system.runtime.post" &&
  call.params.event === "platform.launch" &&
  (call.params.params as JsonObject).requestId === launchId(targetRemountToken), targetRemountStart);
sendEvent("system.runtime.generation", {
  instanceId: targetRemountInstance,
  appId: PROFILE,
  previousGeneration: targetPreviousGeneration,
  generation: targetNextGeneration,
});
const [targetLifecycleCall, targetLaunchReplayCall] = await Promise.all([targetLifecycle, targetLaunchReplay]);
assert.equal((targetLifecycleCall.params.params as JsonObject).generationChanged, true);
assert.equal(targetLaunchReplayCall.params.event, "platform.launch");
const replayedLaunch = host.posted.find((post) => post.instanceId === targetRemountInstance &&
  post.event === "platform.launch" && post.params.requestId === launchId(targetRemountToken));
assert.deepEqual(replayedLaunch?.params.arguments, { route: "after-update" });
assert.equal(kernel.snapshot().residents.find((record) => record.instanceId === targetRemountInstance)?.generation, targetNextGeneration);
assert.equal(errorCode(await invoke(oldGenerationCache)), "stale_runtime");
const targetRemountReturn = await invoke(request(PROFILE, targetRemountInstance, "platform.apps.return", {
  value: { updated: true },
}, targetNextGeneration));
assert.equal((valueOf(targetRemountReturn) as JsonObject).returned, true);
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === targetRemountInstance);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);

// When a caller generation changes while its child is open, the child call and
// subtree are abandoned without delivering an old token to the new caller.
// The caller's own parent token remains valid and receives a replayed launch.
const callerRemountOpen = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", {
  appId: PROFILE,
  arguments: { page: "settings" },
})));
const callerRemountInstance = instanceOf(PROFILE);
const callerPreviousGeneration = host.generations.get(callerRemountInstance)!;
const oldCallerCache = request(PROFILE, callerRemountInstance, "platform.apps.list", {}, callerPreviousGeneration, "old-caller-cache");
assert.equal(Array.isArray(valueOf(await invoke(oldCallerCache))), true);
const childOpen = valueOf(await invoke(request(PROFILE, callerRemountInstance, "platform.apps.open", {
  appId: LOBBY,
  arguments: { nested: true },
}))) as JsonObject;
const abandonedChild = instanceOf(LOBBY);
const callerNextGeneration = `${callerPreviousGeneration}-remount`;
host.generations.set(callerRemountInstance, callerNextGeneration);
const callerRemountStart = host.calls.length;
let callerSurfaceChanged = false;
const stopCallerSurface = kernel.subscribe(() => { callerSurfaceChanged = true; });
const callerLaunchReplay = host.waitForCall((call) => call.capability === "system.runtime.post" &&
  call.params.event === "platform.launch" &&
  (call.params.params as JsonObject).requestId === launchId(callerRemountOpen), callerRemountStart);
sendEvent("system.runtime.generation", {
  instanceId: callerRemountInstance,
  appId: PROFILE,
  previousGeneration: callerPreviousGeneration,
  generation: callerNextGeneration,
});
await callerLaunchReplay;
assert.equal(callerSurfaceChanged, true, "generation recovery publishes the current surface binding by event");
stopCallerSurface();
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === abandonedChild);
assert.equal(host.destroyed.includes(abandonedChild), true);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
assert.equal(kernel.snapshot().pendingCalls.length, 1, "only the still-open parent call remains");
assert.equal(host.posted.some((post) => post.instanceId === callerRemountInstance &&
  post.event === "platform.result" && post.params.requestId === launchId(childOpen)), false);
assert.equal(errorCode(await invoke(oldCallerCache)), "stale_runtime");
const callerRemountReturn = await invoke(request(PROFILE, callerRemountInstance, "platform.apps.return", {
  value: { remounted: true },
}, callerNextGeneration));
assert.equal((valueOf(callerRemountReturn) as JsonObject).returned, true);
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === callerRemountInstance);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);

// ACLs are JS policy: namespaced persistence uses app identity, a private
// namespace stays app-scoped, and unauthorized shared namespaces never reach IO.
const storageProfile = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", { appId: PROFILE })));
const storageProfileInstance = instanceOf(PROFILE);
const setShared = await invoke(request(PROFILE, storageProfileInstance, "platform.storage.set", {
  key: "name", value: "Alex", namespace: "identity",
}));
assert.equal((valueOf(setShared) as JsonObject).stored, true);
const lastStorageSet = [...host.calls].reverse().find((call) => call.capability === "system.storage.set");
assert.deepEqual(lastStorageSet?.params, { appId: PROFILE, key: "name", namespace: "identity", value: "Alex" });
const storageBeforeDenied = host.calls.filter((call) => call.capability.startsWith("system.storage.")).length;
assert.equal(errorCode(await invoke(request(PROFILE, storageProfileInstance, "platform.storage.get", {
  key: "name", namespace: "secret",
}))), "shared_namespace_denied");
assert.equal(host.calls.filter((call) => call.capability.startsWith("system.storage.")).length, storageBeforeDenied);
const getShared = await invoke(request(PROFILE, storageProfileInstance, "platform.storage.get", {
  key: "name", namespace: "identity",
}));
assert.equal(valueOf(getShared), "Alex");
await invoke(request(PROFILE, storageProfileInstance, "platform.apps.return", { value: null }));
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.ok(launchId(storageProfile).length > 0);

// Mail is retained while its target is hidden, then posted only after the
// target becomes foreground. Rejected delivery retries on the next event.
const queued = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.messages.send", {
  appId: LOBBY,
  topic: "identity",
  data: { user: "Alex" },
}))) as JsonObject;
assert.equal(queued.queued, true);
assert.equal(kernel.snapshot().queuedMessages, 1);
host.rejectedPostEvents.push("platform.message");
const queuedLobby = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", { appId: LOBBY })));
const queuedLobbyInstance = instanceOf(LOBBY);
await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.list"));
const deliveredMessages = host.posted.filter((post) => post.instanceId === queuedLobbyInstance && post.event === "platform.message");
assert.equal(deliveredMessages.length, 2, "a refused foreground post is retried by a later event");
assert.equal(kernel.snapshot().queuedMessages, 0);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, LOBBY]);
await invoke(request(LOBBY, queuedLobbyInstance, "platform.apps.return", { value: null }));
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.ok(launchId(queuedLobby).length > 0);

// A failed foreground runtime becomes a cancelled result without asking the
// host to destroy a runtime it has already reported dead.
const doomedOpen = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", { appId: LOBBY })));
const doomedInstance = instanceOf(LOBBY);
const resultPostStart = host.calls.length;
const failedResultPost = host.waitForCall((call) => call.capability === "system.runtime.post" &&
  call.params.event === "platform.result" &&
  (call.params.params as JsonObject).requestId === launchId(doomedOpen), resultPostStart);
sendEvent("system.runtime.failed", { instanceId: doomedInstance, appId: LOBBY, error: { code: "crashed" } });
await failedResultPost;
await host.waitForCall((call) => call.capability === "system.runtime.destroy" && call.params.instanceId === doomedInstance);
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.deepEqual(kernel.surfaceBindings(), [], "a failed child is removed from the JS compositor bindings");
assert.equal(host.destroyed.includes(doomedInstance), true, "failed host runtimes must release their host slot");

// App residency counts the non-evictable SystemUI. LRU removes only an
// unreferenced prewarmed runtime and rejects capacity when all other slots are
// held by the foreground stack and result tokens.
await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.prewarm", { appId: PROFILE }));
await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.prewarm", { appId: LOBBY }));
const profilePrewarm = instanceOf(PROFILE);
const lobbyPrewarm = instanceOf(LOBBY);
assert.equal(kernel.snapshot().residents.find((record) => record.appId === PROFILE)?.state, "prewarmed");
const prewarmedStorage = await invoke(request(PROFILE, profilePrewarm, "platform.storage.get", {
  key: "name", namespace: "identity",
}));
assert.equal(valueOf(prewarmedStorage), "Alex", "prewarmed hidden apps may perform explicit storage I/O");
await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.prewarm", { appId: NOTES }));
assert.equal(host.destroyed.includes(lobbyPrewarm), true, "least recently used unreferenced app is evicted");
assert.equal(kernel.snapshot().residentCount, 3, "resident limit includes SystemUI");
assert.ok(kernel.snapshot().residents.some((record) => record.instanceId === "system-ui"));

// Discard residents to create a fresh full stack; no pinned or referenced app
// can be evicted to make room for a fourth resident.
const capacityProfile = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", { appId: PROFILE })));
const capacityProfileInstance = instanceOf(PROFILE);
const capacityLobby = await invoke(request(PROFILE, capacityProfileInstance, "platform.apps.open", { appId: LOBBY }));
assert.equal(errorCode(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.prewarm", { appId: NOTES }))), "resident_capacity");
assert.equal(kernel.snapshot().residentCount, 3);
assert.equal((valueOf(capacityLobby) as JsonObject).targetAppId, LOBBY);
await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.cancel", { requestId: launchId(capacityProfile) }));
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);

// The source realm remains alive until system.runtime.respond succeeds. A
// duplicate after a failed response replays the cached result, then destroys
// the source without repeating its stack mutation.
const retryOpen = valueOf(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", { appId: PROFILE })));
const retryInstance = instanceOf(PROFILE);
const retryRpc = request(PROFILE, retryInstance, "platform.apps.return", { value: { retry: true } }, undefined, "return-retry");
host.failRespondRequestId = "return-retry";
const failedResponseStart = host.calls.length;
const failedResponse = host.waitForCall((call) => call.capability === "system.runtime.respond" &&
  call.params.requestId === "return-retry", failedResponseStart);
await invoke(retryRpc);
await failedResponse;
assert.equal(host.destroyed.includes(retryInstance), false, "failed acknowledgement must leave source runtime resident");
const retryResponseStart = host.calls.length;
const retriedResponse = host.waitForCall((call) => call.capability === "system.runtime.respond" &&
  call.params.requestId === "return-retry", retryResponseStart);
const deferredDestroy = host.waitForCall((call) => call.capability === "system.runtime.destroy" &&
  call.params.instanceId === retryInstance, retryResponseStart);
await invoke(retryRpc);
await Promise.all([retriedResponse, deferredDestroy]);
const responseIndex = host.calls.findIndex((call, index) => index >= retryResponseStart &&
  call.capability === "system.runtime.respond" && call.params.requestId === "return-retry");
const destroyIndex = host.calls.findIndex((call, index) => index >= retryResponseStart &&
  call.capability === "system.runtime.destroy" && call.params.instanceId === retryInstance);
assert.ok(destroyIndex > responseIndex, "deferred source teardown follows successful response");
assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
assert.ok(launchId(retryOpen).length > 0);

// JSON values are cloned through JSON and checked against the 64 KiB budget.
assert.equal(errorCode(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.open", {
  appId: PROFILE,
  arguments: { data: "x".repeat(66 * 1024) },
}))), "payload_too_large");
assert.equal(errorCode(await invoke(request(SYSTEM_UI, "system-ui", "platform.apps.list", {}, "wrong-root-generation"))), "stale_runtime");

// Unsupported hidden execution is rejected before any host capability call.
const priorCallCount = host.calls.length;
assert.throws(() => installPocketSystem({
  ...manifest,
  applications: { ...manifest.applications, backgroundExecution: "continue" },
}, { bridge: host, policies }), /backgroundExecution=continue/);
assert.equal(host.calls.length, priorCallCount);

assert.equal(forwarded.length > 0, true, "the installed handler forwards packets to the previous event sink");
assert.equal(host.posted.some((post) => post.event === "platform.lifecycle" && "lifecycleCode" in post.params), false);
assert.equal(kernel.snapshot().mailboxLimit, 32);
assert.equal(host.ticks, 0, "kernel needs no runtime tick or polling timer");
assert.equal(host.disposed, false, "the injected bridge belongs to the caller");
kernel.dispose();
assert.equal(kernel.snapshot().disposed, true);
assert.equal(globalObject.__pocketEvent, previousEvent);
console.log("SYSTEM_KERNEL_FIXTURE_OK");
