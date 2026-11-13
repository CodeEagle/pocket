import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildGuest } from "../build_guest.ts";
import { startEditor } from "../../editor/server.ts";

/**
 * Service half of `test/studio_preview_ffi_test.dart`.
 *
 * Builds a Studio stand-in SystemUI (the trusted parent) with the pinned
 * `buildGuest`, then starts a real editor service on a loopback port and prints
 * one JSON line the Flutter test reads. The test drives the editor HTTP API
 * itself (create project, save, build, preview-publish); this script owns no
 * test logic and never mocks the service.
 *
 * usage: bun scripts/tests/studio_preview_service.ts <work-dir>
 */
const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("Pass the work directory");
const output = resolve(outputArgument);
const previewAppId = "dev.pocket.studio.preview";
const studioAppId = "dev.pocket.studio.standin";
const hostVersion = "studio-ffi";

const root = `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { installPocketSystem, type PocketSystemV1 } from "@pocket/ui/system";

const studioAppId = ${JSON.stringify(studioAppId)};
const previewAppId = ${JSON.stringify(previewAppId)};
const host = createHostBridge();
const [status, setStatus] = createSignal("booting");
const manifest: PocketSystemV1 = {
  pocketSystem: 1,
  id: studioAppId,
  roles: { systemUI: studioAppId },
  applications: {
    backgroundExecution: "suspend",
    catalog: [
      { package: studioAppId, manifest: "pocket.json", required: true },
      { package: previewAppId, manifest: "preview/pocket.json", required: true },
    ],
  },
  installation: { installedPackages: [studioAppId, previewAppId] },
};
const system = installPocketSystem(manifest, { bridge: host, maxResidentApps: 2 });

let instanceId: string | undefined;
let busy = false;

async function signal(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  await host.request("fixture.signal", { event, ...extra });
}

/**
 * Studio reload: close the preview child and re-create it WITHOUT cacheFirst,
 * so the signed update source is checked, downloaded and verified before the
 * child can run. Uses only the existing system.runtime.* host requests.
 */
async function reloadPreview(): Promise<void> {
  if (busy) { void signal("reload-skipped-busy"); return; }
  busy = true;
  setStatus("reloading");
  let failure: { code: string; message: string } | undefined;
  try {
    await system.ready;
    if (instanceId !== undefined) {
      const old = instanceId;
      instanceId = undefined;
      await host.request("system.runtime.destroy", { instanceId: old });
    }
    const created = await host.request("system.runtime.create", { appId: previewAppId, prepareForOpen: true }) as Record<string, unknown>;
    instanceId = String(created.instanceId);
    // The child stays hidden here; on-screen presentation (CompositorSurface)
    // is a macOS Spike C item, so the host observes its first frame instead.
    setStatus("running");
  } catch (error) {
    setStatus("reload-error");
    failure = { code: String((error as { code?: string }).code ?? ""), message: String(error) };
  }
  // Release the guard before reporting so a reload sent right after the
  // signal is not dropped.
  busy = false;
  if (failure) await signal("reload-error", failure);
  else await signal("reloaded", { ok: true });
}

async function useParentCapability(): Promise<void> {
  try {
    const value = await host.request("studio.secret", {}) as Record<string, unknown>;
    await signal("parent-capability", { ok: true, value: String(value.value) });
  } catch (error) {
    await signal("parent-capability", { ok: false, message: String(error) });
  }
}

void reloadPreview();
host.onEvent?.((event) => {
  if (event.method !== "input.pointer" || event.params.phase !== "up") return;
  void signal("pointer", { x: Number(event.params.x) });
  // The test sends x=24 to reload the preview and x=72 to use a parent grant.
  if (Number(event.params.x) < 48) void reloadPreview();
  else void useParentCapability();
});

mount(() => <Screen class="w-full h-full flex-col bg-black">
  <View class="flex-col gap-2 p-4">
    <Text class="text-base text-white">Studio:{status()}</Text>
  </View>
</Screen>);
`;

const rootRequires = [
  "ui.compositor-surfaces",
  "system.runtime.configure",
  "system.runtime.create",
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
  "fixture.signal",
  "studio.secret",
];

const work = mkdtempSync(join(tmpdir(), "pocket-studio-standin-"));
try {
  writeFileSync(join(work, "pocket.json"), JSON.stringify({ app: { entry: "app.tsx" }, version: "1.0.0", build: 1 }));
  writeFileSync(join(work, "manifest.json"), JSON.stringify({ capabilities: { requires: rootRequires } }));
  writeFileSync(join(work, "app.tsx"), root);
  const out = join(work, "out");
  await buildGuest({ projectRoot: work, outDir: out });
  const assets = join(output, "root", "assets");
  mkdirSync(assets, { recursive: true });
  for (const name of ["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"]) {
    copyFileSync(join(out, name), join(assets, name));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const server = await startEditor({ port: 0, workspace: join(output, "workspace"), updateHostVersion: hostVersion });
const csrfToken = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()).csrfToken;
console.log(JSON.stringify({ ready: true, port: server.port, csrfToken, hostVersion, previewAppId, studioAppId, workspace: join(output, "workspace") }));
// Stay up until the Flutter test closes stdin or terminates the process.
process.stdin.resume();
process.stdin.on("close", async () => { await server.stop(true); process.exit(0); });
process.on("SIGTERM", async () => { await server.stop(true); process.exit(0); });
