import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";
import { packageArtifacts } from "../package_update.ts";

/**
 * Build the real SystemUI + mini-app fixture used by
 * `mini_app_update_ffi_test.dart`.
 *
 * The root and child are embedded at build 1 and have signed build 1/build 2
 * releases. The SystemUI is therefore exercised through the same signed
 * package path as a remote host bootstrap. A cache-first open presents the
 * embedded/cached v1 while v2 is prepared in the background; returning and
 * reopening consumes the staged signed v2 package.
 */
const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("Pass the fixture output directory");

const output = resolve(outputArgument);
const rootAppId = "test.mini.update.root";
const childAppId = "test.mini.update.child";
const keyFile = resolve(
  import.meta.dir,
  "fixtures/pocket-package/test-ed25519.json",
);
const key = JSON.parse(readFileSync(keyFile, "utf8")) as {
  keyId: string;
  publicKeyBase64: string;
};
const workspace = mkdtempSync(join(tmpdir(), "pocket-mini-app-update-fixture-"));

function writeProject(
  project: string,
  appId: string,
  build: number,
  version: string,
  kind: "root" | "child",
): void {
  writeFileSync(
    join(project, "pocket.json"),
    JSON.stringify({ app: { entry: "app.tsx" }, version, build }),
  );
  const requires = kind === "root"
    ? [
        "ui.compositor-surfaces",
        "system.runtime.configure",
        "system.runtime.create",
        "system.runtime.prepareOpen",
        "system.runtime.appUpdateStatus",
        "system.runtime.appUpdatePrepare",
        "system.runtime.awaitFirstFrame",
        "system.runtime.destroy",
        "system.runtime.post",
        "system.runtime.respond",
        "system.storage.get",
        "system.storage.set",
        "system.storage.remove",
        "system.storage.keys",
        "platform.storage.get",
        "platform.storage.set",
        "platform.storage.remove",
        "platform.storage.keys",
        "platform.apps.open",
        "platform.apps.prewarm",
        "platform.apps.cancel",
        "platform.apps.update.status",
        "platform.apps.update.prepare",
      ]
    : [
        "platform.storage.get",
        "platform.storage.set",
        "platform.storage.remove",
        "platform.storage.keys",
        "platform.apps.return",
        "updates.status",
        "updates.check",
        "updates.apply",
      ];
  requires.push("fixture.signal");
  writeFileSync(
    join(project, "manifest.json"),
    JSON.stringify({ capabilities: { requires } }),
  );

  if (kind === "root") {
    writeFileSync(
      join(project, "app.tsx"),
      `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";

const rootAppId = ${JSON.stringify(rootAppId)};
const childAppId = ${JSON.stringify(childAppId)};
const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host });
const [status, setStatus] = createSignal("booting");
const systemManifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: rootAppId,
  roles: { systemUI: rootAppId },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: rootAppId, manifest: "pocket.json", required: true },
      { package: childAppId, manifest: "child/pocket.json", required: true },
    ],
  },
  installation: { installedPackages: [rootAppId, childAppId] },
};
const system = installPocketSystem(systemManifest, {
  bridge: host,
  maxResidentApps: 2,
});

let openInFlight = false;
async function prewarmChild(): Promise<void> {
  try {
    await system.ready;
    await platform.prewarm(childAppId);
    setStatus("prewarmed");
    await host.request("fixture.signal", { event: "prewarmed" });
  } catch (error) {
    setStatus("prewarm-error");
    await host.request("fixture.signal", { event: "prewarm-error", message: String(error) });
  }
}

async function openChild(): Promise<void> {
  if (openInFlight) return;
  openInFlight = true;
  setStatus("opening");
  let failure: string | undefined;
  try {
    const result = await platform.openApp(childAppId);
    setStatus(result.cancelled ? "cancelled" : "open");
  } catch (error) {
    setStatus("open-error");
    failure = String(error);
  } finally {
    openInFlight = false;
  }
  if (failure !== undefined) {
    await host.request("fixture.signal", { event: "open-error", message: failure });
  } else {
    await host.request("fixture.signal", { event: "open-settled" });
  }
}

async function prepareChildUpdate(): Promise<void> {
  try {
    const status = await platform.prepareAppUpdate(childAppId);
    await host.request("fixture.signal", {
      event: "update-prepared",
      latestVersion: status.latestVersion,
      latestBuild: status.latestBuild,
      stagedVersion: status.stagedVersion,
      stagedBuild: status.stagedBuild,
    });
  } catch (error) {
    await host.request("fixture.signal", {
      event: "update-prepare-error",
      message: String(error),
    });
  }
}

// Prewarm a real child session so the FFI test can distinguish an immediate
// cached open from a cold download and later consume a staged package.
void prewarmChild();
host.onEvent?.((event) => {
  if (event.method !== "input.pointer" || event.params.phase !== "up") return;
  // The test sends x=24 for prewarm, x=36 for update preparation, and x=72 to enter.
  const x = Number(event.params.x);
  if (x < 32) void prewarmChild();
  else if (x < 48) void prepareChildUpdate();
  else void openChild();
});

mount(() => <Screen class="w-full h-full flex-col bg-black">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-white">Root:{status()}</Text>
  </View>
  <SystemAppSurfaces
    system={system}
    presentation="mini-app"
    onClose={async (binding) => {
      const frame = system.snapshot().stack.find((entry) => entry.instanceId === binding.instanceId);
      if (!frame?.requestId) return;
      await host.request("platform.apps.cancel", { requestId: frame.requestId });
    }}
  />
</Screen>);
`,
    );
    return;
  }

  writeFileSync(
    join(project, "app.tsx"),
    `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";

const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host });
const [tapCount, setTapCount] = createSignal(0);
const releaseVersion = ${JSON.stringify(version)};
const releaseBuild = ${JSON.stringify(build)};
host.onEvent?.((event) => {
  if (event.method === "platform.lifecycle") {
    void host.request("fixture.signal", {
      event: "lifecycle", version: releaseVersion, build: releaseBuild,
      state: event.params.state,
      generationChanged: event.params.generationChanged === true,
    });
  }
  if (event.method === "input.pointer" && event.params.phase === "up") {
    if (Number(event.params.x) >= 180) {
      void platform.returnResult({ closed: true });
      return;
    }
    const count = tapCount() + 1;
    setTapCount(count);
    void host.request("fixture.signal", { event: "tap", version: releaseVersion, build: releaseBuild, count });
  }
});
mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-black">Mini:{releaseVersion} build:{releaseBuild} taps:{tapCount()}</Text>
  </View>
</Screen>);
`,
  );
}

