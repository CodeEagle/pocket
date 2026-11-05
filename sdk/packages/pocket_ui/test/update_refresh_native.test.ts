import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * This is a real buildGuest + native QuickJS probe. The fixture intentionally
 * keeps the host responses at the same verified package/version: the update
 * client must still run through status/check/apply, while apply's
 * `scheduled:false` result proves that an unchanged package does not ask the
 * Flutter session to create another generation.
 */
test("compiled SystemUI update client coalesces same-version health/resume refreshes", () => {
  const sdk = resolve(import.meta.dir, "../../..");
  const probe = process.env.POCKET_NATIVE_PROBE ?? [
    "native/target/aarch64-apple-darwin/release/pocket_probe",
    "native/target/release/pocket_probe",
    "native/target/debug/pocket_probe",
  ].map((path) => join(sdk, path)).find(existsSync);
  assert.ok(probe, "a bytecode-capable pocket_probe is required");

  const project = mkdtempSync(join(tmpdir(), "pocket-update-refresh-native-"));
  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "system-update-refresh-fixture", private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({
        pocket: 2,
        id: "pocket.test.system-update-refresh",
        version: "1.0.0",
        app: { entry: "app.tsx", output: "app", framework: "solid" },
      }),
    );
    writeFileSync(
      join(project, "manifest.json"),
      JSON.stringify({
        capabilities: {
          requires: ["updates.status", "updates.check", "updates.apply"],
        },
      }),
    );
    writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketUpdateClient } from "@pocket/ui/updates";
import { createSignal } from "solid-js";

