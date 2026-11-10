import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { buildGuest } from "../../../scripts/build_guest.ts";
import { resolveSystemDocument, validateSystemDocument } from "../../../scripts/build_system.ts";
import { resolveNativeProbePath } from "../../../scripts/native_probe_path.ts";
import {
  createHostBridge,
  DEFAULT_SYSTEM_PRESETS,
  isSystemPresetsEvent,
  normalizePresentationStyle,
  parseSystemPresets,
  SYSTEM_PRESETS_EVENT,
  type BridgeObject,
  type HostBridge,
  type HostRequestOptions,
  type JsonObject,
  type JsonValue,
} from "../src/host.ts";
import type { PocketSystemV1 } from "../src/system.ts";

const sdkRoot = resolve(import.meta.dir, "../../..");
const testTimeoutMs = 120_000;

type FrameEvent = { name?: string; payload?: JsonObject };
type FrameOp = {
  type?: string;
  id?: string;
  text?: string;
  color?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  surfaceHandle?: number;
};
type Frame = { events?: FrameEvent[]; ops?: FrameOp[]; width?: number; height?: number };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

function probeEvent(name: string, payload: JsonObject): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function probeTap(x: number, y: number): JsonObject[] {
  return [
    probeEvent("input.pointer", { phase: "down", id: 0, x, y }),
    { op: "frame", deltaMs: 16 },
    probeEvent("input.pointer", { phase: "up", id: 0, x, y }),
    { op: "frame", deltaMs: 16 },
  ];
}

