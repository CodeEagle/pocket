import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { resolveNativeProbePath } from "../../../scripts/native_probe_path.ts";

const sdkRoot = resolve(import.meta.dir, "../../..");

test("bytecode guest gates retained video commands through platform lifecycle and page/feed selection", () => {
  const probe = resolveNativeProbePath(sdkRoot);
  const project = mkdtempSync(join(tmpdir(), "pocket-media-native-"));
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "pocket-media-native-fixture", private: true, type: "module" }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2, id: "dev.pocket.media-fixture", version: "0.1.0",
      app: { entry: "app.tsx", output: "app", framework: "solid", viewport: { fixed: { logical: [360, 640], presentation: "native" } } },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    // This fixture exercises the real guest event transport, not a replacement
    // video renderer. Native decoder execution is covered by the Flutter fake
    // platform tests; no asset or hardware playback is claimed by this test.
    writeFileSync(join(project, "app.tsx"), `
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPocketPlatformClient } from "@pocket/ui/platform";
const host = createHostBridge();
const platform = createPocketPlatformClient(undefined, { bridge: host });
const media = platform.media!;
media.setCurrentPage("home");
const first = media.register("hero", { page: "home", group: "feed", playing: true });
const next = media.register("next", { page: "home", group: "feed", active: false });
host.onEvent(event => {
  if (event.method !== "fixture.command") return;
  switch (event.params.action) {
    case "pause": first.pause(); break;
    case "play": first.play(); break;
    case "next": next.setActive(true); next.play(); break;
    case "other-page": media.setCurrentPage("other"); break;
    case "home-page": media.setCurrentPage("home"); break;
    case "open": void platform.openApp("fixture.child").catch(error => {
      host.emit("fixture.error", { message: String(error) });
    }); break;
    case "dispose": platform.dispose(); break;
  }
});
mount(() => <View class="w-full h-full"><Text>Media lifecycle fixture</Text></View>);
`);
    const output = join(project, "out");
    const build = spawnSync("bun", [join(sdkRoot, "scripts/build_guest.ts"), `--project-root=${project}`, `--outdir=${output}`], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(build.status, 0, `${build.error ?? ""}\n${build.stdout}\n${build.stderr}`);
    const commands: Record<string, unknown>[] = [
      { op: "create", width: 360, height: 640 },
      { op: "loadBytecode", bytecodePath: join(output, "app.qjbc"), pakPath: join(output, "app.pak") },
      { op: "frame", deltaMs: 16 },
    ];
    const send = (name: string, payload: Record<string, unknown>) => {
      commands.push({ op: "send", message: { type: "event", name, payload } }, { op: "frame", deltaMs: 16 });
    };
    send("platform.lifecycle", { state: "onWillDisappear" });
    send("platform.lifecycle", { state: "frozenInStack" });
    send("fixture.command", { action: "pause" });
    send("platform.lifecycle", { state: "onResume" });
    send("fixture.command", { action: "play" });
    send("fixture.command", { action: "next" });
    send("fixture.command", { action: "other-page" });
    send("fixture.command", { action: "home-page" });
    send("fixture.command", { action: "open" });
    send("host.response", { requestId: "guest-1", capability: "platform.apps.open", ok: true, result: { requestId: "fixture-launch" } });
    send("platform.result", { requestId: "fixture-launch", appId: "fixture.child", cancelled: false, value: null });
    send("fixture.command", { action: "dispose" });
    send("platform.lifecycle", { state: "onResume" });
    commands.push({ op: "quit" });
    const run = spawnSync(probe, [], {
      input: commands.map(command => JSON.stringify(command)).join("\n") + "\n",
      encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stderr}\n${run.stdout}`);
    const responses = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    for (const response of responses) assert.notEqual(response.ok, false, JSON.stringify(response));
    const frames = responses.filter(response => response.frame).map(response => response.frame);
    const outbound = frames.flatMap(frame => frame.events ?? []);
    assert.equal(outbound.some((event: { name: string }) => event.name === "fixture.error"), false,
      "the real platform open/result promise must complete without a guest error");
    const open = outbound.find((event: { name: string; payload?: { capability: string } }) =>
      event.name === "host.request" && event.payload?.capability === "platform.apps.open");
    assert.equal(open?.payload.requestId, "guest-1", "fixture response must address the actual outbound open request");
    const openingEvents = frames[9].events ?? [];
    const pauseIndex = openingEvents.findIndex((event: { name: string }) => event.name === "video.pause");
    const requestIndex = openingEvents.findIndex((event: { name: string }) => event.name === "host.request");
    assert.ok(pauseIndex >= 0 && requestIndex > pauseIndex,
      "the native event stream must pause root media before requesting the child launch");
    const events = frames.map(frame => (frame.events ?? [])
      .filter((event: { name?: string }) => event.name === "video.play" || event.name === "video.pause")
      .map((event: { name: string; payload: { id: string } }) => `${event.name}:${event.payload.id}`));
    assert.deepEqual(events, [
      ["video.play:hero", "video.pause:next"],
      ["video.pause:hero"],
      [], // Repeated lifecycle facts are idempotent.
      [], // User pause while covered changes intent without waking playback.
      [], // Resume must respect that explicit pause.
      ["video.play:hero"],
      ["video.pause:hero", "video.play:next"],
      ["video.pause:next"], // The other page gates the active feed item.
      ["video.play:next"],
      ["video.pause:next"], // Root media stops before the native open request.
      [], // Launch acknowledgement alone does not remove the coverage gate.
      ["video.play:next"], // The actual app result releases that gate.
      [], // Explicit controller disposal uses video.release, not a transient pause.
      [], // Disposed controllers do not respond to late lifecycle events.
    ]);
    const releases = frames
      .flatMap(frame => frame.events ?? [])
      .filter((event: { name?: string }) => event.name === "video.release")
      .map((event: { payload?: { id?: string } }) => `video.release:${event.payload?.id ?? ""}`);
    assert.ok(releases.includes("video.release:hero"), "disposing the fixture must release hero permanently");
    assert.ok(releases.includes("video.release:next"), "disposing the fixture must release next permanently");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 150_000);
