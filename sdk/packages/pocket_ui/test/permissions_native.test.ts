import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("compiled permissions guest updates its frame after pointer request and host response", () => {
  const sdk = resolve(import.meta.dir, "../../..");
  const probe = process.env.POCKET_NATIVE_PROBE ?? [
    "native/target/aarch64-apple-darwin/release/pocket_probe",
    "native/target/release/pocket_probe", "native/target/debug/pocket_probe",
  ].map(path => join(sdk, path)).find(existsSync);
  expect(probe).toBeTruthy();
  const project = mkdtempSync(join(tmpdir(), "pocket-permissions-native-"));
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "permissions-fixture", type: "module" }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2, id: "dev.pocket.permissions-fixture", version: "0.1.0",
      app: { entry: "app.tsx", output: "app", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [], optional: ["permissions.request"] }, permissions: { optional: ["hardware.camera"] } }));
    writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { createSignal } from "solid-js";
import { Text, View, Focusable } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPermissionsClient } from "@pocket/ui/permissions";
const permissions = createPocketPermissionsClient(createHostBridge());
const [status, setStatus] = createSignal("Ready");
async function load() {
  setStatus("Loading");
  try {
    const result = await permissions.request("hardware.camera");
    setStatus("Permission: " + result.status);
  } catch { setStatus("Unavailable"); }
}
mount(() => <View class="w-full h-full"><Focusable class="w-full h-20" onPress={load}><Text>Request</Text></Focusable><Text>{status()}</Text></View>);
`);
    const out = join(project, "out");
    const build = spawnSync("bun", [join(sdk, "scripts/build_guest.ts"), `--project-root=${project}`, `--outdir=${out}`], { encoding: "utf8", timeout: 120_000 });
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const bootstrap = [
      { op: "create", width: 360, height: 640 },
      { op: "loadBytecode", bytecodePath: join(out, "app.qjbc"), pakPath: join(out, "app.pak") },
      { op: "frame", deltaMs: 16 },
    ];
    const tap = ["down", "up"].flatMap(phase => [
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase, id: 0, x: 20, y: 20 } } },
      { op: "frame", deltaMs: 16 },
    ]);
    const run = (commands: unknown[]) => {
      const result = spawnSync(probe!, [], { input: commands.map(value => JSON.stringify(value)).join("\n") + "\n", encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      expect(result.status, result.stderr).toBe(0);
      const responses = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      for (const response of responses) expect(response.ok, JSON.stringify(response)).not.toBe(false);
      return responses.flatMap(value => value.frame ? [value.frame] : []);
    };
    const frames = run([...bootstrap, ...tap, { op: "quit" }]);
    const request = frames.flatMap(frame => frame.events ?? []).find(event => event.name === "host.request").payload;
    expect(request.capability).toBe("permissions.request");
    expect(request.params.policyKey).toBe("hardware.camera");
    for (const ok of [true, false]) {
      const completed = run([...bootstrap, ...tap,
        { op: "send", message: { type: "event", name: "host.response", payload: {
          requestId: request.requestId, capability: "permissions.request", ok,
          ...(ok ? { result: { ok: true, permission: "hardware.camera", status: "denied", granted: false, realHardware: true } } : { error: { code: "capability_unavailable", message: "No provider" } }),
        } } },
        { op: "frame", deltaMs: 16 }, { op: "frame", deltaMs: 16 }, { op: "quit" },
      ]);
      const texts = completed.flatMap(frame => frame.ops ?? []).filter(op => op.type === "text").map(op => op.text);
      expect(texts).toContain("Ready");
      expect(texts).toContain("Loading");
      expect(texts).toContain(ok ? "Permission: denied" : "Unavailable");
    }
  } finally { rmSync(project, { recursive: true, force: true }); }
}, 150_000);
