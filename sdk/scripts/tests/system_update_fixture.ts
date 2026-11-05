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
 * Build the two real bytecode generations used by
 * `system_ui_update_ffi_test.dart`.
 *
 * The test intentionally serves the signed v2 directory over HTTP instead of
 * constructing a Dart-side package envelope. This keeps the fixture on the
 * same pinned compiler and package signer used by consumers.
 */
const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("Pass the fixture output directory");

const output = resolve(outputArgument);
const appId = "test.system.update";
const keyFile = resolve(
  import.meta.dir,
  "fixtures/pocket-package/test-ed25519.json",
);
const key = JSON.parse(readFileSync(keyFile, "utf8")) as {
  keyId: string;
  publicKeyBase64: string;
};
const workspace = mkdtempSync(join(tmpdir(), "pocket-system-update-fixture-"));

function writeProject(project: string, build: number, version: string): void {
  writeFileSync(
    join(project, "pocket.json"),
    JSON.stringify({
      app: { entry: "app.tsx" },
      version,
      build,
    }),
  );
  writeFileSync(
    join(project, "manifest.json"),
    JSON.stringify({
      capabilities: {
        requires: [
          "updates.status",
          "updates.check",
          "updates.apply",
          "platform.storage.get",
          "platform.storage.set",
          "platform.storage.remove",
          "system.runtime.configure",
          "system.runtime.create",
          "system.runtime.awaitFirstFrame",
          "system.runtime.destroy",
          "system.runtime.post",
          "system.runtime.respond",
          "system.storage.get",
          "system.storage.set",
          "system.storage.remove",
          "system.storage.keys",
        ],
      },
    }),
  );
  writeFileSync(
    join(project, "app.tsx"),
    `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";
import { createPocketUpdateClient } from "@pocket/ui/updates";

const host = createHostBridge();
const [tapCount, setTapCount] = createSignal(0);
const systemManifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: "test.system.update.system",
  roles: { systemUI: "test.system.update" },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: "test.system.update", manifest: "pocket.json", required: true },
    ],
  },
  installation: { installedPackages: ["test.system.update"] },
};
const system = installPocketSystem(systemManifest, { bridge: host, maxResidentApps: 1 });
const platform = createPocketPlatformClient(undefined, { bridge: host });
const updates = createPocketUpdateClient(host, {
  autoRefresh: true,
  state: {
    key: "system-ui-update-state",
    schema: "system-ui-update-state.v1",
    storage: platform.storage,
    capture: () => ({ count: tapCount() }),
    restore: (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const count = (value as { count?: unknown }).count;
      if (!Number.isSafeInteger(count) || (count as number) < 0) return false;
      setTapCount(count as number);
      return true;
    },
  },
});
void system.ready.catch(() => {});
void updates.ready.catch(() => {});
host.emit?.("fixture.release", { version: "${version}" });
host.onEvent?.((event) => {
  if (event.method === "input.pointer" && event.params.phase === "up") {
    setTapCount(tapCount() + 1);
  }
});

mount(() => <Screen class="w-full h-full flex-col bg-white">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-black">Taps:{tapCount()}</Text>
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
    `${JSON.stringify({ appId, keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 }, null, 2)}\n`,
  );

  let runtimeAbi: string | undefined;
  for (const [build, version] of [
    [1, "1.0.0"],
    [2, "2.0.0"],
  ] as const) {
    const project = mkdtempSync(join(workspace, `project-${build}-`));
    const out = join(project, "out");
    try {
      writeProject(project, build, version);
      const built = await buildGuest({ projectRoot: project, outDir: out });
      const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as {
        runtimeAbi?: unknown;
      };
      if (
        typeof metadata.runtimeAbi !== "string" ||
        metadata.runtimeAbi.length === 0
      ) {
        throw new Error("build_guest did not emit a runtime ABI");
      }
      runtimeAbi ??= metadata.runtimeAbi;
      if (runtimeAbi !== metadata.runtimeAbi) {
        throw new Error(
          `fixture generations use different runtime ABIs: ${runtimeAbi} vs ${metadata.runtimeAbi}`,
        );
      }
      copyRuntimeAssets(out, join(output, `v${build}`, "assets"));
      if (build === 2) {
        packageArtifacts({
          appId,
          version,
          build,
          bytecodePath: built.bytecode,
          entryFormat: "quickjs-bytecode",
          runtimeAbi,
          pakPath: built.pak,
          outDir: join(output, "v2"),
          keyFile,
          guestManifestPath: join(out, "guest-manifest.json"),
          // The Flutter update coordinator exercises the signed manifest and
          // content-addressed blobs directly; no archive implementation is
          // needed to prove this promotion path.
          includeBundle: false,
          signedAt: 1,
        });
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
  writeFileSync(join(output, "runtime-abi.txt"), `${runtimeAbi}\n`);
  console.log(`System update fixture written to ${output}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
