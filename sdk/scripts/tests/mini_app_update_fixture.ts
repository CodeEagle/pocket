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
 * The child is embedded at build 1 and has signed build 1/build 2 releases.
 * The SystemUI prewarms the child, while the Dart host's prepareOpen boundary
 * admits build 2 before the kernel freezes or presents the caller.
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
      ]
    : [
        "platform.storage.get",
        "platform.storage.set",
        "platform.storage.remove",
        "platform.storage.keys",
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
  }
}

// The first real child entry is deliberately a resident prewarm. It does not
// create a compositor surface, so a later prepareOpen failure can leave this
// caller visible and retry against the same child instance.
void prewarmChild();
host.onEvent?.((event) => {
  if (event.method !== "input.pointer" || event.params.phase !== "up") return;
  // The test sends x=24 for a retry/prewarm command and x=72 to enter.
  if (Number(event.params.x) < 48) void prewarmChild();
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

const host = createHostBridge();
const [tapCount, setTapCount] = createSignal(0);
const releaseVersion = ${JSON.stringify(version)};
host.onEvent?.((event) => {
  if (event.method === "platform.lifecycle") {
    void host.request("fixture.signal", {
      event: "lifecycle", version: releaseVersion,
      state: event.params.state,
      generationChanged: event.params.generationChanged === true,
    });
  }
  if (event.method === "input.pointer" && event.params.phase === "up") {
    const count = tapCount() + 1;
    setTapCount(count);
    void host.request("fixture.signal", { event: "tap", version: releaseVersion, count });
  }
});
mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-black">Mini:{releaseVersion} taps:{tapCount()}</Text>
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
    { appId: rootAppId, build: 1, version: "1.0.0", kind: "root" as const },
    { appId: childAppId, build: 1, version: "1.0.0", kind: "child" as const },
    { appId: childAppId, build: 2, version: "2.0.0", kind: "child" as const },
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
      const built = await buildGuest({ projectRoot: project, outDir: out });
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
          includeBundle: true,
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
          includeBundle: true,
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
