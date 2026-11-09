import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../../sdk/scripts/build_guest.ts";
import { NativeSession, textOf, type Frame, type NativeArtifacts } from "./native_session.ts";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const loadingTitle = "正在打开 Pocket Profile";
const loadingPackage = "正在加载应用…";
const loadingFrame = "正在准备应用画面…";

function contains(frame: Frame, text: string): boolean {
  return textOf(frame).includes(text);
}

function frameDrawSignature(frame: Frame): string {
  return JSON.stringify((frame.ops ?? []).map(op => [op.type, op.text, op.x, op.y, op.w, op.h, op.color]));
}

test("real SystemAppSurfaces loading card tracks open facts without blocking its caller and stays mini-app-only", { timeout: 90_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-mini-app-loading-native-"));
  let session: NativeSession | undefined;
  try {
    const sdk = join(repositoryRoot, "sdk");
    writeFileSync(join(project, "package.json"), JSON.stringify({
      name: "pocket-mini-app-loading-native-fixture",
      private: true,
      type: "module",
      dependencies: { "@pocket/ui": `file:${join(sdk, "packages/pocket_ui")}` },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.mini-app-loading-native-fixture",
      app: { entry: "app.tsx", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      pocket: 2,
      id: "dev.pocket.mini-app-loading-native-fixture",
      capabilities: { requires: [], optional: [] },
    }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal, Show } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/solid/components";
import { Button } from "@pocket/ui";
import { SystemAppSurfaces } from "@pocket/ui/system-surfaces";

type Opening = { appId: string; title: string; stage: "preparing" | "firstFrame" } | null;
let opening: Opening = null;
const listeners = new Set<() => void>();
const system = {
  snapshot: () => ({ opening }),
  surfaceBindings: () => [],
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onBeforeDismiss: (_handler: (instanceIds: readonly string[]) => void | Promise<void>) => () => {},
};
function publishOpening(value: Opening): void {
  opening = value;
  for (const listener of [...listeners]) listener();
}

function Fixture(): JSX.Element {
  const [count, setCount] = createSignal(0);
  const [presentation, setPresentation] = createSignal<"mini-app" | "surface">("mini-app");
  const [message, setMessage] = createSignal("Idle");
  const begin = (): void => {
    setMessage("Launch pending");
    publishOpening({ appId: "pocket.demo.profile", title: "Pocket Profile", stage: "preparing" });
  };
  const firstFrame = (): void => {
    if (opening) publishOpening({ ...opening, stage: "firstFrame" });
  };
  const finish = (): void => {
    publishOpening(null);
    setMessage("Launch complete");
  };
  const fail = (): void => {
    publishOpening(null);
    setMessage("Launch failed: package unavailable");
  };

  return <>
    <View class="absolute left-[0] top-[120] flex-col gap-2 p-4">
      <Text>{"Counter: " + count()}</Text>
      <Text>{message()}</Text>
      <Button label="Increment counter" onPress={() => setCount(value => value + 1)} />
      <Button label="Begin mini app" onPress={begin} />
      <Button label="First frame ready" onPress={firstFrame} />
      <Button label="Complete launch" onPress={finish} />
      <Button label="Fail launch" onPress={fail} />
      <Button label={presentation() === "mini-app" ? "Use plain surface" : "Use mini-app surface"}
        onPress={() => setPresentation(value => value === "mini-app" ? "surface" : "mini-app")} />
    </View>
    <Show when={presentation() === "mini-app"} fallback={
      <SystemAppSurfaces system={system} presentation="surface" />
    }>
      <SystemAppSurfaces system={system} presentation="mini-app" onClose={() => {}} />
    </Show>
  </>;
}
mount(() => <Fixture />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "fixture must use the pinned QuickJS bytecode pipeline");
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };

    session = new NativeSession(artifacts, { width: 360, height: 640, deadlineMs: 60_000 });
    let frame = await session.boot();
    assert.ok(contains(frame, "Counter: 0"), `caller starts at zero; painted=${textOf(frame)}`);
    assert.ok(!contains(frame, loadingTitle), "idle mini-app presentation must not paint a loading card");
    const idleSignature = frameDrawSignature(frame);

    frame = await session.tap("Begin mini app", frame);
    assert.ok(contains(frame, loadingTitle), `opening fact must paint the app title; painted=${textOf(frame)}`);
    assert.ok(contains(frame, loadingPackage), `preparing stage must paint loading feedback; painted=${textOf(frame)}`);
    const preparingSignature = frameDrawSignature(frame);
    assert.notEqual(preparingSignature, idleSignature, "loading must change actual native DrawOps");

    frame = await session.tap("Increment counter", frame);
    assert.ok(contains(frame, "Counter: 1"), `caller input must remain live while loading; painted=${textOf(frame)}`);
    assert.ok(contains(frame, loadingPackage), "caller interaction must not clear the pending loader");
    assert.notEqual(frameDrawSignature(frame), preparingSignature, "counter input must change actual native DrawOps during loading");

    frame = await session.tap("Use plain surface", frame);
    assert.ok(contains(frame, "Launch pending"), "the controlled open remains pending in plain presentation");
    assert.ok(!contains(frame, loadingTitle), "plain surface presentation must not render the mini-app loading card");

    frame = await session.tap("Use mini-app surface", frame);
    assert.ok(contains(frame, loadingPackage), "returning to mini-app presentation must reflect the still-pending opening fact");
    frame = await session.tap("First frame ready", frame);
    assert.ok(contains(frame, loadingFrame), `first-frame fact must update its feedback; painted=${textOf(frame)}`);
    assert.ok(!contains(frame, loadingPackage), "first-frame feedback replaces the package loading label");

    frame = await session.tap("Complete launch", frame);
    assert.ok(contains(frame, "Launch complete"), "successful open clears the loading overlay");
    assert.ok(!contains(frame, loadingTitle), "successful open must not leave a stale loading card");

    frame = await session.tap("Begin mini app", frame);
    assert.ok(contains(frame, loadingTitle), "a later launch starts a fresh loading card");
    frame = await session.tap("Fail launch", frame);
    assert.ok(contains(frame, "Launch failed: package unavailable"), "launch failure is shown by the caller after clearing opening state");
    assert.ok(!contains(frame, loadingTitle), "failed open must clear the loading card");
    assert.equal((frame.ops ?? []).some(op => op.type === "text" && op.text === loadingTitle), false,
      "failed state must remove the actual loading text DrawOp");
  } finally {
    await session?.quit();
    rmSync(project, { recursive: true, force: true });
  }
});