function runProbeCommands(probe: string, commands: JsonObject[]): Frame[] {
  const result = spawnSync(probe, {
    input: `${commands.map((cmd) => JSON.stringify(cmd)).join("\n")}\n`,
    encoding: "utf8",
    timeout: testTimeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const lines = String(result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  const responses = lines.map((line) => JSON.parse(line) as ProbeResponse);
  for (const response of responses) {
    assert.notEqual(response.ok, false, response.error);
  }
  return responses.flatMap((response) => (response.frame ? [response.frame] : []));
}

test("normalizePresentationStyle and parseSystemPresets normalize aliases, nested payloads, and ARGB accents", () => {
  assert.equal(normalizePresentationStyle("page"), "page");
  assert.equal(normalizePresentationStyle("PUSH"), "page");
  assert.equal(normalizePresentationStyle("sheet"), "sheet");
  assert.equal(normalizePresentationStyle("modal"), "sheet");
  assert.equal(normalizePresentationStyle("bottom-sheet"), "sheet");
  assert.equal(normalizePresentationStyle({ style: "push" }), "page");
  assert.equal(normalizePresentationStyle({ presentationStyle: "modal" }, "page"), "sheet");
  assert.equal(normalizePresentationStyle("unknown", "page"), "page");

  const fromLaunch = parseSystemPresets({
    presentationStyle: "page",
    presets: {
      darkMode: true,
      accentColor: 0xff7c3aed,
      density: "desktop",
      presentationStyle: "page",
    },
  });
  assert.deepEqual(fromLaunch, {
    darkMode: true,
    colorScheme: "dark",
    accentColor: "#7c3aed",
    density: "desktop",
    presentationStyle: "page",
  });

  const fromColorScheme = parseSystemPresets(
    { colorScheme: "dark", accent: "teal", defaultPresentationStyle: "push" },
    DEFAULT_SYSTEM_PRESETS,
  );
  assert.deepEqual(fromColorScheme, {
    darkMode: true,
    colorScheme: "dark",
    accentColor: "teal",
    density: "auto",
    presentationStyle: "page",
  });

  assert.equal(isSystemPresetsEvent(SYSTEM_PRESETS_EVENT, {}), true);
  assert.equal(isSystemPresetsEvent({ method: SYSTEM_PRESETS_EVENT, params: {} }), true);
  assert.equal(isSystemPresetsEvent("platform.launch", { presentationStyle: "page" }), true);
  assert.equal(isSystemPresetsEvent("platform.launch", { presets: { darkMode: true } }), true);
  assert.equal(isSystemPresetsEvent("platform.launch", { requestId: "x" }), false);
  assert.equal(isSystemPresetsEvent("display.viewport", { width: 390 }), false);

  // HostBridge caches latestSystemPresets from both platform.presets and platform.launch
  const bridge = createHostBridge(() => true);
  assert.equal(bridge.getLatestSystemPresets?.(), undefined);
  bridge.handle({
    type: "event",
    name: "platform.launch",
    payload: {
      requestId: "launch-1",
      presentationStyle: "page",
      presets: { darkMode: true, accentColor: "rose", density: "touch", presentationStyle: "page" },
    },
  });
  assert.deepEqual(bridge.getLatestSystemPresets?.()?.presets, {
    darkMode: true,
    colorScheme: "dark",
    accentColor: "rose",
    density: "touch",
    presentationStyle: "page",
  });
  bridge.handle({
    type: "event",
    name: SYSTEM_PRESETS_EVENT,
    payload: { darkMode: false, accentColor: "violet" },
  });
  assert.deepEqual(bridge.getLatestSystemPresets?.()?.presets, {
    darkMode: false,
    colorScheme: "light",
    accentColor: "violet",
    density: "touch",
    presentationStyle: "page",
  });
  bridge.dispose();
});

test("PocketSystemKernel presets sync, pre-first-frame delivery, and 4-tier presentationStyle priority run in isolated Bun", () => {
  const testRoot = mkdtempSync(join(tmpdir(), "pocket-ui-presets-kernel-"));
  const nodeModulesRoot = join(testRoot, "node_modules");
  const solidPackageRoot = join(nodeModulesRoot, "solid-js");
  const solidRuntimePath = join(sdkRoot, ".cache/pocketjs/node_modules/solid-js/dist/solid.js");
  const isolatedSourceRoot = join(testRoot, "src");
  const runnerPath = join(testRoot, "runner.ts");

  mkdirSync(solidPackageRoot, { recursive: true });
  mkdirSync(isolatedSourceRoot, { recursive: true });
  writeFileSync(join(solidPackageRoot, "package.json"), JSON.stringify({
    name: "solid-js",
    version: "1.9.14-test",
    type: "module",
    exports: { ".": "./solid.js" },
  }));
  writeFileSync(join(solidPackageRoot, "solid.js"), `export * from ${JSON.stringify(solidRuntimePath)};\n`);
  for (const fileName of ["host.ts", "responsive.ts", "display.ts", "media.ts", "platform.ts", "system.ts", "system-memory.ts", "value_snapshot.ts"]) {
    writeFileSync(join(isolatedSourceRoot, fileName), readFileSync(join(sdkRoot, "packages/pocket_ui/src", fileName)));
  }

  writeFileSync(runnerPath, `
import { strict as assert } from "node:assert";
import { mock } from "bun:test";

mock.module("@pocketjs/framework/clock", () => ({
  after: (_seconds: number, _callback: () => void) => () => {},
  simulationHz: () => 60,
  virtualNow: () => 0,
}));

const { createRoot } = await import("solid-js");
const { createHostBridge, SYSTEM_PRESETS_EVENT } = await import(${JSON.stringify(join(isolatedSourceRoot, "host.ts"))});
const { createSystemPresets } = await import(${JSON.stringify(join(isolatedSourceRoot, "display.ts"))});
const { createPocketPlatformClient } = await import(${JSON.stringify(join(isolatedSourceRoot, "platform.ts"))});
const { installPocketSystem } = await import(${JSON.stringify(join(isolatedSourceRoot, "system.ts"))});

const SYSTEM_UI = "pocket.host.demo";
const PROFILE = "pocket.demo.profile";
const LOBBY = "pocket.demo.lobby";
const NOTES = "pocket.demo.notes";

const manifest = {
  pocketSystem: 1 as const,
  id: "pocket.test.system",
  roles: { systemUI: SYSTEM_UI },
  applications: {
    backgroundExecution: "suspend" as const,
    presentation: { style: "sheet" },
    catalog: [
      { package: SYSTEM_UI, manifest: "pocket.json", required: true },
      // Profile has per-app presentation.style = "page"
      { package: PROFILE, manifest: "apps/profile/pocket.json", required: true, presentation: { style: "page" } },
      // Lobby has no per-app presentation.style -> inherits global presets
      { package: LOBBY, manifest: "apps/lobby/pocket.json", required: true },
      { package: NOTES, manifest: "apps/notes/pocket.json", required: false },
    ],
  },
  installation: { installedPackages: [SYSTEM_UI, PROFILE, LOBBY, NOTES] },
};

const policies = {
  [SYSTEM_UI]: { allowedOpenApps: [PROFILE, LOBBY, NOTES], messageTargets: [], sharedNamespaces: [] },
  [PROFILE]: { allowedOpenApps: [LOBBY], messageTargets: [], sharedNamespaces: [] },
  [LOBBY]: { allowedOpenApps: [], messageTargets: [], sharedNamespaces: [] },
  [NOTES]: { allowedOpenApps: [], messageTargets: [], sharedNamespaces: [] },
};

const globalObj = globalThis as typeof globalThis & {
  __pocketEvent?: (packet: Record<string, unknown>) => void;
  ui?: { __surfaces?: Record<string, number> };
};
globalObj.ui = { __surfaces: { [PROFILE]: 2, [LOBBY]: 3, [NOTES]: 4 } };

const calls: Array<{ capability: string; params: Record<string, unknown> }> = [];
const posted: Array<{ instanceId: string; event: string; params: Record<string, unknown>; beforeFirstFrame: boolean; accepted: boolean }> = [];
const firstFrameCompleted = new Set<string>(["system-ui"]);
const generations = new Map<string, string>();
const appIds = new Map<string, string>();
const childBridges = new Map<string, ReturnType<typeof createHostBridge>>();
const firstFrameSnapshots = new Map<string, unknown>();
let nextInst = 1;

const deliverInitialEvents = (instanceId: string, rawEvents: unknown): void => {
  if (!Array.isArray(rawEvents)) return;
  const bridge = childBridges.get(instanceId);
  if (!bridge) return;
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const method = typeof entry.method === "string" ? entry.method : "";
    const payload = (entry.params as Record<string, unknown>) ?? {};
    if (method) bridge.handle({ type: "event", name: method, payload });
  }
};

const host = {
  request(capability: string, params: Record<string, unknown> = {}) {
    calls.push({ capability, params });
    if (capability === "system.runtime.configure") {
      return Promise.resolve({ systemInstanceId: "system-ui", generation: "gen-sys" });
    }
    if (capability === "system.runtime.create") {
      const appId = String(params.appId);
      const instanceId = "inst-" + (nextInst++);
      const generation = "gen-" + instanceId;
      generations.set(instanceId, generation);
      appIds.set(instanceId, appId);
      childBridges.set(instanceId, createHostBridge(() => true));
      deliverInitialEvents(instanceId, params.initialEvents);
      return Promise.resolve({ appId, instanceId, generation, preparedForOpen: params.prepareForOpen === true });
    }
    if (capability === "system.runtime.prepareOpen") {
      const instanceId = String(params.instanceId);
      deliverInitialEvents(instanceId, params.initialEvents);
      return Promise.resolve({
        instanceId,
        appId: appIds.get(instanceId),
        previousGeneration: params.generation,
        generation: params.generation,
        configured: false,
        updated: false,
      });
    }
    if (capability === "system.runtime.awaitFirstFrame") {
      const instanceId = String(params.instanceId);
      firstFrameSnapshots.set(instanceId, childBridges.get(instanceId)?.getLatestSystemPresets?.()?.presets);
      firstFrameCompleted.add(instanceId);
      return Promise.resolve({ ready: true, generation: params.generation });
    }
    if (capability === "system.runtime.post") {
      const instanceId = String(params.instanceId);
      const eventName = String(params.event);
      const eventParams = (params.params as Record<string, unknown>) ?? {};
      const ready = firstFrameCompleted.has(instanceId);
      posted.push({
        instanceId,
        event: eventName,
        params: eventParams,
        beforeFirstFrame: !ready,
        accepted: ready,
      });
      if (!ready) {
        return Promise.resolve({ accepted: false });
      }
      childBridges.get(instanceId)?.handle({ type: "event", name: eventName, payload: eventParams });
      return Promise.resolve({ accepted: true });
    }
    if (capability === "system.runtime.destroy") {
      childBridges.get(String(params.instanceId))?.dispose();
      childBridges.delete(String(params.instanceId));
      return Promise.resolve(null);
    }
    if (capability === "system.runtime.respond") {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  },
  handle() { return false; },
  tick() {},
  dispose() {},
};

const kernel = installPocketSystem(manifest, {
  bridge: host as any,
  maxResidentApps: 5,
  policies,
  presets: {
    darkMode: true,
    accentColor: "violet",
    density: "desktop",
    presentationStyle: "sheet",
  },
});
await kernel.ready;

const invoke = async (req: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const start = calls.length;
  globalObj.__pocketEvent!({ type: "event", name: "system.request", payload: req });
  for (let i = 0; i < 60; i++) {
    const resp = calls.slice(start).find((c) => c.capability === "system.runtime.respond");
    if (resp) return resp.params;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for system.runtime.respond");
};

// 1. Initial global presets check
assert.deepEqual(kernel.presets(), {
  darkMode: true,
  colorScheme: "dark",
  accentColor: "violet",
  density: "desktop",
  presentationStyle: "sheet",
});

// 2. Open PROFILE without launch override -> per-app pocket.json/catalog "page" beats global "sheet"!
// Before awaitFirstFrame, system.runtime.post returns { accepted: false }, and flushLifecycle retries platform.presets BEFORE onInit / platform.launch!
const openProfile = await invoke({
  requestId: "req-1",
  sourceAppId: SYSTEM_UI,
  sourceInstanceId: "system-ui",
  sourceGeneration: "gen-sys",
  capability: "platform.apps.open",
  params: { appId: PROFILE, arguments: { test: 1 } },
});
assert.equal(openProfile.ok, true);
const profileInst = String((openProfile.value as any).targetInstanceId);
const profileCreateCall = calls.find((c) => c.capability === "system.runtime.create" && c.params.appId === PROFILE);
assert.deepEqual(profileCreateCall?.params.initialEvents, [{
  method: SYSTEM_PRESETS_EVENT,
  params: {
    darkMode: true,
    colorScheme: "dark",
    accentColor: "violet",
    density: "desktop",
    presentationStyle: "page",
  },
}], "system.runtime.create carries initialEvents with per-app resolved presets");
assert.deepEqual(firstFrameSnapshots.get(profileInst), {
  darkMode: true,
  colorScheme: "dark",
  accentColor: "violet",
  density: "desktop",
  presentationStyle: "page",
}, "child bridge already has resolved presets BEFORE awaitFirstFrame completes");
const profilePosts = posted.filter((p) => p.instanceId === profileInst);
assert.equal(profilePosts[0]?.event, SYSTEM_PRESETS_EVENT);
assert.equal(profilePosts[0]?.beforeFirstFrame, true, "kernel attempts platform.presets before awaitFirstFrame");
assert.equal(profilePosts[0]?.accepted, false, "host rejects post before awaitFirstFrame");

const acceptedProfilePosts = profilePosts.filter((p) => p.accepted);
assert.equal(acceptedProfilePosts[0]?.event, SYSTEM_PRESETS_EVENT, "retried platform.presets must be the first accepted post after awaitFirstFrame, before onInit and platform.launch");
assert.deepEqual(acceptedProfilePosts[0]?.params, {
  darkMode: true,
  colorScheme: "dark",
  accentColor: "violet",
  density: "desktop",
  presentationStyle: "page",
});
assert.equal(acceptedProfilePosts[1]?.event, "platform.lifecycle");
assert.equal((acceptedProfilePosts[1]?.params as any)?.state, "onInit");
const launchIdx = acceptedProfilePosts.findIndex((p) => p.event === "platform.launch");
assert.ok(launchIdx > 0, "platform.launch must be delivered after retried platform.presets");
assert.equal(acceptedProfilePosts[launchIdx]?.params.presentationStyle, "page");
assert.equal(kernel.surfaceBindings()[0]?.presentationStyle, "page");
assert.equal(kernel.snapshot().residents.find((r) => r.appId === PROFILE)?.presentationStyle, "page");

// Verify guest createSystemPresets inside Profile child bridge (including pre-mount read + onChange)
const profileBridge = childBridges.get(profileInst)!;
let disposeProfileRoot!: () => void;
let profilePresetsSignal!: () => any;
const onChangeObserved: any[] = [];
createRoot((dispose) => {
  disposeProfileRoot = dispose;
  profilePresetsSignal = createSystemPresets({
    bridge: profileBridge,
    onChange: (next) => onChangeObserved.push(next),
  });
  // Emit an update BEFORE onMount runs and read signal mid-render (Finding #6 regression check)
  profileBridge.handle({
    type: "event",
    name: SYSTEM_PRESETS_EVENT,
    payload: { darkMode: true, accentColor: "violet", density: "desktop", presentationStyle: "page" },
  });
  assert.equal(profilePresetsSignal().presentationStyle, "page");
});
await new Promise((r) => setTimeout(r, 0));
assert.equal(onChangeObserved.length, 1, "onMount must still invoke options.onChange after pre-mount read");
assert.deepEqual(profilePresetsSignal(), {
  darkMode: true,
  colorScheme: "dark",
  accentColor: "violet",
  density: "desktop",
  presentationStyle: "page",
});

// Verify ablated platform.presets.get is rejected as capability_unavailable (Finding #2)
const getProfilePresets = await invoke({
  requestId: "req-get-presets-profile",
  sourceAppId: PROFILE,
  sourceInstanceId: profileInst,
  sourceGeneration: generations.get(profileInst)!,
  capability: "platform.presets.get",
  params: {},
});
assert.equal(getProfilePresets.ok, false);
assert.equal((getProfilePresets.error as any)?.code, "capability_unavailable");

// 3. Open nested LOBBY from PROFILE without override -> Lobby inherits global "sheet"
const openLobby = await invoke({
  requestId: "req-2",
  sourceAppId: PROFILE,
  sourceInstanceId: profileInst,
  sourceGeneration: generations.get(profileInst)!,
  capability: "platform.apps.open",
  params: { appId: LOBBY },
});
assert.equal(openLobby.ok, true);
const lobbyInst = String((openLobby.value as any).targetInstanceId);
let disposeLobbyRoot!: () => void;
let lobbyPresetsSignal!: () => any;
const lobbyPlatform = createPocketPlatformClient(() => true, { bridge: childBridges.get(lobbyInst)!, media: false });
const lobbyObservedPresets: any[] = [];
lobbyPlatform.onPresets((next) => lobbyObservedPresets.push(next));
createRoot((dispose) => {
  disposeLobbyRoot = dispose;
  lobbyPresetsSignal = createSystemPresets({ bridge: childBridges.get(lobbyInst)! });
});
await new Promise((r) => setTimeout(r, 0));
assert.equal(lobbyPresetsSignal().presentationStyle, "sheet", "Lobby without catalog override inherits global sheet");
assert.deepEqual(
  kernel.surfaceBindings({ includeStack: true }).map((b) => ({ appId: b.appId, style: b.presentationStyle })),
  [
    { appId: PROFILE, style: "page" },
    { appId: LOBBY, style: "sheet" },
  ],
);

// 4. Live global setPresets updates Lobby to "page" + light + teal, while Profile keeps "page"!
const postCountBeforeSetPresets = posted.length;
await kernel.setPresets({
  darkMode: false,
  accentColor: "teal",
  density: "touch",
  presentationStyle: "page",
});
await new Promise((r) => setTimeout(r, 0));
const postCountAfterChanged = posted.length;
assert.ok(postCountAfterChanged > postCountBeforeSetPresets);
// Redundant setPresets with identical values must NOT broadcast again (Finding #5)
await kernel.setPresets({
  darkMode: false,
  accentColor: "teal",
  density: "touch",
  presentationStyle: "page",
});
await new Promise((r) => setTimeout(r, 0));
assert.equal(posted.length, postCountAfterChanged, "unchanged setPresets must not re-broadcast when no runtime has presetsPending");

assert.deepEqual(lobbyPresetsSignal(), {
  darkMode: false,
  colorScheme: "light",
  accentColor: "teal",
  density: "touch",
  presentationStyle: "page",
});
assert.equal(lobbyPlatform.presets().presentationStyle, "page");
assert.equal(lobbyObservedPresets.at(-1)?.accentColor, "teal");
assert.deepEqual(profilePresetsSignal(), {
  darkMode: false,
  colorScheme: "light",
  accentColor: "teal",
  density: "touch",
  presentationStyle: "page",
});

// Flip global back to "sheet": Profile MUST stay "page", Lobby MUST flip back to "sheet"!
await kernel.setPresets({ presentationStyle: "sheet" });
await new Promise((r) => setTimeout(r, 0));
assert.equal(profilePresetsSignal().presentationStyle, "page", "Profile catalog style overrides global sheet");
assert.equal(lobbyPresetsSignal().presentationStyle, "sheet", "Lobby follows global sheet");

// Return Lobby and Profile so we can test launchOptions override
await invoke({
  requestId: "req-ret-lobby",
  sourceAppId: LOBBY,
  sourceInstanceId: lobbyInst,
  sourceGeneration: generations.get(lobbyInst)!,
  capability: "platform.apps.return",
  params: { value: { ok: true } },
});
await invoke({
  requestId: "req-ret-profile",
  sourceAppId: PROFILE,
  sourceInstanceId: profileInst,
  sourceGeneration: generations.get(profileInst)!,
  capability: "platform.apps.return",
  params: { value: { ok: true } },
});
disposeLobbyRoot();
// Verify disposed PocketPlatformClient guards onPresets and presets() (Finding #7)
lobbyPlatform.dispose();
const countAfterDispose = lobbyObservedPresets.length;
const unsubAfterDispose = lobbyPlatform.onPresets((next) => lobbyObservedPresets.push(next));
unsubAfterDispose();
childBridges.get(lobbyInst)?.handle({
  type: "event",
  name: SYSTEM_PRESETS_EVENT,
  payload: { darkMode: true, accentColor: "amber", presentationStyle: "page" },
});
assert.equal(lobbyObservedPresets.length, countAfterDispose, "disposed platform client must not register or invoke onPresets");
assert.equal(lobbyPlatform.presets().accentColor, "teal", "disposed platform client returns its last snapshot without reading shared bridge");
disposeProfileRoot();

// 5. Launch override priority (launchOptions.presentationStyle > per-app pocket.json > global > "sheet")
// Force Profile (catalog "page") to open as "sheet"!
const openProfileForcedSheet = await invoke({
  requestId: "req-3",
  sourceAppId: SYSTEM_UI,
  sourceInstanceId: "system-ui",
  sourceGeneration: "gen-sys",
  capability: "platform.apps.open",
  params: { appId: PROFILE, presentationStyle: "sheet" },
});
assert.equal(openProfileForcedSheet.ok, true);
assert.equal(kernel.surfaceBindings()[0]?.presentationStyle, "sheet", "launchOptions.presentationStyle overrides catalog page");
const forcedProfileInst = String((openProfileForcedSheet.value as any).targetInstanceId);
const forcedProfileCreateCall = calls.filter((c) => c.capability === "system.runtime.create" && c.params.appId === PROFILE).at(-1);
assert.deepEqual(forcedProfileCreateCall?.params.initialEvents, [{
  method: SYSTEM_PRESETS_EVENT,
  params: {
    darkMode: false,
    colorScheme: "light",
    accentColor: "teal",
    density: "touch",
    presentationStyle: "sheet",
  },
}], "launchOptions.presentationStyle override is included on system.runtime.create initialEvents");
assert.equal((firstFrameSnapshots.get(forcedProfileInst) as any)?.presentationStyle, "sheet");
await invoke({
  requestId: "req-ret-forced-profile",
  sourceAppId: PROFILE,
  sourceInstanceId: forcedProfileInst,
  sourceGeneration: generations.get(forcedProfileInst)!,
  capability: "platform.apps.return",
  params: { value: null },
});

// 6. Prewarm NOTES (while !firstFrameReady -> accepted:false -> presetsPending=true),
// then when NOTES becomes ready or opens with "push" (-> "page"), presets arrive!
const prewarmNotes = await invoke({
  requestId: "req-prewarm-notes",
  sourceAppId: SYSTEM_UI,
  sourceInstanceId: "system-ui",
  sourceGeneration: "gen-sys",
  capability: "platform.apps.prewarm",
  params: { appId: NOTES },
});
assert.equal(prewarmNotes.ok, true);
const notesPrewarmInst = String((prewarmNotes.value as any).instanceId);
assert.ok(
  posted.some((p) => p.instanceId === notesPrewarmInst && p.event === SYSTEM_PRESETS_EVENT && !p.accepted),
  "prewarmApp attempts platform.presets and marks presetsPending when host returns accepted:false",
);
// Simulate background prewarmed runtime completing its first frame, then flush via unchanged setPresets
firstFrameCompleted.add(notesPrewarmInst);
await kernel.setPresets({ presentationStyle: "sheet" });
await new Promise((r) => setTimeout(r, 0));
assert.ok(
  posted.some((p) => p.instanceId === notesPrewarmInst && p.event === SYSTEM_PRESETS_EVENT && p.accepted),
  "presetsPending runtime receives platform.presets retry even when setPresets values did not change",
);

const openNotesPush = await invoke({
  requestId: "req-open-notes-push",
  sourceAppId: SYSTEM_UI,
  sourceInstanceId: "system-ui",
  sourceGeneration: "gen-sys",
  capability: "platform.apps.open",
  params: { appId: NOTES, presentationStyle: "push" },
});
assert.equal(openNotesPush.ok, true);
assert.equal(kernel.surfaceBindings()[0]?.presentationStyle, "page", "push normalizes to page on prewarmed open");
const notesPrepareOpenCall = calls.filter((c) => c.capability === "system.runtime.prepareOpen" && c.params.instanceId === notesPrewarmInst).at(-1);
assert.deepEqual(notesPrepareOpenCall?.params.initialEvents, [{
  method: SYSTEM_PRESETS_EVENT,
  params: {
    darkMode: false,
    colorScheme: "light",
    accentColor: "teal",
    density: "touch",
    presentationStyle: "page",
  },
}], "system.runtime.prepareOpen carries updated initialEvents for prewarmed runtime");
await invoke({
  requestId: "req-ret-notes-1",
  sourceAppId: NOTES,
  sourceInstanceId: notesPrewarmInst,
  sourceGeneration: generations.get(notesPrewarmInst)!,
  capability: "platform.apps.return",
  params: { value: null },
});

const openNotesDefault = await invoke({
  requestId: "req-open-notes-default",
  sourceAppId: SYSTEM_UI,
  sourceInstanceId: "system-ui",
  sourceGeneration: "gen-sys",
  capability: "platform.apps.open",
  params: { appId: NOTES },
});
assert.equal(openNotesDefault.ok, true);
assert.equal(kernel.surfaceBindings()[0]?.presentationStyle, "sheet", "subsequent open without override reverts to global sheet");

// 7. Disposed kernel setPresets / presets() check (Finding #8)
kernel.dispose();
const postsBeforeDisposedSet = posted.length;
await kernel.setPresets({ darkMode: true, accentColor: "rose", presentationStyle: "page" });
assert.equal(posted.length, postsBeforeDisposedSet, "disposed kernel setPresets must be a no-op");
assert.equal(kernel.presets().presentationStyle, "sheet", "disposed kernel retains final presets snapshot");
console.log("PRESETS_KERNEL_OK");
`);

  try {
    const result = spawnSync("bun", [runnerPath], {
      cwd: resolve(sdkRoot, ".."),
      env: { ...process.env, NODE_PATH: nodeModulesRoot },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PRESETS_KERNEL_OK/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}, testTimeoutMs);

test("validateSystemDocument preserves per-app pocket.json presentation.style and rejects invalid styles", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-system-presentation-validate-"));
  try {
    mkdirSync(join(root, "apps/profile"), { recursive: true });
    mkdirSync(join(root, "apps/lobby"), { recursive: true });
    const baseManifest = (id: string, output: string, presentation?: Record<string, unknown>, capabilities: string[] = ["text.glyphs.baked"]) => ({
      $schema: "https://pocketjs.dev/schema/pocket-2.json",
      pocket: 2,
      id,
      name: id.replace(/\./g, "-"),
      title: id,
      version: "0.1.0",
      engine: { capabilities: { requires: capabilities, enhances: [] } },
      app: {
        entry: "app.tsx",
        output,
        framework: "solid",
        ...(presentation ? { presentation } : {}),
        viewport: { fixed: { logical: [360, 640], presentation: "native" } },
      },
    });
    writeFileSync(join(root, "pocket.json"), JSON.stringify(baseManifest("app.root", "root-app", undefined, ["text.glyphs.baked", "ui.compositor-surfaces"])));
    writeFileSync(join(root, "apps/profile/pocket.json"), JSON.stringify(baseManifest("app.profile", "profile-app", { style: "  PAGE " })));
    writeFileSync(join(root, "apps/lobby/pocket.json"), JSON.stringify(baseManifest("app.lobby", "lobby-app")));

    const systemDoc = {
      $schema: "https://pocketjs.dev/schema/pocket-system-1.json",
      pocketSystem: 1,
      id: "app.system",
      name: "app-system",
      title: "App System",
      version: "0.1.0",
      roles: { systemUI: "app.root" },
      applications: {
        installPolicy: { model: "managed", mutable: false },
        backgroundExecution: "suspend",
        presentation: { style: "sheet" },
        catalog: [
          { package: "app.root", manifest: "pocket.json", required: true },
          { package: "app.profile", manifest: "apps/profile/pocket.json", required: true },
          { package: "app.lobby", manifest: "apps/lobby/pocket.json", required: true },
        ],
      },
      installation: { installedPackages: ["app.root", "app.profile", "app.lobby"] },
    };

    const valid = await validateSystemDocument(systemDoc, { appRoot: root });
    assert.equal(valid.ok, true, valid.ok ? "" : JSON.stringify(valid.diagnostics));
    if (!valid.ok) throw new Error("unexpected validation failure");
    assert.deepEqual(valid.value.contract.applications.presentation, { style: "sheet" });
    const profileEntry = valid.value.contract.applications.catalog.find((e) => e.package === "app.profile");
    const lobbyEntry = valid.value.contract.applications.catalog.find((e) => e.package === "app.lobby");
    assert.deepEqual(profileEntry?.presentation, { style: "page" });
    assert.equal(lobbyEntry?.presentation, undefined);

    const resolved = await resolveSystemDocument(systemDoc, { appRoot: root, target: "pocket-flutter" });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.deepEqual(resolved.plan.presentation, { style: "sheet" });
      assert.deepEqual(
        resolved.plan.applications.find((a) => a.package === "app.profile")?.presentation,
        { style: "page" },
      );
    }

    const invalidDoc = {
      ...systemDoc,
      applications: {
        ...systemDoc.applications,
        presentation: { style: "diagonal-flip" },
      },
    };
    const invalid = await validateSystemDocument(invalidDoc, { appRoot: root });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.ok(invalid.diagnostics.some((d) => d.code === "system.invalidPresentationStyle"));
    }

    writeFileSync(join(root, "apps/lobby/pocket.json"), JSON.stringify(baseManifest("app.lobby", "lobby-app", { presentationStyle: "page" })));
    const unknownField = await validateSystemDocument(systemDoc, { appRoot: root });
    assert.equal(unknownField.ok, false);
    if (!unknownField.ok) {
      assert.ok(unknownField.diagnostics.some((d) => d.code === "system.invalidPresentation"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, testTimeoutMs);

test("native SystemAppSurfaces, SafeAreaScaffold, and NovelView execute sheet vs page transitions, 1px admission, dismiss animation, hitboxes, occlusion alignment, and preset reserves", async () => {
  const probe = resolveNativeProbePath(sdkRoot);
  assert.ok(existsSync(probe), "a bytecode-capable pocket_probe is required");

  const hostProject = mkdtempSync(join(tmpdir(), "pocket-ui-surface-modes-native-"));
  const guestProject = mkdtempSync(join(tmpdir(), "pocket-ui-guest-presets-native-"));
  const vnProject = mkdtempSync(join(tmpdir(), "pocket-vn-presets-native-"));
  try {
    // Part A: Host SystemAppSurfaces in "sheet" (translateY + top-right close) vs "page" (ready:false 1px admission + translateX entry + top-left back + left-to-right onBeforeDismiss exit)
    writeFileSync(join(hostProject, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.ui.surface-modes-native",
      app: {
        entry: "app.tsx",
        framework: "solid",
        viewport: { fixed: { logical: [390, 844], presentation: "native" } },
      },
    }));
    writeFileSync(join(hostProject, "manifest.json"), JSON.stringify({
      capabilities: { requires: ["ui.compositor-surfaces"] },
    }));
    writeFileSync(join(hostProject, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { subscribeHostEvents, DEFAULT_SYSTEM_PRESETS, type MiniAppPresentationStyle } from "@pocket/ui/display";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";

const pocketGlobal = globalThis as typeof globalThis & { pocket?: { _emitValue?: (packet: Record<string, unknown>) => boolean } };
const [mode, setMode] = createSignal<MiniAppPresentationStyle>("sheet");
const [ready, setReady] = createSignal(true);
const [instanceSeq, setInstanceSeq] = createSignal(1);
const listeners = new Set<() => void>();
const beforeDismissHandlers = new Set<(ids: readonly string[]) => Promise<void>>();

subscribeHostEvents((event) => {
  if (event.method === "fixture.mode") {
    const nextMode = event.params.style === "page" ? "page" : "sheet";
    const nextReady = event.params.ready !== false;
    setMode(nextMode);
    setReady(nextReady);
    setInstanceSeq((n) => n + 1);
    for (const listener of listeners) listener();
  } else if (event.method === "fixture.ready") {
    setReady(event.params.ready !== false);
    for (const listener of listeners) listener();
  }
});

const system = {
  surfaceBindings: () => [{
    appId: "app.child",
    instanceId: "child-" + instanceSeq(),
    surfaceHandle: 2,
    focused: true,
    presentationStyle: mode(),
    ready: ready(),
  }],
  presets: () => ({ ...DEFAULT_SYSTEM_PRESETS, presentationStyle: mode() }),
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onBeforeDismiss: (handler: (ids: readonly string[]) => Promise<void>) => {
    beforeDismissHandlers.add(handler);
    return () => beforeDismissHandlers.delete(handler);
  },
};

mount(() => (
  <SystemAppSurfaces
    presentation="mini-app"
    system={system}
    onClose={async (binding) => {
      pocketGlobal.pocket?._emitValue?.({
        type: "event",
        name: "fixture.closed",
        payload: { instanceId: binding.instanceId, style: binding.presentationStyle ?? "sheet" },
      });
      for (const handler of [...beforeDismissHandlers]) {
        await handler([binding.instanceId]);
      }
      pocketGlobal.pocket?._emitValue?.({
        type: "event",
        name: "fixture.dismissed",
        payload: { instanceId: binding.instanceId, style: binding.presentationStyle ?? "sheet" },
      });
    }}
  />
));
`);

    const hostBuild = await buildGuest({ projectRoot: hostProject, outDir: join(hostProject, "out") });
    const hostFrames = runProbeCommands(probe, [
      { op: "create", width: 390, height: 844, compositorSurfaces: { "app.child": 2 } },
      { op: "loadBytecode", bytecodePath: hostBuild.bytecode, pakPath: hostBuild.pak },
      // Frames 0..31: sheet entry + settle
      ...Array.from({ length: 32 }, () => ({ op: "frame", deltaMs: 16 })),
      // Frames 32..33: tap(30, 30) inert in sheet mode; Frames 34..35: tap(360, 30) triggers mini-app-close + starts sheet dismiss
      ...probeTap(30, 30),
      ...probeTap(360, 30),
      // Frames 36..61: finish sheet dismiss (26 frames)
      ...Array.from({ length: 26 }, () => ({ op: "frame", deltaMs: 16 })),
      // Switch to page mode with ready: false -> 1px admission at x = width - 1 = 389 (Frames 62..63)
      probeEvent("fixture.mode", { style: "page", ready: false }),
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      // Flip ready: true -> page entry animates horizontally from right (Frames 64..95)
      probeEvent("fixture.ready", { ready: true }),
      ...Array.from({ length: 32 }, () => ({ op: "frame", deltaMs: 16 })),
      // Frames 96..97: tap(360, 30) inert in page mode; Frames 98..99: tap(30, 30) triggers mini-app-back + starts page dismiss
      ...probeTap(360, 30),
      ...probeTap(30, 30),
      // Frames 100..125: page dismiss animation (translateX: 0 -> 389 left-to-right pop)
      ...Array.from({ length: 26 }, () => ({ op: "frame", deltaMs: 16 })),
      { op: "quit" },
    ]);

    const sheetMidSurface = hostFrames[3]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    const sheetSettledSurface = hostFrames[31]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    assert.ok(sheetMidSurface && sheetSettledSurface, "sheet mode must emit child hostSurface ops");
    assert.equal(sheetMidSurface.x, 0, "sheet entry must keep translateX = 0");
    assert.ok((sheetMidSurface.y ?? 0) > 50, `sheet entry must animate vertically via translateY (got y=${sheetMidSurface.y})`);
    assert.equal(sheetSettledSurface.x, 0);
    assert.equal(sheetSettledSurface.y, 0);

    const sheetLeftTapCloses = hostFrames.slice(32, 34).flatMap((f) => (f.events ?? []).filter((e) => e.name === "fixture.closed"));
    const sheetRightTapCloses = hostFrames.slice(34, 36).flatMap((f) => (f.events ?? []).filter((e) => e.name === "fixture.closed"));
    assert.equal(sheetLeftTapCloses.length, 0, "top-left must not trigger close in sheet mode");
    assert.equal(sheetRightTapCloses.length, 1, "top-right mini-app-close must trigger close in sheet mode");
    assert.equal(sheetRightTapCloses[0]?.payload?.style, "sheet");

    // Verify 1px first-frame admission in page mode while ready: false (Frames 62..63)
    const pagePreparingSurface = hostFrames[62]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    assert.ok(pagePreparingSurface, "page mode preparing phase must emit child hostSurface op");
    assert.equal(pagePreparingSurface.x, 389, "page mode ready:false must park surface at x = width - 1 = 389 for 1px admission");
    assert.equal(pagePreparingSurface.y, 0);

    // Frames 64..95 = page mode entry + settle
    const pageMidSurface = hostFrames[67]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    const pageSettledSurface = hostFrames[95]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    assert.ok(pageMidSurface && pageSettledSurface, "page mode must emit child hostSurface ops");
    assert.equal(pageMidSurface.y, 0, "page entry must keep translateY = 0");
    assert.ok((pageMidSurface.x ?? 0) > 50 && (pageMidSurface.x ?? 0) < 389, `page entry must animate horizontally via translateX (got x=${pageMidSurface.x})`);
    assert.equal(pageSettledSurface.x, 0);
    assert.equal(pageSettledSurface.y, 0);

    // Frames 96..97 = tap(360,30) in page mode; 98..99 = tap(30,30) in page mode
    const pageRightTapCloses = hostFrames.slice(96, 98).flatMap((f) => (f.events ?? []).filter((e) => e.name === "fixture.closed"));
    const pageLeftTapCloses = hostFrames.slice(98, 100).flatMap((f) => (f.events ?? []).filter((e) => e.name === "fixture.closed"));
    assert.equal(pageRightTapCloses.length, 0, "top-right must not trigger close in page mode");
    assert.equal(pageLeftTapCloses.length, 1, "top-left mini-app-back must trigger close in page mode");
    assert.equal(pageLeftTapCloses[0]?.payload?.style, "page");

    // Verify page mode dismiss animation direction (Frames 100..125: left-to-right 0 -> 389 via onBeforeDismiss)
    const pageDismissEarly = hostFrames[102]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    const pageDismissLate = hostFrames[110]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    const pageDismissEnd = hostFrames[125]?.ops?.find((op) => op.type === "hostSurface" && op.id === "app.child");
    assert.ok(pageDismissEarly && pageDismissLate && pageDismissEnd, "page dismiss must emit hostSurface frames");
    assert.equal(pageDismissEarly.y, 0, "page dismiss must keep translateY = 0");
    assert.ok(
      (pageDismissEarly.x ?? 0) > 0 && (pageDismissLate.x ?? 0) > (pageDismissEarly.x ?? 0) && (pageDismissLate.x ?? 0) < 389,
      `page dismiss must move left-to-right (0 -> 389): early=${pageDismissEarly.x}, late=${pageDismissLate.x}`,
    );
    assert.equal(pageDismissEnd.x, 389, "page dismiss settles back at x = width - 1 = 389");
    const pageDismissedEvents = hostFrames.slice(100, 126).flatMap((f) => (f.events ?? []).filter((e) => e.name === "fixture.dismissed"));
    assert.equal(pageDismissedEvents.length, 1, "onBeforeDismiss promise must resolve when page dismiss completes");

    // Part B: Child guest SafeAreaScaffold(reservedActions="mini-app") + MobileAppBar + MobileThemeProvider
    // Includes sheet -> page -> sheet reserve reset AND mid-side local occlusion alignment
    writeFileSync(join(guestProject, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.ui.guest-presets-native",
      app: {
        entry: "app.tsx",
        framework: "solid",
        viewport: { fixed: { logical: [390, 844], presentation: "native" } },
      },
    }));
    writeFileSync(join(guestProject, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(guestProject, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
import {
  MobileAppBar,
  MobileBadge,
  MobileButton,
  MobileThemeProvider,
  SafeAreaScaffold,
  createSystemPresets,
} from "@pocket/ui";

function GuestApp() {
  const presets = createSystemPresets();
  return (
    <MobileThemeProvider>
      <SafeAreaScaffold
        reservedActions="mini-app"
        appBar={() => (
          <MobileAppBar
            title="AppTitle"
            trailing={<MobileBadge label="GuestBadge" tone="accent" />}
          />
        )}
      >
        <View class="flex-col gap-2 p-4">
          <MobileButton label={\`Preset:\${presets().presentationStyle}:\${presets().colorScheme}\`} />
        </View>
      </SafeAreaScaffold>
    </MobileThemeProvider>
  );
}

mount(() => <GuestApp />);
`);

    const guestBuild = await buildGuest({ projectRoot: guestProject, outDir: join(guestProject, "out") });
    const guestFrames = runProbeCommands(probe, [
      { op: "create", width: 390, height: 844 },
      { op: "loadBytecode", bytecodePath: guestBuild.bytecode, pakPath: guestBuild.pak },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      // Switch to page + dark
      probeEvent(SYSTEM_PRESETS_EVENT, {
        darkMode: true,
        colorScheme: "dark",
        accentColor: "rose",
        density: "desktop",
        presentationStyle: "page",
      }),
      ...Array.from({ length: 6 }, () => ({ op: "frame", deltaMs: 16 })),
      // Switch back to sheet -> verify paddingL resets from 60 back to 16 (Finding #8.3)
      probeEvent(SYSTEM_PRESETS_EVENT, {
        darkMode: false,
        colorScheme: "light",
        accentColor: "blue",
        density: "auto",
        presentationStyle: "sheet",
      }),
      ...Array.from({ length: 4 }, () => ({ op: "frame", deltaMs: 16 })),
      // Switch back to page + inject mid-side left occlusion (landscape Dynamic Island below top bar)
      // to verify AppTitle does not collide with mini-app-back at x=8..52 (Finding #4 & #8.5)
      probeEvent(SYSTEM_PRESETS_EVENT, { presentationStyle: "page" }),
      probeEvent("display.viewport", {
        width: 390,
        height: 844,
        safeArea: { top: 0, right: 0, bottom: 0, left: 59 },
        keyboardInset: 0,
        reservedRegions: [{
          id: "left-island",
          kind: "occlusion",
          frame: { left: 0, top: 120, width: 59, height: 126 },
          margins: { top: 0, right: 0, bottom: 0, left: 0 },
          active: true,
        }],
      }),
      ...Array.from({ length: 4 }, () => ({ op: "frame", deltaMs: 16 })),
      { op: "quit" },
    ]);

    const sheetGuestFrame = guestFrames[1]!;
    const pageGuestFrame = guestFrames[7]!;
    const resetSheetGuestFrame = guestFrames[11]!;
    const occludedPageGuestFrame = guestFrames.at(-1)!;

    const sheetTitle = sheetGuestFrame.ops?.find((op) => op.type === "text" && op.text === "AppTitle");
    const sheetBadge = sheetGuestFrame.ops?.find((op) => op.type === "text" && op.text === "GuestBadge");
    const sheetPresetBtn = sheetGuestFrame.ops?.find((op) => op.type === "text" && op.text === "Preset:sheet:light");
    assert.ok(sheetTitle && sheetBadge && sheetPresetBtn, "initial sheet light guest frame must render title, badge, and preset button");
    assert.equal(sheetTitle.x, 16, "in sheet mode, leading AppTitle has no leading action reservation (x=16)");
    assert.ok((sheetBadge.x! + sheetBadge.w!) <= 330, `in sheet mode, trailing GuestBadge must stay left of 60px close reserve (right=${sheetBadge.x! + sheetBadge.w!})`);

    const pageTitle = pageGuestFrame.ops?.find((op) => op.type === "text" && op.text === "AppTitle");
    const pageBadge = pageGuestFrame.ops?.find((op) => op.type === "text" && op.text === "GuestBadge");
    const pagePresetBtn = pageGuestFrame.ops?.find((op) => op.type === "text" && op.text === "Preset:page:dark");
    assert.ok(pageTitle && pageBadge && pagePresetBtn, "updated page dark guest frame must render title, badge, and updated preset button");
    assert.ok((pageTitle.x ?? 0) >= 60, `in page mode, leading AppTitle must reserve >=60px for mini-app-back (got x=${pageTitle.x})`);
    assert.ok((pageBadge.x! + pageBadge.w!) > 330, `in page mode, trailing 60px reserve is released so GuestBadge shifts right (right=${pageBadge.x! + pageBadge.w!})`);

    // Verify page -> sheet reserve reset (Finding #8.3)
    const resetSheetTitle = resetSheetGuestFrame.ops?.find((op) => op.type === "text" && op.text === "AppTitle");
    const resetSheetBadge = resetSheetGuestFrame.ops?.find((op) => op.type === "text" && op.text === "GuestBadge");
    assert.ok(resetSheetTitle && resetSheetBadge, "reset sheet frame must render title and badge");
    assert.equal(resetSheetTitle.x, 16, "switching page -> sheet must reset AppTitle.x back to 16");
    assert.ok((resetSheetBadge.x! + resetSheetBadge.w!) <= 330, "switching page -> sheet must restore trailing 60px close reserve");

    // Verify mid-side left occlusion alignment (Finding #4)
    const occludedTitle = occludedPageGuestFrame.ops?.find((op) => op.type === "text" && op.text === "AppTitle");
    assert.ok(occludedTitle, "occluded page frame must render AppTitle");
    assert.ok((occludedTitle.x ?? 0) >= 60, `with mid-side left occlusion, AppTitle (${occludedTitle.x}) stays clear of mini-app-back (x=8..52)`);

    const lightCanvas = sheetGuestFrame.ops?.find((op) => op.type === "rect" && op.x === 0 && op.y === 0 && op.w === 390 && op.h === 844);
    const darkCanvas = pageGuestFrame.ops?.find((op) => op.type === "rect" && op.x === 0 && op.y === 0 && op.w === 390 && op.h === 844);
    assert.ok(lightCanvas && darkCanvas, "canvas background rect must be painted in both light and dark modes");
    assert.notEqual(lightCanvas.color, darkCanvas.color, "darkMode preset must flip MobileThemeProvider canvas color");

    // Part C: NovelView headerBounds reserves MINI_APP_HOST_ACTION_RESERVE (60px) on left in "page" mode and right in "sheet" mode (Finding #3 & #8)
    writeFileSync(join(vnProject, "package.json"), JSON.stringify({
      name: "vn-presets-native",
      private: true,
      dependencies: {
        "@pocket/ui": "0.1.0",
        "@pocket/vn": "0.1.0",
      },
    }));
    writeFileSync(join(vnProject, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.vn.presets-native",
      app: {
        entry: "app.tsx",
        framework: "solid",
        viewport: { fixed: { logical: [390, 844], presentation: "native" } },
      },
    }));
    writeFileSync(join(vnProject, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(join(vnProject, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";
import { NovelView } from "@pocket/vn/view";

const story: StoryDefinition = {
  id: "vn-test",
  version: 1,
  start: "opening",
  script: {
    opening: [
      { type: "say", id: "line-1", speaker: "Narrator", text: "Hello harbor." },
      { type: "ending", id: "end-1", text: "End." },
    ],
  },
};

const assets = {
  backgrounds: {},
  characters: {},
  cgs: {},
};

function VnGuest() {
  const engine = createNovelEngine(story);
  return <NovelView engine={engine} assets={assets} title="VNHeaderTitle" shortTitle="VNHeaderTitle" onNewGame={() => engine.start()} />;
}

mount(() => <VnGuest />);
`);

    const vnBuild = await buildGuest({ projectRoot: vnProject, outDir: join(vnProject, "out") });
    const vnInitFrames = runProbeCommands(probe, [
      { op: "create", width: 390, height: 844 },
      { op: "loadBytecode", bytecodePath: vnBuild.bytecode, pakPath: vnBuild.pak },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]);
    const startBtn = vnInitFrames.at(-1)?.ops?.find((op) => op.type === "text" && (op.text?.includes("开始") || op.text?.includes("Begin") || op.text?.includes("Start")));
    assert.ok(startBtn, `NovelView title screen must render start button (got texts: ${JSON.stringify(vnInitFrames.at(-1)?.ops?.filter(op => op.type === "text").map(op => op.text))})`);
    const tapX = (startBtn.x ?? 80) + 10;
    const tapY = (startBtn.y ?? 300) + 8;

    const vnFrames = runProbeCommands(probe, [
      { op: "create", width: 390, height: 844 },
      { op: "loadBytecode", bytecodePath: vnBuild.bytecode, pakPath: vnBuild.pak },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      ...probeTap(tapX, tapY),
      { op: "frame", deltaMs: 16 },
      probeEvent(SYSTEM_PRESETS_EVENT, { presentationStyle: "page" }),
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]);

    const vnSheetFrame = vnFrames[4]!;
    const vnPageFrame = vnFrames.at(-1)!;
    const vnSheetHeader = vnSheetFrame.ops?.find((op) => op.type === "text" && op.text === "VNHeaderTitle");
    const vnPageHeader = vnPageFrame.ops?.find((op) => op.type === "text" && op.text === "VNHeaderTitle");
    assert.ok(vnSheetHeader && vnPageHeader, "NovelView stage header must render VNHeaderTitle in both sheet and page modes");
    assert.ok(
      (vnSheetHeader.x ?? 0) < 60 && (vnPageHeader.x ?? 0) >= 60,
      `NovelView header must shift right to reserve >=60px for mini-app-back in page mode (sheet x=${vnSheetHeader.x}, page x=${vnPageHeader.x})`,
    );
  } finally {
    rmSync(hostProject, { recursive: true, force: true });
    rmSync(guestProject, { recursive: true, force: true });
    rmSync(vnProject, { recursive: true, force: true });
  }
}, testTimeoutMs);
