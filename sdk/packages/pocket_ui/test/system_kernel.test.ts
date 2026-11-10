import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import { join } from "node:path";
import type { HostBridge, HostRequestOptions, JsonObject, JsonValue } from "../src/host.ts";
import type { PocketSystemV1 } from "../src/system.ts";
mock.module("@pocketjs/framework/clock", () => ({
  after: (_seconds: number, _callback: () => void) => () => {},
  simulationHz: () => 60,
}));
const { installPocketSystem } = await import("../src/system.ts");

const SYSTEM_UI = "pocket.host.demo";
const PROFILE = "pocket.demo.profile";
const LOBBY = "pocket.demo.lobby";
const NOTES = "pocket.demo.notes";
const EXTRA = "pocket.demo.extra";

const manifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: "pocket.demo.system",
  roles: { systemUI: SYSTEM_UI },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: SYSTEM_UI, manifest: "pocket.json", required: true },
      {
        package: PROFILE,
        manifest: "apps/profile/pocket.json",
        required: true,
        memory: { heapLimitBytes: 64 * 1024, maxPakBytes: 1 },
      },
      {
        package: LOBBY,
        manifest: "apps/lobby/pocket.json",
        required: true,
        memoryPolicy: "UI_MINI",
      },
      { package: NOTES, manifest: "apps/notes/pocket.json", required: false },
      { package: EXTRA, manifest: "apps/extra/pocket.json", required: false },
    ],
  },
  installation: { installedPackages: [SYSTEM_UI, PROFILE, LOBBY, NOTES, EXTRA] },
};

