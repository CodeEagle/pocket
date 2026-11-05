import { strict as assert } from "node:assert";
import { mock, test } from "bun:test";
import { join } from "node:path";
import type { HostBridge, HostRequestOptions, JsonObject, JsonValue } from "../src/host.ts";
import type { PocketSystemV1 } from "../src/system.ts";
mock.module("@pocketjs/framework/clock", () => ({ simulationHz: () => 60 }));
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
  disposed = false;
  private nextInstance = 1;

  request<T extends JsonValue = JsonValue>(capability: string, params: JsonObject = {}, options?: HostRequestOptions): Promise<T> {
    const call = { capability, params, options };
    this.calls.push(call);
    if (capability === "system.runtime.configure") {
      return Promise.resolve({ systemInstanceId: "system-ui" } as T);
    }
    if (capability === "system.runtime.create") {
      const appId = String(params.appId);
      const instanceId = `inst-${this.nextInstance++}`;
      const generation = `gen-${instanceId}`;
      this.generations.set(instanceId, generation);
      return Promise.resolve({ appId, instanceId, generation } as T);
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
    { appId: PROFILE, memory: { heapLimitBytes: 64 * 1024, maxPakBytes: 1 } },
    "runtime.create forwards the catalog budget request",
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
    { appId: LOBBY, memory: { heapLimitBytes: 128 * 1024 * 1024 } },
    "compatibility memory policy maps to a heap-only request",
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
