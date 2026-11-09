import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../../scripts/build_guest.ts";
import { NativeSession, textOf, type NativeArtifacts, type Frame } from "../../../demo/js/tests/native_session.ts";

const sdkRoot = resolve(import.meta.dir, "../..");
const highresTools = join(sdkRoot, ".pocket-build/highres-native-tools-20261107");

function nativeToolPair(): { toolsRoot: string; probe: string } {
  const configuredTools = process.env.POCKET_TOOLS_PACKAGE?.trim();
  const configuredProbe = process.env.POCKET_NATIVE_PROBE?.trim();
  assert.equal(Boolean(configuredTools), Boolean(configuredProbe), "set POCKET_TOOLS_PACKAGE and POCKET_NATIVE_PROBE together for a non-default native toolchain");
  const toolsRoot = resolve(configuredTools ?? highresTools);
  const probe = resolve(configuredProbe ?? join(highresTools, "bin/pocket_probe"));
  assert.equal(probe, resolve(join(toolsRoot, "bin/pocket_probe")), "POCKET_NATIVE_PROBE must come from POCKET_TOOLS_PACKAGE");
  return { toolsRoot, probe };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function includes(frame: Frame, value: string): boolean {
  return textOf(frame).includes(value);
}

function assertPainted(frame: Frame, value: string): void {
  assert.ok(includes(frame, value), `expected native frame to paint ${JSON.stringify(value)}; painted=${textOf(frame)}`);
}

test("compiled Guest pointers execute nested call/return and recover after a real step-budget rollback", { timeout: 180_000 }, async () => {
  const { toolsRoot, probe } = nativeToolPair();
  assert.ok(existsSync(probe), `pinned high-resolution native probe is required: ${probe}`);
  const compiler = join(toolsRoot, "compiler/tools/build.ts");
  assert.ok(existsSync(compiler), `pinned PocketJS compiler is required: ${compiler}`);

  const priorProbe = process.env.POCKET_NATIVE_PROBE;
  const priorTools = process.env.POCKET_TOOLS_PACKAGE;
  process.env.POCKET_NATIVE_PROBE = probe;
  process.env.POCKET_TOOLS_PACKAGE = toolsRoot;
  const project = mkdtempSync(join(tmpdir(), "pocket-vn-control-flow-native-"));
  let session: NativeSession | undefined;
  try {
    writeFileSync(join(project, "package.json"), JSON.stringify({
      dependencies: { "@pocket/vn": `file:${join(sdkRoot, "packages/pocket_vn")}` },
    }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2, id: "fixture.vn-control-flow", app: { entry: "app.tsx", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      pocket: 2, id: "fixture.vn-control-flow", capabilities: { requires: [], optional: [] },
    }));
    writeFileSync(join(project, "app.tsx"), `
import { createSignal, onCleanup } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";
import { createNovelEngine, type StoryDefinition } from "@pocket/vn";

const story: StoryDefinition = {
  id: "control-flow-native-fixture",
  version: 1,
  start: "start",
  script: {
    start: [
      { type: "set", variable: "trace", value: "root" },
      { type: "say", id: "root-before-call", text: "ROOT BEFORE CALL" },
      { type: "call", target: "outer" },
      { type: "set", variable: "trace", value: "root>outer>inner>inner-returned>outer-returned" },
      { type: "say", id: "root-after-return", text: "ROOT AFTER RETURN" },
      { type: "choice", id: "root-recovery-choice", options: [
        { id: "loop", text: "Run bounded loop", target: "loop" },
        { id: "safe", text: "Continue safely", target: "safe" },
      ] },
    ],
    outer: [
      { type: "set", variable: "trace", value: "root>outer" },
      { type: "say", id: "outer-before-call", text: "OUTER BEFORE INNER CALL" },
      { type: "call", target: "inner" },
      { type: "set", variable: "trace", value: "root>outer>inner>inner-returned" },
      { type: "say", id: "outer-after-return", text: "OUTER RESUMED AFTER INNER RETURN" },
      { type: "return" },
    ],
    inner: [
      { type: "set", variable: "trace", value: "root>outer>inner" },
      { type: "say", id: "inner-return-point", text: "INNER RETURN POINT" },
      { type: "return" },
    ],
    loop: [
      { type: "inc", variable: "loopCount", amount: 1 },
      { type: "jump", target: "loop" },
    ],
    safe: [
      { type: "set", variable: "trace", value: "root>outer>inner>inner-returned>outer-returned>safe" },
      { type: "say", id: "safe-after-error", text: "SAFE ACTION AFTER ROLLBACK" },
      { type: "ending", id: "complete", text: "Done" },
    ],
  },
};

function App() {
  const engine = createNovelEngine(story, {
    maxStepBudget: 32,
    initialVariables: { loopCount: 0 },
    preferences: { textSpeedCharsPerSecond: 0 },
  });
  const [snapshot, setSnapshot] = createSignal(engine.getSnapshot());
  const [diagnostic, setDiagnostic] = createSignal("");
  const unsubscribe = engine.subscribe(update => setSnapshot(update.snapshot), { emitCurrent: true });
  onCleanup(() => { unsubscribe(); engine.dispose(); });

  const invoke = (operation: () => unknown) => {
    setDiagnostic("");
    try { operation(); }
    catch (error) {
      const value = error as Error;
      setDiagnostic(value.name + ": " + value.message);
      // A failed engine transaction deliberately emits no update. Refreshing
      // from the engine exposes the restored live snapshot to the test UI.
      setSnapshot(engine.getSnapshot());
    }
  };
  const activeId = () => {
    const active = snapshot().active;
    return active && "id" in active ? active.id : "none";
  };
  const activeText = () => {
    const active = snapshot().active;
    return active && "visibleText" in active ? active.visibleText : "";
  };

  return <Screen class="relative w-full h-full bg-[#08151D]">
    <Text class="absolute left-[8] top-[8] text-xs text-[#F5ECD9]">active={activeId()}</Text>
    <Text class="absolute left-[8] top-[26] text-xs text-[#F5ECD9]">location={snapshot().location.label}[{snapshot().location.index}]</Text>
    <Text class="absolute left-[8] top-[44] text-xs text-[#F5ECD9]">callStack={JSON.stringify(snapshot().callStack)}</Text>
    <Text class="absolute left-[8] top-[64] text-xs text-[#F5ECD9]">variables={JSON.stringify(snapshot().variables)}</Text>
    <Text class="absolute left-[8] top-[84] text-xs text-[#F0B78F]">diagnostic={diagnostic()}</Text>
    <Text class="absolute left-[8] top-[104] text-xs text-[#F5ECD9]">line={activeText()}</Text>
    <Focusable class="absolute left-[8] top-[350] w-[304] h-[48] bg-[#273B44]" onPress={() => invoke(() => engine.start())}>
      <Text>Start</Text>
    </Focusable>
    <Focusable class="absolute left-[8] top-[404] w-[304] h-[48] bg-[#273B44]" onPress={() => invoke(() => engine.advance())}>
      <Text>Continue</Text>
    </Focusable>
    <Focusable class="absolute left-[8] top-[458] w-[304] h-[48] bg-[#273B44]" onPress={() => invoke(() => engine.selectChoice("loop"))}>
      <Text>Run bounded loop</Text>
    </Focusable>
    <Focusable class="absolute left-[8] top-[512] w-[304] h-[48] bg-[#273B44]" onPress={() => invoke(() => engine.selectChoice("safe"))}>
      <Text>Continue safely</Text>
    </Focusable>
  </Screen>;
}
mount(() => <App />);
`);

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8"));
    const artifacts: NativeArtifacts = {
      bytecodePath: built.bytecode,
      pakPath: built.pak,
      metadataPath: built.metadata,
      runtimeAbi: String(metadata.runtimeAbi),
    };
    session = new NativeSession(artifacts, { width: 320, height: 620 });

    let frame = await session.boot();
    assertPainted(frame, "Start");

    frame = await session.tap("Start", frame);
    assertPainted(frame, "active=root-before-call");
    assertPainted(frame, "line=ROOT BEFORE CALL");
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root"}');
    assertPainted(frame, "callStack=[]");

    frame = await session.tap("Continue", frame);
    assertPainted(frame, "active=outer-before-call");
    assertPainted(frame, "line=OUTER BEFORE INNER CALL");
    assertPainted(frame, 'callStack=[{"returnTo":{"label":"start","index":3}}]');
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root>outer"}');

    frame = await session.tap("Continue", frame);
    assertPainted(frame, "active=inner-return-point");
    assertPainted(frame, "line=INNER RETURN POINT");
    assertPainted(frame, 'callStack=[{"returnTo":{"label":"start","index":3}},{"returnTo":{"label":"outer","index":3}}]');
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root>outer>inner"}');

    frame = await session.tap("Continue", frame);
    assertPainted(frame, "active=outer-after-return");
    assertPainted(frame, "line=OUTER RESUMED AFTER INNER RETURN");
    assertPainted(frame, 'callStack=[{"returnTo":{"label":"start","index":3}}]');
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root>outer>inner>inner-returned"}');

    frame = await session.tap("Continue", frame);
    assertPainted(frame, "active=root-after-return");
    assertPainted(frame, "line=ROOT AFTER RETURN");
    assertPainted(frame, "callStack=[]");
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root>outer>inner>inner-returned>outer-returned"}');

    frame = await session.tap("Continue", frame);
    assertPainted(frame, "active=root-recovery-choice");
    assertPainted(frame, "Run bounded loop");
    assertPainted(frame, "Continue safely");
    const beforeFailedTransaction = textOf(frame);

    frame = await session.tap("Run bounded loop", frame);
    assertPainted(frame, "diagnostic=StepBudgetExceededError: Story execution exceeded its 32-step budget");
    assertPainted(frame, "active=root-recovery-choice");
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root>outer>inner>inner-returned>outer-returned"}');
    assert.ok(!textOf(frame).includes('"loopCount":1'), "loop writes are rolled back with the failed choice transaction");
    assert.ok(beforeFailedTransaction.includes("Continue safely"), "the recovery control was painted before the failed transaction");

    frame = await session.tap("Continue safely", frame);
    assertPainted(frame, "active=safe-after-error");
    assertPainted(frame, "line=SAFE ACTION AFTER ROLLBACK");
    assertPainted(frame, "diagnostic=");
    assertPainted(frame, 'variables={"loopCount":0,"trace":"root>outer>inner>inner-returned>outer-returned>safe"}');

    console.log("novel_control_flow_native: " + JSON.stringify({
      bytecodeSha256: sha256(built.bytecode),
      pakSha256: sha256(built.pak),
      runtimeAbi: artifacts.runtimeAbi,
      toolsRoot,
      compilerSha256: sha256(compiler),
      probeSha256: sha256(probe),
      callStackDepths: [0, 1, 2, 1, 0],
      loopStepBudget: 32,
      recovered: includes(frame, "SAFE ACTION AFTER ROLLBACK"),
    }));
  } finally {
    await session?.quit();
    if (priorProbe === undefined) delete process.env.POCKET_NATIVE_PROBE; else process.env.POCKET_NATIVE_PROBE = priorProbe;
    if (priorTools === undefined) delete process.env.POCKET_TOOLS_PACKAGE; else process.env.POCKET_TOOLS_PACKAGE = priorTools;
    rmSync(project, { recursive: true, force: true });
  }
});