const policies = {
  [SYSTEM_UI]: {
    allowedOpenApps: [PROFILE, LOBBY, NOTES, EXTRA],
    messageTargets: [PROFILE, LOBBY, NOTES, EXTRA],
    sharedNamespaces: ["identity"],
  },
  [PROFILE]: {
    allowedOpenApps: [SYSTEM_UI, LOBBY, NOTES],
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
  [EXTRA]: {
    allowedOpenApps: [],
    messageTargets: [],
    sharedNamespaces: [],
  },
} as const;

class TestHost implements HostBridge {
  readonly calls: Array<{ capability: string; params: JsonObject; options?: HostRequestOptions }> = [];
  readonly posted: Array<{ instanceId: string; event: string; params: JsonObject }> = [];
  readonly destroyed: string[] = [];
  readonly generations = new Map<string, string>();
  readonly appIds = new Map<string, string>();
  disposed = false;
  private nextInstance = 1;

  request<T extends JsonValue = JsonValue>(capability: string, params: JsonObject = {}, options?: HostRequestOptions): Promise<T> {
    const call = { capability, params, options };
    this.calls.push(call);
    if (capability === "system.runtime.configure") {
      return Promise.resolve({ systemInstanceId: "system-ui", generation: "gen-system-ui" } as T);
    }
    if (capability === "system.runtime.create") {
      const appId = String(params.appId);
      const instanceId = `inst-${this.nextInstance++}`;
      const generation = `gen-${instanceId}`;
      this.generations.set(instanceId, generation);
      this.appIds.set(instanceId, appId);
      return Promise.resolve({ appId, instanceId, generation, preparedForOpen: params.prepareForOpen === true } as T);
    }
    if (capability === "system.runtime.prepareOpen") {
      const instanceId = String(params.instanceId);
      return Promise.resolve({
        instanceId, appId: this.appIds.get(instanceId),
        previousGeneration: params.generation, generation: params.generation,
        configured: false, updated: false,
      } as unknown as T);
    }
    if (capability === "system.runtime.awaitFirstFrame") {
      return Promise.resolve({ ready: true, generation: params.generation } as T);
    }
    if (capability === "system.runtime.destroy") {
      this.destroyed.push(String(params.instanceId));
      return Promise.resolve(null as T);
    }
    if (capability === "system.runtime.post") {
      this.posted.push({
        instanceId: String(params.instanceId),
        event: String(params.event),
        params: (params.params as JsonObject) ?? {},
      });
      return Promise.resolve({ accepted: true } as T);
    }
    if (capability === "system.runtime.emit") {
      this.posted.push({
        instanceId: String(params.instanceId),
        event: String(params.name),
        params: (params.payload as JsonObject) ?? {},
      });
      return Promise.resolve(null as T);
    }
    if (capability === "system.runtime.respond") {
      return Promise.resolve(null as T);
    }
    return Promise.resolve(null as T);
  }

  handle(): boolean { return false; }
  tick(): void {}
  dispose(): void { this.disposed = true; }
}

const globalObject = globalThis as typeof globalThis & {
  __pocketEvent?: (packet: Record<string, unknown>) => void;
  ui?: { __surfaces?: Record<string, number> };
};
globalObject.ui = {
  __surfaces: {
    [PROFILE]: 2,
    [LOBBY]: 3,
    [NOTES]: 4,
    [EXTRA]: 5,
  },
};

function createEnv(maxResidentApps = 5) {
  const host = new TestHost();
  const kernel = installPocketSystem(manifest, {
    bridge: host,
    maxResidentApps,
    policies,
  });
  const invoke = async (req: JsonObject): Promise<JsonObject> => {
    const start = host.calls.length;
    globalObject.__pocketEvent!({ type: "event", name: "system.request", payload: req });
    for (let i = 0; i < 50; i++) {
      const resp = host.calls.slice(start).find((c) => c.capability === "system.runtime.respond");
      if (resp) return resp.params;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timeout waiting for system.runtime.respond");
  };
  return { host, kernel, invoke };
}

test("Pocket System kernel protocol runs in an isolated Bun process", () => {
  const fixture = join(import.meta.dir, "system_kernel.fixture.ts");
  const bun = Bun.which("bun") ?? process.execPath;
  const result = Bun.spawnSync({
    cmd: [bun, fixture],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  assert.equal(
    result.exitCode,
    0,
    `system kernel fixture failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  assert.match(stdout, /SYSTEM_KERNEL_FIXTURE_OK/);
});

test("memory budget requests reject invalid fields and policy mismatches", () => {
  const invalid = {
    ...manifest,
    applications: {
      ...manifest.applications,
      catalog: manifest.applications.catalog.map((entry) =>
        entry.package === PROFILE
          ? { ...entry, memory: { heapLimitBytes: 0 } }
          : entry,
      ),
    },
  } as PocketSystemV1;
  assert.throws(
    () => installPocketSystem(invalid, { bridge: new TestHost(), policies }),
    /safe integer/,
  );

  const mismatchedPolicy = {
    ...manifest,
    applications: {
      ...manifest.applications,
      catalog: manifest.applications.catalog.map((entry) =>
        entry.package === PROFILE
          ? {
              ...entry,
              memory: { heapLimitBytes: 64 * 1024, maxPakBytes: 1 },
              memoryPolicy: "UI_MINI",
            }
          : entry,
      ),
    },
  } as PocketSystemV1;
  assert.throws(
    () => installPocketSystem(mismatchedPolicy, { bridge: new TestHost(), policies }),
    /does not match/,
  );
});

test("caller cancelling its own foreground child call via system.app.cancel", async () => {
  const { host, kernel, invoke } = createEnv(5);
  await kernel.ready;

  const openProfile = await invoke({
    requestId: "req-open-profile",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(openProfile.ok, true);
  assert.equal(host.calls.find((call) => call.capability === "system.runtime.create")?.options?.timeoutFrames, 3600);
  assert.equal(host.calls.find((call) => call.capability === "system.runtime.awaitFirstFrame")?.options?.timeoutFrames, 2700);
  assert.deepEqual(
    host.calls.find((call) => call.capability === "system.runtime.create")?.params,
    {
      appId: PROFILE,
      prepareForOpen: true,
      cacheFirst: true,
      memory: { heapLimitBytes: 64 * 1024, maxPakBytes: 1 },
      initialEvents: [{
        method: "platform.presets",
        params: {
          darkMode: false,
          colorScheme: "light",
          accentColor: "blue",
          density: "auto",
          presentationStyle: "sheet",
        },
      }],
    },
    "runtime.create forwards the catalog budget request and initial presets event",
  );
  const profileInstance = kernel.snapshot().residents.find((r) => r.appId === PROFILE)!.instanceId;
  const profileGen = host.generations.get(profileInstance)!;

  const openLobby = await invoke({
    requestId: "req-open-lobby",
    sourceAppId: PROFILE,
    sourceInstanceId: profileInstance,
    sourceGeneration: profileGen,
    capability: "platform.apps.open",
    params: { appId: LOBBY },
  });
  assert.equal(openLobby.ok, true);
  assert.deepEqual(
    host.calls.find((call) => call.capability === "system.runtime.create" && call.params.appId === LOBBY)?.params,
    {
      appId: LOBBY,
      prepareForOpen: true,
      cacheFirst: true,
      memory: { heapLimitBytes: 128 * 1024 * 1024 },
      initialEvents: [{
        method: "platform.presets",
        params: {
          darkMode: false,
          colorScheme: "light",
          accentColor: "blue",
          density: "auto",
          presentationStyle: "sheet",
        },
      }],
    },
    "compatibility memory policy maps to a heap-only request with initial presets event",
  );
  const lobbyLaunchId = ((openLobby.value as JsonObject).requestId) as string;
  const lobbyInstance = kernel.snapshot().residents.find((r) => r.appId === LOBBY)!.instanceId;
  assert.deepEqual(kernel.snapshot().stack.map((f) => f.appId), [SYSTEM_UI, PROFILE, LOBBY]);

  const cancelResp = await invoke({
    requestId: "req-cancel-lobby",
    sourceAppId: PROFILE,
    sourceInstanceId: profileInstance,
    sourceGeneration: profileGen,
    capability: "platform.apps.cancel",
    params: { requestId: lobbyLaunchId },
  });
  assert.equal(cancelResp.ok, true);
  assert.equal((cancelResp.value as JsonObject).cancelled, true);

  assert.deepEqual(kernel.snapshot().stack.map((f) => f.appId), [SYSTEM_UI, PROFILE]);
  assert.ok(host.destroyed.includes(lobbyInstance));

  const resultEvent = host.posted.find(
    (p) => p.instanceId === profileInstance && (p.event === "system.app.result" || p.event === "platform.result"),
  );
  assert.ok(resultEvent, "caller should receive result event upon cancel");
  assert.equal(resultEvent.params.cancelled, true);
  assert.equal(resultEvent.params.reason, "cancelled");
});

test("includeStack retains lower app bindings while the foreground child is open", async () => {
  const { host, kernel, invoke } = createEnv(5);
  await kernel.ready;

  const profileOpened = await invoke({
    requestId: "req-stack-profile",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(profileOpened.ok, true);
  const profileInstance = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!.instanceId;
  const profileGeneration = host.generations.get(profileInstance)!;

  const lobbyOpened = await invoke({
    requestId: "req-stack-lobby",
    sourceAppId: PROFILE,
    sourceInstanceId: profileInstance,
    sourceGeneration: profileGeneration,
    capability: "platform.apps.open",
    params: { appId: LOBBY },
  });
  assert.equal(lobbyOpened.ok, true);
  const lobbyInstance = kernel.snapshot().residents.find((record) => record.appId === LOBBY)!.instanceId;

  // The legacy/default contract remains visible-only for plain consumers.
  assert.deepEqual(kernel.surfaceBindings().map((binding) => binding.appId), [LOBBY]);
  // Mini-app presentation consumers opt into the retained stack so Profile's
  // instance remains mounted and resumes with its original state after Lobby.
  assert.deepEqual(kernel.surfaceBindings({ includeStack: true }).map((binding) => binding.appId), [PROFILE, LOBBY]);
  assert.deepEqual(kernel.surfaceBindings({ includeStack: true }).map((binding) => binding.focused), [false, true]);
  assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE, LOBBY]);

  const returned = await invoke({
    requestId: "req-stack-return-lobby",
    sourceAppId: LOBBY,
    sourceInstanceId: lobbyInstance,
    sourceGeneration: host.generations.get(lobbyInstance)!,
    capability: "platform.apps.return",
    params: { value: { from: "lobby" } },
  });
  assert.equal(returned.ok, true);
  assert.deepEqual(kernel.surfaceBindings({ includeStack: true }).map((binding) => binding.appId), [PROFILE]);
  assert.equal(host.destroyed.includes(lobbyInstance), true, "return destroys only the popped foreground runtime");
  assert.equal(host.destroyed.includes(profileInstance), false, "return must preserve the lower caller runtime");
});

test("return waits for before-dismiss handlers before popping and destroys once", async () => {
  const { host, kernel, invoke } = createEnv(5);
  await kernel.ready;

  const opened = await invoke({
    requestId: "req-dismiss-return-open",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(opened.ok, true);
  const profile = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!;
  const launchId = String((opened.value as JsonObject).requestId);
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const dismissed: string[][] = [];
  const unsubscribe = kernel.onBeforeDismiss(async (instanceIds) => {
    started = true;
    dismissed.push([...instanceIds]);
    await gate;
  });

  const returning = invoke({
    requestId: "req-dismiss-return",
    sourceAppId: PROFILE,
    sourceInstanceId: profile.instanceId,
    sourceGeneration: profile.generation!,
    capability: "platform.apps.return",
    params: { value: { done: true } },
  });
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(started, true, "return should enter the dismissal barrier");
  assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
  assert.equal(host.destroyed.includes(profile.instanceId), false, "target stays resident during reverse animation");
  assert.equal(
    host.posted.filter((post) => post.event === "platform.result" && post.params.requestId === launchId).length,
    0,
  );

  release();
  const response = await returning;
  assert.equal(response.ok, true);
  assert.deepEqual(dismissed, [[profile.instanceId]]);
  for (let attempt = 0; attempt < 100 && !host.destroyed.includes(profile.instanceId); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(host.destroyed.filter((instanceId) => instanceId === profile.instanceId).length, 1);
  assert.equal(
    host.posted.filter((post) => post.event === "platform.result" && post.params.requestId === launchId).length,
    1,
  );
  unsubscribe();
  kernel.dispose();
});

test("cancel waits for one top-to-bottom dismissal barrier before unwinding nested frames", async () => {
  const { host, kernel, invoke } = createEnv(5);
  await kernel.ready;

  const profileOpened = await invoke({
    requestId: "req-dismiss-cancel-profile",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(profileOpened.ok, true);
  const profile = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!;
  const lobbyOpened = await invoke({
    requestId: "req-dismiss-cancel-lobby",
    sourceAppId: PROFILE,
    sourceInstanceId: profile.instanceId,
    sourceGeneration: profile.generation!,
    capability: "platform.apps.open",
    params: { appId: LOBBY },
  });
  assert.equal(lobbyOpened.ok, true);
  const lobby = kernel.snapshot().residents.find((record) => record.appId === LOBBY)!;
  const lobbyLaunch = String((lobbyOpened.value as JsonObject).requestId);

  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const dismissed: string[][] = [];
  const unsubscribe = kernel.onBeforeDismiss(async (instanceIds) => {
    started = true;
    dismissed.push([...instanceIds]);
    await gate;
  });

  const cancelling = invoke({
    requestId: "req-dismiss-cancel",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.cancel",
    params: { requestId: (profileOpened.value as JsonObject).requestId },
  });
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(started, true, "cancel should enter the dismissal barrier");
  assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE, LOBBY]);
  assert.equal(host.destroyed.includes(profile.instanceId), false);
  assert.equal(host.destroyed.includes(lobby.instanceId), false);

  release();
  const response = await cancelling;
  assert.equal(response.ok, true);
  assert.equal((response.value as JsonObject).cancelled, true);
  assert.deepEqual(dismissed, [[lobby.instanceId, profile.instanceId]]);
  assert.equal(host.destroyed.filter((instanceId) => instanceId === profile.instanceId).length, 1);
  assert.equal(host.destroyed.filter((instanceId) => instanceId === lobby.instanceId).length, 1);
  assert.equal(
    host.posted.filter((post) => post.event === "platform.result" && post.params.requestId === (profileOpened.value as JsonObject).requestId).length,
    1,
  );
  assert.equal(
    host.posted.filter((post) => post.event === "platform.result" && post.params.requestId === lobbyLaunch).length,
    0,
    "nested call result is not delivered to a caller that is unwound",
  );
  unsubscribe();
  kernel.dispose();
});

test("dispose releases a pending dismissal barrier without post-dispose teardown", async () => {
  const { host, kernel, invoke } = createEnv(5);
  await kernel.ready;

  const opened = await invoke({
    requestId: "req-dispose-dismiss-open",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(opened.ok, true);
  const profile = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!;
  let started = false;
  kernel.onBeforeDismiss(async () => {
    started = true;
    await new Promise<void>(() => {});
  });

  // This request is intentionally left awaiting the never-resolving visual
  // transition. The kernel itself must still release its queue on dispose.
  void invoke({
    requestId: "req-dispose-dismiss-return",
    sourceAppId: PROFILE,
    sourceInstanceId: profile.instanceId,
    sourceGeneration: profile.generation!,
    capability: "platform.apps.return",
    params: { value: null },
  });
  for (let attempt = 0; attempt < 100 && !started; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(started, true, "return should be waiting inside the dismissal hook");
  const callsAtDispose = host.calls.length;
  kernel.dispose();

  // This operation is queued behind the blocked return. If dispose did not
  // release the barrier, it would remain pending forever.
  const queueProbe = kernel.presentSurfaces([]).then(() => true);
  const queueSettled = await Promise.race([
    queueProbe,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(queueSettled, true, "dispose must release the kernel queue");
  assert.deepEqual(kernel.snapshot().stack, []);
  assert.deepEqual(kernel.snapshot().residents, []);
  assert.deepEqual(host.calls.slice(callsAtDispose), [], "dispose must prevent post-dispose host teardown or responses");
});

test("split-view non-active presented instance excluded from LRU eviction", async () => {
  const { host, kernel, invoke } = createEnv(4);
  await kernel.ready;

  const openProfile = await invoke({
    requestId: "req-open-profile-lru",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(openProfile.ok, true);
  const profileInstance = kernel.snapshot().residents.find((r) => r.appId === PROFILE)!.instanceId;

  const pwLobby = await invoke({
    requestId: "pw-lobby",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.prewarm",
    params: { appId: LOBBY },
  });
  assert.equal(pwLobby.ok, true);
  const lobbyInstance = kernel.snapshot().residents.find((r) => r.appId === LOBBY)!.instanceId;

  // Present Lobby alongside Profile in split-view (Profile is focused, Lobby is non-active)
  await kernel.presentSurfaces([PROFILE, LOBBY], PROFILE);

  const pwNotes = await invoke({
    requestId: "pw-notes",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.prewarm",
    params: { appId: NOTES },
  });
  assert.equal(pwNotes.ok, true);
  const notesInstance = kernel.snapshot().residents.find((r) => r.appId === NOTES)!.instanceId;

  // Now resident count is 4 (SystemUI, Profile, Lobby, Notes), which is maxResidentApps.
  // Prewarm Extra. One candidate must be evicted.
  // Candidate 1: Lobby (prewarmed earlier, so lastUsed is older than Notes). But Lobby is in presentedInstanceIds!
  // Candidate 2: Notes (prewarmed later, but NOT in presentedInstanceIds).
  // Without the fix, Lobby would be evicted. With the fix, Lobby is protected and Notes is evicted!
  const pwExtra = await invoke({
    requestId: "pw-extra",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.prewarm",
    params: { appId: EXTRA },
  });
  assert.equal(pwExtra.ok, true);

  assert.ok(host.destroyed.includes(notesInstance), "unpresented Notes should be evicted");
  assert.equal(host.destroyed.includes(lobbyInstance), false, "split-view presented Lobby must not be evicted");
  assert.ok(kernel.snapshot().residents.some((r) => r.appId === LOBBY));
  assert.equal(kernel.snapshot().residents.some((r) => r.appId === NOTES), false);
});

test("memory pressure reclaims unreferenced backgrounds and preserves stack, presentation, and SystemUI", async () => {
  const { host, kernel, invoke } = createEnv(5);
  await kernel.ready;

  const opened = await invoke(systemRequest("pressure-open-profile", "platform.apps.open", { appId: PROFILE }));
  assert.equal(opened.ok, true);
  const profile = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!;

  for (const [requestId, appId] of [["pressure-warm-lobby", LOBBY], ["pressure-warm-notes", NOTES], ["pressure-warm-extra", EXTRA]] as const) {
    const warmed = await invoke(systemRequest(requestId, "platform.apps.prewarm", { appId }));
    assert.equal(warmed.ok, true);
  }
  const lobby = kernel.snapshot().residents.find((record) => record.appId === LOBBY)!;
  const notes = kernel.snapshot().residents.find((record) => record.appId === NOTES)!;
  const extra = kernel.snapshot().residents.find((record) => record.appId === EXTRA)!;
  assert.ok(
    kernel.snapshot().pendingCalls.some((call) => call.targetInstanceId === profile.instanceId),
    "the active Profile runtime still has a pending launch result reference",
  );
  await kernel.presentSurfaces([PROFILE, LOBBY], PROFILE);
  const hostRequest = host.request.bind(host);
  let failNotesDestroy = true;
  host.request = async (capability, params = {}, options) => {
    if (
      capability === "system.runtime.destroy" &&
      params.instanceId === notes.instanceId &&
      failNotesDestroy
    ) {
      failNotesDestroy = false;
      throw new Error("transient destroy failure");
    }
    return await hostRequest(capability, params, options) as never;
  };

  // A stale root generation must not apply a native pressure fact to this JS realm.
  globalObject.__pocketEvent!({
    type: "event",
    name: "system.runtime.memoryPressure",
    payload: { generation: "retired-root-generation" },
  });
  await kernel.presentSurfaces([PROFILE, LOBBY], PROFILE);
  assert.deepEqual(host.destroyed, []);

  globalObject.__pocketEvent!({
    type: "event",
    name: "system.runtime.memoryPressure",
    payload: { generation: "gen-system-ui" },
  });
  // The public kernel operation shares the event queue, so it also waits for
  // every pressure eviction to finish before asserting resident state.
  await kernel.presentSurfaces([PROFILE, LOBBY], PROFILE);
  assert.deepEqual(host.destroyed, [], "failed destroy is retained for the existing closing retry lane");
  assert.equal(
    kernel.snapshot().residents.find((record) => record.instanceId === notes.instanceId)?.state,
    "closing",
  );

  globalObject.__pocketEvent!({
    type: "event",
    name: "system.runtime.memoryPressure",
    payload: { generation: "gen-system-ui" },
  });
  await kernel.presentSurfaces([PROFILE, LOBBY], PROFILE);

  assert.deepEqual(host.destroyed, [extra.instanceId, notes.instanceId]);
  assert.deepEqual(
    kernel.snapshot().residents.map((record) => record.appId).sort(),
    [SYSTEM_UI, PROFILE, LOBBY].sort(),
  );
  assert.equal(host.destroyed.includes(profile.instanceId), false, "active stack runtime stays resident");
  assert.equal(host.destroyed.includes(lobby.instanceId), false, "presented background runtime stays resident");
  assert.ok(kernel.snapshot().residents.some((record) => record.instanceId === "system-ui"), "SystemUI stays pinned");
  for (const record of [notes, extra]) {
    assert.ok(
      host.posted.some((post) => post.instanceId === record.instanceId && post.params.state === "onUnload"),
      "each evicted background receives its existing unload lifecycle event",
    );
    assert.ok(
      host.posted.some((post) => post.instanceId === record.instanceId && post.params.state === "onUnload" && post.params.reason === "memory_pressure"),
      "pressure eviction reports its reason through the existing lifecycle event",
    );
  }

  globalObject.__pocketEvent!({
    type: "event",
    name: "system.runtime.memoryPressure",
    payload: { generation: "gen-system-ui" },
  });
  await kernel.presentSurfaces([PROFILE, LOBBY], PROFILE);
  assert.deepEqual(host.destroyed, [extra.instanceId, notes.instanceId], "a repeated pressure signal does not destroy residents twice");
});

test("destroyRuntime cleaning up presentedInstanceIds", async () => {
  const { host, kernel, invoke } = createEnv(4);
  await kernel.ready;

  const openProfile = await invoke({
    requestId: "req-open-profile",
    sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui",
    sourceGeneration: "gen-system-ui",
    capability: "platform.apps.open",
    params: { appId: PROFILE },
  });
  assert.equal(openProfile.ok, true);
  const profileInstance = kernel.snapshot().residents.find((r) => r.appId === PROFILE)!.instanceId;
  const profileGen = host.generations.get(profileInstance)!;

  const openLobby = await invoke({
    requestId: "req-open-lobby",
    sourceAppId: PROFILE,
    sourceInstanceId: profileInstance,
    sourceGeneration: profileGen,
    capability: "platform.apps.open",
    params: { appId: LOBBY },
  });
  assert.equal(openLobby.ok, true);
  const lobbyInstance = kernel.snapshot().residents.find((r) => r.appId === LOBBY)!.instanceId;

  await kernel.presentSurfaces([PROFILE, LOBBY], LOBBY);
  assert.deepEqual(kernel.surfaceBindings().map((b) => b.appId), [PROFILE, LOBBY]);

  let notified = false;
  kernel.subscribe(() => { notified = true; });

  const returnLobby = await invoke({
    requestId: "req-return-lobby",
    sourceAppId: LOBBY,
    sourceInstanceId: lobbyInstance,
    sourceGeneration: host.generations.get(lobbyInstance)!,
    capability: "platform.apps.return",
    params: { value: { done: true } },
  });
  assert.equal(returnLobby.ok, true);
  assert.ok(host.destroyed.includes(lobbyInstance));

  assert.deepEqual(kernel.surfaceBindings().map((b) => b.appId), [PROFILE]);
  assert.equal(notified, true, "destroyRuntime should notify presentation subscribers");
});

function systemRequest(requestId: string, capability: string, params: JsonObject): JsonObject {
  return { requestId, capability, params, sourceAppId: SYSTEM_UI,
    sourceInstanceId: "system-ui", sourceGeneration: "gen-system-ui" };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("System transaction did not reach the expected boundary");
}

test("a cold open reports preparing and first-frame stages until its first frame settles", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  const request = host.request.bind(host);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let finishFrame!: () => void;
  const pendingFrame = new Promise<void>((resolve) => { finishFrame = resolve; });
  host.request = async (capability, params = {}, options) => {
    const value = await request(capability, params, options);
    if (capability === "system.runtime.create") await pending;
    if (capability === "system.runtime.awaitFirstFrame") await pendingFrame;
    return value as never;
  };
  const before = host.posted.length;
  const observedStages: Array<string | null> = [];
  const unsubscribe = kernel.subscribe(() => observedStages.push(kernel.snapshot().opening?.stage ?? null));
  try {
    const opening = invoke(systemRequest("cold-gate", "platform.apps.open", { appId: PROFILE }));
    await until(() => host.calls.some((call) => call.capability === "system.runtime.create"));
    assert.equal(host.calls.find((call) => call.capability === "system.runtime.create")!.params.prepareForOpen, true);
    assert.deepEqual(kernel.snapshot().opening, { appId: PROFILE, stage: "preparing" });
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    assert.equal(host.posted.slice(before).some((event) => event.params.state === "onWillDisappear"), false);
    assert.equal(host.calls.some((call) => call.capability === "system.runtime.awaitFirstFrame"), false);
    finish();
    await until(() => host.calls.some((call) => call.capability === "system.runtime.awaitFirstFrame"));
    assert.deepEqual(kernel.snapshot().opening, { appId: PROFILE, stage: "firstFrame" });
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
    finishFrame();
    assert.equal((await opening).ok, true);
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);
    assert.equal(kernel.snapshot().opening, null);
    assert.ok(observedStages.includes("preparing"), "subscribers see the pre-first-await loading fact");
    assert.ok(observedStages.includes("firstFrame"), "subscribers see the presented first-frame wait");
    assert.equal(observedStages.at(-1), null, "subscribers see opening clear after success");
  } finally { finish(); finishFrame(); unsubscribe(); kernel.dispose(); }
});

test("a prewarmed update adopts its new generation before presentation and replays init only once", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  await invoke(systemRequest("warm", "platform.apps.prewarm", { appId: PROFILE }));
  const record = kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!;
  const previousGeneration = host.generations.get(record.instanceId)!;
  const generation = previousGeneration + "-updated";
  const request = host.request.bind(host);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  host.request = async (capability, params = {}, options) => {
    const value = await request(capability, params, options);
    if (capability !== "system.runtime.prepareOpen") return value as never;
    await pending;
    host.generations.set(record.instanceId, generation);
    return { instanceId: record.instanceId, appId: PROFILE, previousGeneration,
      generation, configured: true, updated: true } as never;
  };
  const before = host.posted.length;
  try {
    const opening = invoke(systemRequest("open-warm", "platform.apps.open", { appId: PROFILE }));
    await until(() => host.calls.some((call) => call.capability === "system.runtime.prepareOpen"));
    assert.equal(host.calls.find((call) => call.capability === "system.runtime.prepareOpen")!.params.cacheFirst, true);
    assert.deepEqual(kernel.snapshot().opening, { appId: PROFILE, stage: "preparing" });
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    assert.equal(host.posted.slice(before).some((event) => event.params.state === "onWillDisappear"), false);
    globalObject.__pocketEvent!({ type: "event", name: "system.runtime.generation", payload: {
      instanceId: record.instanceId, appId: PROFILE, previousGeneration, generation,
    } });
    finish();
    assert.equal((await opening).ok, true);
    assert.equal(kernel.snapshot().opening, null);
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!.generation, generation);
    assert.equal(host.calls.filter((call) => call.capability === "system.runtime.create").length, 1);
    assert.equal(host.calls.find((call) => call.capability === "system.runtime.awaitFirstFrame")!.params.generation, generation);
    assert.equal(host.posted.slice(before).filter((event) => event.instanceId === record.instanceId &&
      event.params.state === "onInit" && event.params.generationChanged === true).length, 1);
  } finally { finish(); kernel.dispose(); }
});

test("a failed pre-entry update leaves the caller and prewarmed instance available for retry", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  await invoke(systemRequest("warm-retry", "platform.apps.prewarm", { appId: PROFILE }));
  const instanceId = kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!.instanceId;
  const request = host.request.bind(host);
  let fail = true;
  host.request = async (capability, params = {}, options) => {
    const value = await request(capability, params, options);
    if (capability === "system.runtime.prepareOpen" && fail) {
      throw Object.assign(new Error("Signature verification failed"), { code: "manifest-signature" });
    }
    if (capability === "system.runtime.prepareOpen") return { ...value as JsonObject, configured: true } as never;
    return value as never;
  };
  const before = host.posted.length;
  try {
    const failed = await invoke(systemRequest("bad-update", "platform.apps.open", { appId: PROFILE }));
    assert.equal(failed.ok, false);
    assert.equal((failed.error as JsonObject).code, "manifest-signature");
    assert.equal(kernel.snapshot().opening, null);
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    assert.equal(host.destroyed.includes(instanceId), false);
    assert.equal(kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!.prewarmed, true);
    assert.equal(host.posted.slice(before).some((event) => event.params.state === "onWillDisappear"), false);
    fail = false;
    assert.equal((await invoke(systemRequest("retry-update", "platform.apps.open", { appId: PROFILE }))).ok, true);
    assert.equal(kernel.snapshot().opening, null);
    assert.equal(host.calls.filter((call) => call.capability === "system.runtime.create").length, 1);
    assert.equal(kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!.generation, host.generations.get(instanceId));
    assert.equal(host.posted.slice(before).filter((event) => event.instanceId === instanceId && event.params.state === "onInit").length, 0);
  } finally { kernel.dispose(); }
});

test("a host that ignores cold-open package preparation cannot expose the old page", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  const request = host.request.bind(host);
  host.request = async (capability, params = {}, options) => {
    const value = await request(capability, params, options);
    if (capability === "system.runtime.create") delete (value as JsonObject).preparedForOpen;
    return value as never;
  };
  try {
    const result = await invoke(systemRequest("old-host", "platform.apps.open", { appId: PROFILE }));
    assert.equal(result.ok, false);
    assert.equal((result.error as JsonObject).code, "host_protocol_error");
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    assert.equal(host.destroyed.length, 1);
  } finally { kernel.dispose(); }
});

test("a remounted app with a failed boot lifecycle is removed before the caller disappears", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  await invoke(systemRequest("warm-boot", "platform.apps.prewarm", { appId: PROFILE }));
  const record = kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!;
  const request = host.request.bind(host);
  const before = host.posted.length;
  host.request = async (capability, params = {}, options) => {
    const value = await request(capability, params, options);
    if (capability === "system.runtime.prepareOpen") return {
      instanceId: record.instanceId, appId: PROFILE, previousGeneration: record.generation,
      generation: String(record.generation) + "-new", configured: true, updated: true,
    } as never;
    if (capability === "system.runtime.post" && (params.params as JsonObject).generationChanged) {
      throw Object.assign(new Error("new realm did not accept its lifecycle"), { code: "runtime_unavailable" });
    }
    return value as never;
  };
  try {
    const failed = await invoke(systemRequest("boot-failure", "platform.apps.open", { appId: PROFILE }));
    assert.equal(failed.ok, false);
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    assert.equal(kernel.snapshot().residents.some((entry) => entry.instanceId === record.instanceId), false);
    assert.equal(host.destroyed.includes(record.instanceId), true);
    assert.equal(host.posted.slice(before).some((event) => event.instanceId === "system-ui" &&
      event.params.state === "onWillDisappear"), false);
  } finally { kernel.dispose(); }
});

test("a queued generation boot failure retries transient teardown and permits a fresh open", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  await invoke(systemRequest("warm-event-boot", "platform.apps.prewarm", { appId: PROFILE }));
  const record = kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!;
  const request = host.request.bind(host);
  let destroyAttempts = 0;
  host.request = async (capability, params = {}, options) => {
    if (capability === "system.runtime.destroy" && params.instanceId === record.instanceId) {
      if (++destroyAttempts === 1) throw new Error("temporary transport failure");
      throw Object.assign(new Error("native already closed the failed realm"), { code: "instance_not_found" });
    }
    if (capability === "system.runtime.post" && (params.params as JsonObject).generationChanged) {
      throw new Error("replacement realm rejected boot");
    }
    return await request(capability, params, options) as never;
  };
  try {
    globalObject.__pocketEvent!({ type: "event", name: "system.runtime.generation", payload: {
      instanceId: record.instanceId, appId: PROFILE, previousGeneration: record.generation,
      generation: String(record.generation) + "-failed",
    } });
    await until(() => destroyAttempts === 1);
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    // A later request uses the existing closing-runtime retry lane.
    await invoke(systemRequest("flush-boot-cleanup", "platform.apps.list", {}));
    await until(() => !kernel.snapshot().residents.some((entry) => entry.instanceId === record.instanceId));
    assert.equal(destroyAttempts, 2);
    assert.equal((await invoke(systemRequest("open-after-boot-error", "platform.apps.open", { appId: PROFILE }))).ok, true);
    assert.notEqual(kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!.instanceId, record.instanceId);
  } finally { kernel.dispose(); }
});


test("pending boot lifecycle stays ordered when the new controller becomes ready mid-boot", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  await invoke(systemRequest("warm-order", "platform.apps.prewarm", { appId: PROFILE }));
  const record = kernel.snapshot().residents.find((entry) => entry.appId === PROFILE)!;
  const request = host.request.bind(host);
  const delivered: string[] = [];
  let pendingInit = true;
  host.request = async (capability, params = {}, options) => {
    if (capability === "system.runtime.prepareOpen") return {
      instanceId: record.instanceId, appId: PROFILE, previousGeneration: record.generation,
      generation: String(record.generation) + "-new", configured: true, updated: true,
    } as never;
    if (capability === "system.runtime.post" && params.instanceId === record.instanceId &&
        params.event === "platform.lifecycle") {
      const state = String((params.params as JsonObject).state);
      if (state === "onInit" && pendingInit) {
        pendingInit = false;
        return { accepted: false } as never;
      }
      delivered.push(state);
    }
    return await request(capability, params, options) as never;
  };
  try {
    assert.equal((await invoke(systemRequest("open-ordered", "platform.apps.open", { appId: PROFILE }))).ok, true);
    assert.deepEqual(delivered, ["onInit", "onLoad", "frozenInStack", "onWillAppear", "onDidAppear"]);
  } finally { kernel.dispose(); }
});

test("resident SystemUI receives platform.messages.send immediately while child app is foreground", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  try {
    const opened = await invoke(systemRequest("msg-open-profile", "platform.apps.open", { appId: PROFILE }));
    assert.equal(opened.ok, true);
    const profile = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!;
    const before = host.posted.length;

    const sent = await invoke({
      requestId: "msg-profile-to-system",
      sourceAppId: PROFILE,
      sourceInstanceId: profile.instanceId,
      sourceGeneration: profile.generation!,
      capability: "platform.messages.send",
      params: { appId: SYSTEM_UI, topic: "status", data: { ok: true } },
    });
    assert.equal(sent.ok, true);
    const sentValue = sent.value as JsonObject;
    assert.equal(typeof sentValue.messageId, "string");
    assert.deepEqual(sentValue, { sent: true, queued: false, messageId: sentValue.messageId });

    const messages = host.posted.slice(before).filter((post) => post.event === "platform.message");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.instanceId, "system-ui");
    assert.deepEqual(messages[0]!.params, {
      id: sentValue.messageId,
      sourceAppId: PROFILE,
      targetAppId: SYSTEM_UI,
      topic: "status",
      data: { ok: true },
    });

    const denied = await invoke({
      requestId: "msg-profile-to-unauthorized",
      sourceAppId: PROFILE,
      sourceInstanceId: profile.instanceId,
      sourceGeneration: profile.generation!,
      capability: "platform.messages.send",
      params: { appId: NOTES, topic: "status", data: { ok: false } },
    });
    assert.equal(denied.ok, false);
    assert.equal((denied.error as JsonObject).code, "message_denied");
  } finally { kernel.dispose(); }
});

test("closeContainer sends system.container.close over the existing host bridge and rejects untrusted child requests", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  let closeSupported = true;
  const baseRequest = host.request.bind(host);
  host.request = async (capability, params = {}, options) => {
    if (capability === "system.container.close") {
      host.calls.push({ capability, params, options });
      if (!closeSupported) {
        const error = new Error("Host container close is not configured") as Error & { code?: string };
        error.code = "capability_unavailable";
        throw error;
      }
      return { closed: true } as never;
    }
    return await baseRequest(capability, params, options) as never;
  };
  try {
    const result = await kernel.closeContainer();
    assert.deepEqual(result, { closed: true });
    assert.deepEqual(
      host.calls.filter((call) => call.capability === "system.container.close").map((call) => call.params),
      [{}],
    );

    closeSupported = false;
    await assert.rejects(
      () => kernel.closeContainer(),
      (error: { code?: string }) => error?.code === "capability_unavailable",
    );

    const opened = await invoke(systemRequest("close-open-profile", "platform.apps.open", { appId: PROFILE }));
    assert.equal(opened.ok, true);
    const profile = kernel.snapshot().residents.find((record) => record.appId === PROFILE)!;
    const childAttempt = await invoke({
      requestId: "child-close-container",
      sourceAppId: PROFILE,
      sourceInstanceId: profile.instanceId,
      sourceGeneration: profile.generation!,
      capability: "system.container.close",
      params: {},
    });
    assert.equal(childAttempt.ok, false);
    assert.equal((childAttempt.error as JsonObject).code, "system_context_denied");
  } finally { kernel.dispose(); }
});

test("handleBack cancels one foreground app call and resolves its pending result", async () => {
  const { host, kernel, invoke } = createEnv();
  await kernel.ready;
  try {
    assert.equal(await kernel.handleBack(), false, "SystemUI root has no app call to pop");
    const opened = await invoke(systemRequest(
      "native-back-open-profile",
      "platform.apps.open",
      { appId: PROFILE },
    ));
    assert.equal(opened.ok, true);
    const requestId = (opened.value as JsonObject).requestId as string;
    const profileInstance = kernel.snapshot().residents.find((r) => r.appId === PROFILE)!.instanceId;
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI, PROFILE]);

    assert.equal(await kernel.handleBack(), true);
    assert.deepEqual(kernel.snapshot().stack.map((frame) => frame.appId), [SYSTEM_UI]);
    assert.ok(host.destroyed.includes(profileInstance));
    const resultEvents = host.posted.filter(
      (post) => post.event === "platform.result" && post.params.requestId === requestId,
    );
    assert.equal(resultEvents.length, 1, "the caller receives one result for the cancelled app call");
    assert.equal(resultEvents[0]!.params.cancelled, true);
    assert.equal(resultEvents[0]!.params.reason, "back");
    assert.equal(await kernel.handleBack(), false, "one back request must pop at most one app call");
  } finally {
    kernel.dispose();
  }
});


test("container close remains available while SystemUI configuration is blocked", async () => {
  const host = new TestHost();
  const baseRequest = host.request.bind(host);
  let releaseConfigure!: () => void;
  const gate = new Promise<void>((resolve) => { releaseConfigure = resolve; });
  host.request = async (capability, params = {}, options) => {
    if (capability === "system.runtime.configure") await gate;
    if (capability === "system.container.close") {
      host.calls.push({ capability, params, options });
      return { closed: true } as never;
    }
    return await baseRequest(capability, params, options) as never;
  };
  const kernel = installPocketSystem(manifest, { bridge: host, policies });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      kernel.closeContainer(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("close waited for runtime configuration")), 2000);
      }),
    ]);
    assert.deepEqual(closed, { closed: true });
    assert.equal(host.calls.some((call) => call.capability === "system.runtime.configure"), false);
  } finally {
    clearTimeout(timeout);
    releaseConfigure();
    await kernel.ready;
    kernel.dispose();
  }
});