function copyRuntimeAssets(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of [
    "app.qjbc",
    "app.pak",
    "app.bytecode.json",
    "guest-manifest.json",
  ]) {
    copyFileSync(join(source, name), join(destination, name));
  }
}

try {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, "fixture.json"),
    `${JSON.stringify({ rootAppId, childAppId, keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 }, null, 2)}\n`,
  );

  let runtimeAbi: string | undefined;
  const projects = [
    // Compile the SystemUI once.  root-v1/root-v2 intentionally differ only
    // in their signed release identity; the FFI test must exercise generation
    // replacement, not a second root bytecode/PAK implementation.
    { appId: rootAppId, build: 1, version: "1.0.0", kind: "root" as const },
    { appId: childAppId, build: 1, version: "1.0.0", kind: "child" as const },
    // Keep the semantic version fixed so the runtime and update UI prove that
    // build identity, not SemVer alone, selects the newer signed package.
    { appId: childAppId, build: 2, version: "1.0.0", kind: "child" as const },
  ];
  for (const projectInfo of projects) {
    const project = mkdtempSync(join(workspace, `project-${projectInfo.kind}-${projectInfo.build}-`));
    const out = join(project, "out");
    try {
      writeProject(
        project,
        projectInfo.appId,
        projectInfo.build,
        projectInfo.version,
        projectInfo.kind,
      );
      // Keep this fixture focused on package update admission; host-font
      // measurement has its own real FFI suite and is not part of OTA state.
      const built = await buildGuest({
        projectRoot: project,
        outDir: out,
        bakeFonts: true,
      });
      const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as {
        runtimeAbi?: unknown;
      };
      if (typeof metadata.runtimeAbi !== "string" || metadata.runtimeAbi.length === 0) {
        throw new Error(`build_guest did not emit a runtime ABI for ${projectInfo.kind}`);
      }
      runtimeAbi ??= metadata.runtimeAbi;
      if (runtimeAbi !== metadata.runtimeAbi) {
        throw new Error(`fixture generations use different runtime ABIs: ${runtimeAbi} vs ${metadata.runtimeAbi}`);
      }

      if (projectInfo.kind === "root") {
        copyRuntimeAssets(out, join(output, "root", "assets"));
        for (const release of [
          { version: "1.0.0", build: 1, directory: "root-v1" },
          { version: "2.0.0", build: 2, directory: "root-v2" },
        ]) {
          packageArtifacts({
            appId: rootAppId,
            version: release.version,
            build: release.build,
            bytecodePath: built.bytecode,
            entryFormat: "quickjs-bytecode",
            runtimeAbi,
            pakPath: built.pak,
            outDir: join(output, release.directory),
            keyFile,
            guestManifestPath: join(out, "guest-manifest.json"),
            includeBundle: false,
            signedAt: 1,
          });
        }
      } else if (projectInfo.build === 1) {
        copyRuntimeAssets(out, join(output, "child-v1", "assets"));
        packageArtifacts({
          appId: childAppId,
          version: projectInfo.version,
          build: projectInfo.build,
          bytecodePath: built.bytecode,
          entryFormat: "quickjs-bytecode",
          runtimeAbi,
          pakPath: built.pak,
          outDir: join(output, "child-v1"),
          keyFile,
          guestManifestPath: join(out, "guest-manifest.json"),
          includeBundle: false,
          signedAt: 1,
        });
      } else {
        packageArtifacts({
          appId: childAppId,
          version: projectInfo.version,
          build: projectInfo.build,
          bytecodePath: built.bytecode,
          entryFormat: "quickjs-bytecode",
          runtimeAbi,
          pakPath: built.pak,
          outDir: join(output, "child-v2"),
          keyFile,
          guestManifestPath: join(out, "guest-manifest.json"),
          includeBundle: false,
          signedAt: 1,
        });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
  writeFileSync(join(output, "runtime-abi.txt"), `${runtimeAbi}\n`);
  console.log(`Mini app update fixture written to ${output}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
