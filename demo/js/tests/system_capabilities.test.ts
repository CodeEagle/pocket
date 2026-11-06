import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mock, test } from "bun:test";

import type { HostBridge, JsonObject, JsonValue } from "../../../sdk/packages/pocket_ui/src/host.ts";
import type { PocketSystemV1 } from "../../../sdk/packages/pocket_ui/src/system.ts";

mock.module("@pocketjs/framework/clock", () => ({ simulationHz: () => 60 }));
const { installPocketSystem } = await import("../../../sdk/packages/pocket_ui/src/system.ts");

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, "../../..");
const sourceGuestManifestPath = join(repositoryRoot, "demo/js/manifest.json");
const systemHostPath = join(repositoryRoot, "sdk/lib/src/pocket_system_host.dart");

const SYSTEM_UI = "pocket.host.demo";
const PROFILE = "pocket.demo.profile";
const SYSTEM_GENERATION = "system-generation";

const systemManifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: "pocket.demo.system",
  roles: { systemUI: SYSTEM_UI },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: SYSTEM_UI, manifest: "pocket.json", required: true },
      { package: PROFILE, manifest: "apps/profile/pocket.json", required: true },
    ],
  },
  installation: { installedPackages: [SYSTEM_UI, PROFILE] },
};

interface HostCall {
  capability: string;
  params: JsonObject;
}

/** A real kernel host seam: calls are recorded from install/open, not copied
 * from the implementation's expected request sequence. */
class TraceHost implements HostBridge {
  readonly calls: HostCall[] = [];
  private nextInstance = 1;
  private readonly runtimes = new Map<string, { appId: string; generation: string }>();
  private readonly waiters: Array<{
    matches: (call: HostCall) => boolean;
    resolve: (call: HostCall) => void;
  }> = [];

  request<T extends JsonValue = JsonValue>(capability: string, params: JsonObject = {}): Promise<T> {
    const call = { capability, params };
    this.calls.push(call);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index]!;
      if (!waiter.matches(call)) continue;
      this.waiters.splice(index, 1);
      waiter.resolve(call);
    }

    let result: JsonValue;
    if (capability === "system.runtime.configure") {
      result = { systemInstanceId: "system-ui", generation: SYSTEM_GENERATION };
    } else if (capability === "system.runtime.create") {
      const appId = String(params.appId);
      const instanceId = `profile-instance-${this.nextInstance++}`;
      const generation = "profile-generation";
      this.runtimes.set(instanceId, { appId, generation });
      result = {
        appId,
        instanceId,
        generation,
        ...(params.prepareForOpen === true ? { preparedForOpen: true } : {}),
      };
    } else if (capability === "system.runtime.prepareOpen") {
      const instanceId = String(params.instanceId);
      const runtime = this.runtimes.get(instanceId);
      if (!runtime || params.generation !== runtime.generation) {
        return Promise.reject(new Error("runtime.prepareOpen fixture received an unknown or stale runtime"));
      }
      result = {
        instanceId,
        appId: runtime.appId,
        previousGeneration: runtime.generation,
        generation: runtime.generation,
        updated: false,
        configured: false,
      };
    } else if (capability === "system.runtime.awaitFirstFrame") {
      result = { ready: true, generation: params.generation };
    } else if (capability === "system.runtime.post") {
      result = { accepted: true };
    } else if (capability === "system.runtime.respond") {
      result = null;
    } else {
      throw new Error(`unexpected system capability ${capability}`);
    }
    return Promise.resolve(result as T);
  }

  handle(_packet: Record<string, unknown>): boolean { return false; }
  tick(): void {}
  dispose(): void {}

  waitForCall(matches: (call: HostCall) => boolean): Promise<HostCall> {
    const existing = this.calls.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ matches, resolve }));
  }
}

function declaredGuestCapabilities(): Set<string> {
  const source = JSON.parse(readFileSync(sourceGuestManifestPath, "utf8")) as {
    capabilities?: { requires?: unknown; optional?: unknown };
  };
  const capabilities = source.capabilities ?? {};
  return new Set<string>([
    ...(Array.isArray(capabilities.requires) ? capabilities.requires : []),
    ...(Array.isArray(capabilities.optional) ? capabilities.optional : []),
  ].filter((value): value is string => typeof value === "string"));
}