const host = createHostBridge();
const updates = createPocketUpdateClient(host, {
  autoRefresh: true,
  onError: (error) => host.emit("fixture.updateError", { message: String(error) }),
});
const [tapCount, setTapCount] = createSignal(0);
host.onEvent((event) => {
  if (event.method === "input.pointer" && event.params.phase === "up") setTapCount(tapCount() + 1);
});
let mountCount = 0;
mount(() => {
  mountCount += 1;
  host.emit("fixture.mounted", { count: mountCount });
  return <View class="w-full h-full"><Text>SystemUI update fixture</Text><Text>{() => "Taps:" + tapCount()}</Text></View>;
});
`);

    const out = join(project, "out");
    const build = spawnSync(
      "bun",
      [join(sdk, "scripts/build_guest.ts"), `--project-root=${project}`, `--outdir=${out}`],
      { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const bytecodePath = join(out, "app.qjbc");
    const pakPath = join(out, "app.pak");
    assert.ok(existsSync(bytecodePath), "update fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "update fixture PAK is missing");

    const readyStatus = {
      configured: true,
      stage: "ready",
      activeVersion: "1.0.0",
      activeBuild: 1,
      availableVersion: "1.0.0",
      versions: [],
    };
    const verifiedStatus = {
      ...readyStatus,
      stage: "verified",
      preparedUpdate: {
        version: "1.0.0",
        build: 1,
        deliveryMode: "zip",
        scope: "all",
        targetResource: null,
        downloadedFiles: 0,
        reusedFiles: 0,
        downloadedBytes: 0,
        reusedBytes: 0,
        updatedComponents: [],
      },
    };
    const response = (requestId: string, capability: string, result: unknown) => ({
      op: "send",
      message: {
        type: "event",
        name: "host.response",
        payload: { requestId, capability, ok: true, result },
      },
    });
    const lifecycle = (state: string) => ({
      op: "send",
      message: {
        type: "event",
        name: "platform.lifecycle",
        payload: { appId: "pocket.test.system-update-refresh", instanceId: "system-ui", state },
      },
    });
    const frame = { op: "frame", deltaMs: 16 };
    const commands: Record<string, unknown>[] = [
      { op: "create", width: 360, height: 640 },
      { op: "loadBytecode", bytecodePath, pakPath },
      frame,
      // Initial autoRefresh: status -> check -> same-package no-op apply.
      response("guest-1", "updates.status", readyStatus),
      frame,
      frame,
      response("guest-2", "updates.check", verifiedStatus),
      frame,
      frame,
      response("guest-3", "updates.apply", { scheduled: false, version: "1.0.0" }),
      frame,
      frame,
      // Health and resume can arrive in the same guest turn. The second event
      // must coalesce with the first refresh rather than queueing another apply.
      { op: "send", message: { type: "event", name: "updates.changed", payload: readyStatus } },
      lifecycle("onResume"),
      frame,
      frame,
      response("guest-4", "updates.status", readyStatus),
      frame,
      frame,
      response("guest-5", "updates.check", verifiedStatus),
      frame,
      frame,
      response("guest-6", "updates.apply", { scheduled: false, version: "1.0.0" }),
      frame,
      frame,
      // A later health event starts one more refresh, but still cannot remount
      // because the host reports the package as unchanged.
      { op: "send", message: { type: "event", name: "updates.changed", payload: readyStatus } },
      frame,
      frame,
      response("guest-7", "updates.status", readyStatus),
      frame,
      frame,
      response("guest-8", "updates.check", verifiedStatus),
      frame,
      frame,
      response("guest-9", "updates.apply", { scheduled: false, version: "1.0.0" }),
      frame,
      frame,
      { op: "quit" },
    ];
    const run = spawnSync(probe, [], {
      input: commands.map((command) => JSON.stringify(command)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const responses = String(run.stdout).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const result of responses) assert.notEqual(result.ok, false, JSON.stringify(result));
    const events = responses.flatMap((result) => {
      const frameValue = result.frame;
      return frameValue && typeof frameValue === "object" && !Array.isArray(frameValue)
        ? ((frameValue as { events?: unknown[] }).events ?? [])
        : [];
    }).filter((event): event is { name: string; payload?: Record<string, unknown> } =>
      Boolean(event && typeof event === "object" && !Array.isArray(event) && typeof (event as { name?: unknown }).name === "string"),
    );
    const requests = events.filter((event) => event.name === "host.request");
    assert.deepEqual(
      requests.map((event) => (event.payload as { capability?: string }).capability),
      ["updates.status", "updates.check", "updates.apply", "updates.status", "updates.check", "updates.apply", "updates.status", "updates.check", "updates.apply"],
      `health/resume events must execute one coalesced refresh each; events=${JSON.stringify(events)}`,
    );
    assert.equal(events.filter((event) => event.name === "fixture.mounted").length, 1, "same-package refreshes must not remount the guest");
    assert.equal(events.some((event) => event.name === "fixture.updateError"), false, "same-package no-op refresh must not report an update error");

    const frames = responses.flatMap((result) => {
      const value = result.frame;
      return value && typeof value === "object" && !Array.isArray(value) ? [value as { ops?: Array<{ type?: string; text?: string }> }] : [];
    });
    const textValues = (frames.at(-1)?.ops ?? [])
      .filter((op) => op.type === "text")
      .map((op) => op.text);
    assert.ok(textValues.includes("Taps:0"), "initial SystemUI frame should be paintable");

    // The same compiled guest remains interactive after its refresh activity;
    // this is the native input/frame half of the regression, without claiming
    // that pocket_probe itself performs a Flutter package promotion.
    const inputRun = spawnSync(probe, [], {
      input: [
        { op: "create", width: 360, height: 640 },
        { op: "loadBytecode", bytecodePath, pakPath },
        frame,
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 20, y: 20 } } },
        frame,
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 20, y: 20 } } },
        frame,
        frame,
        { op: "quit" },
      ].map((command) => JSON.stringify(command)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(inputRun.status, 0, `${inputRun.stderr}\n${inputRun.stdout}`);
    const inputFrames = String(inputRun.stdout).trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .flatMap((result) => {
        const value = result.frame;
        return value && typeof value === "object" && !Array.isArray(value) ? [value as { ops?: Array<{ type?: string; text?: string }> }] : [];
      });
    const inputTextValues = (inputFrames.at(-1)?.ops ?? [])
      .filter((op) => op.type === "text")
      .map((op) => op.text);
    assert.ok(inputTextValues.includes("Taps:1"), "native pointer input must change the compiled guest frame");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 150_000);