function registeredSystemHostCapabilities(): Set<string> {
  const source = readFileSync(systemHostPath, "utf8");
  const declaration = source.match(
    /const List<String> _systemRequestCapabilities = <String>\[([\s\S]*?)\];/,
  );
  assert.ok(declaration, "PocketSystemHost must keep a system request capability registry");
  return new Set<string>(
    [...declaration![1]!.matchAll(/['"](system\.runtime\.[A-Za-z0-9._-]+)['"]/g)].map((match) => match[1]!),
  );
}

test("SystemUI manifest covers the live runtime host capability contract", async () => {
  const declared = declaredGuestCapabilities();
  const registered = registeredSystemHostCapabilities();

  // This is the regression that caught de8b051: the host added this method,
  // and system.ts calls it during open, while the guest declaration retained
  // the removed system.runtime.present name.
  assert.equal(declared.has("system.runtime.awaitFirstFrame"), true);
  assert.equal(declared.has("system.runtime.present"), false);
  for (const capability of registered) {
    assert.equal(
      declared.has(capability),
      true,
      `SystemUI manifest must declare registered host method ${capability}`,
    );
  }

  const globalObject = globalThis as typeof globalThis & {
    __pocketEvent?: (packet: Record<string, unknown>) => void;
    ui?: { __surfaces?: Record<string, number> };
  };
  const previousEvent = globalObject.__pocketEvent;
  const previousUi = globalObject.ui;
  const host = new TraceHost();
  let kernel: ReturnType<typeof installPocketSystem> | undefined;
  try {
    globalObject.ui = { __surfaces: { [PROFILE]: 2 } };
    kernel = installPocketSystem(systemManifest, {
      bridge: host,
      policies: {
        [SYSTEM_UI]: {
          allowedOpenApps: [PROFILE],
          messageTargets: [],
          sharedNamespaces: [],
        },
        [PROFILE]: {
          allowedOpenApps: [],
          messageTargets: [],
          sharedNamespaces: [],
        },
      },
    });
    await kernel.ready;

    const firstFrame = host.waitForCall(
      (call) => call.capability === "system.runtime.awaitFirstFrame",
    );
    const launch = host.waitForCall(
      (call) => call.capability === "system.runtime.post" && call.params.event === "platform.launch",
    );
    const eventSink = globalObject.__pocketEvent;
    assert.equal(typeof eventSink, "function");
    eventSink!({
      type: "event",
      name: "system.request",
      payload: {
        requestId: "manifest-capability-regression",
        sourceAppId: SYSTEM_UI,
        sourceInstanceId: "system-ui",
        sourceGeneration: SYSTEM_GENERATION,
        capability: "platform.apps.open",
        params: { appId: PROFILE, arguments: null },
      },
    });

    await firstFrame;
    await launch;
    const runtimeCalls = host.calls
      .map((call) => call.capability)
      .filter((capability) => capability.startsWith("system.runtime."));
    for (const capability of new Set(runtimeCalls)) {
      assert.equal(
        declared.has(capability),
        true,
        `live SystemUI request ${capability} is missing from manifest.json`,
      );
    }
    const awaitIndex = host.calls.findIndex(
      (call) => call.capability === "system.runtime.awaitFirstFrame",
    );
    const launchIndex = host.calls.findIndex(
      (call) => call.capability === "system.runtime.post" && call.params.event === "platform.launch",
    );
    assert.ok(awaitIndex >= 0 && launchIndex > awaitIndex, "open must await the real child first frame before launch");
    assert.deepEqual(kernel.surfaceBindings(), [{
      appId: PROFILE,
      instanceId: "profile-instance-1",
      surfaceHandle: 2,
      focused: true,
      ready: false,
    }]);
  } finally {
    kernel?.dispose();
    globalObject.__pocketEvent = previousEvent;
    globalObject.ui = previousUi;
  }
});
