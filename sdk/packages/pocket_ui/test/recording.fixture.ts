import { strict as assert } from "node:assert";
import { mock } from "bun:test";

// These are the real pinned PocketJS modules.  The SDK source uses the
// consumer-facing @pocketjs aliases; mock.module only supplies the package
// aliases for this isolated Bun fixture, it does not copy the implementation.
const clock = await import("../../../.cache/pocketjs/framework/src/clock.ts");
const effects = await import("../../../.cache/pocketjs/framework/src/effects.ts");
const devtools = await import("../../../.cache/pocketjs/framework/src/devtools.ts");
mock.module("@pocketjs/framework/clock", () => clock);
mock.module("@pocketjs/framework/effects", () => effects);
mock.module("@pocketjs/framework/devtools", () => devtools);

const g = globalThis as Record<string, unknown>;
delete g.TextEncoder;
const recording = await import("../src/recording.ts");

function reset(): void {
  g.__simHz = 60;
  delete g.__pocketEffectDriver;
  delete g.__pocketEffectTrace;
  devtools.initDevtools({} as never);
  clock.resetClock();
  effects.resetEffects();
}

async function recordAndReplay(): Promise<void> {
  reset();
  const callbacks: Array<(value: unknown) => void> = [];
  const recorder = recording.installEffectRecordingDriver((_command, deliver) => {
    callbacks.push(deliver);
  });
  clock.__advanceClock(); // upstream frame 0
  effects.runEffect("lookup", { key: "coffee", count: 1 }, () => {});
  assert.equal(callbacks.length, 1);
  callbacks[0]!({ value: "latte" });
  clock.__advanceClock(); // frame 1
  effects.__drainEffects(); // actual upstream delivery frame
  const effectTape = recorder.finish();
  assert.equal(effectTape.entries[0]?.status, "delivered");
  assert.equal(effectTape.entries[0]?.deliveryFrame, 1);
  assert.equal(effectTape.entries[0]?.paramsJSON, '{"key":"coffee","count":1}');
  assert.equal(effectTape.entries[0]?.resultJSON, '{"value":"latte"}');
  assert.equal(recorder.firstMismatch, undefined);
  recorder.dispose();

  reset();
  const replay = recording.createEffectReplayDriver(effectTape);
  clock.__advanceClock(); // frame 0; command must match the recording
  const seen: unknown[] = [];
  effects.runEffect("lookup", { key: "coffee", count: 1 }, (value) => seen.push(value));
  clock.__advanceClock(); // frame 1; upstream after() invokes the replay delivery
  effects.__drainEffects();
  replay.assertComplete();
  assert.deepEqual(seen, [{ value: "latte" }]);
  replay.dispose();
}

function strictValidation(): void {
  assert.throws(
    () => recording.validateInputTape({ v: 1, frames: 2, masks: [[0, 1]] }),
    recording.RecordingValidationError,
  );
  assert.throws(
    () => recording.validateEffectTape({ v: 1, entries: [{ index: 0, id: 1, kind: "x", commandFrame: 0, paramsJSON: "{}", status: "delivered" }] }),
    recording.RecordingValidationError,
  );
  assert.throws(
    () => recording.validateEffectTape({
      v: 1,
      entries: [{ index: 0, id: 1, kind: "x", commandFrame: 0, paramsJSON: "{}", paramsUndefined: true, status: "pending" }],
    }),
    recording.RecordingValidationError,
  );
  assert.throws(
    () => recording.validateEffectTape({
      v: 1,
      entries: [{ index: 0, id: 1, kind: "x", commandFrame: 0, paramsJSON: "{}", status: "delivered", deliveryFrame: 1, resultJSON: "1", error: { name: "E", message: "bad" } }],
    }),
    recording.RecordingValidationError,
  );
  assert.throws(
    () => recording.validateEffectTape({
      v: 1,
      entries: [
        { index: 0, id: 1, kind: "x", commandFrame: 0, paramsJSON: "{}", status: "thrown", error: { name: "E", message: "bad" } },
        { index: 1, id: 1, kind: "y", commandFrame: 1, paramsJSON: "{}", status: "thrown", error: { name: "E", message: "bad" } },
      ],
    }),
    recording.RecordingValidationError,
  );
  assert.throws(
    () => recording.validateInputTape({
      v: 5,
      frames: 1,
      masks: [[0, 1]],
      motion: [[0, { timestamp: 0, screenRotation: { value: "bad", quality: 999 } }]],
    }),
    recording.RecordingValidationError,
  );
}

function exportRecordingFromUpstream(): void {
  reset();
  const liveFrame = devtools.wrapFrameHandler(() => {});
  liveFrame(7);
  recording.setBuildMetadata({ app: "fixture", runtimeAbi: "abi-fixture" });
  const exported = recording.exportRecording();
  assert.equal(exported.tape.frames, 1);
  assert.deepEqual(exported.tape.masks, [[7, 1]]);
  assert.equal(Object.hasOwn(exported.tape, "app"), false, "legal upstream app:undefined is normalized");
  assert.equal(exported.build.runtimeAbi, "abi-fixture");
  delete g.__pocketDevtools;
}

function upstreamTapeCaptureAndReplay(): void {
  reset();
  const live: number[] = [];
  const liveFrame = devtools.wrapFrameHandler((buttons) => live.push(buttons));
  liveFrame(11);
  const captured = recording.captureUpstreamTape();
  assert.equal(captured.frames, 1);
  assert.deepEqual(captured.masks, [[11, 1]]);
  assert.equal(Object.hasOwn(captured, "app"), false);

  reset();
  const replayed: number[] = [];
  const replayFrame = devtools.wrapFrameHandler((buttons) => replayed.push(buttons));
  recording.replayInputTape(captured);
  replayFrame(99);
  assert.deepEqual(replayed, [11], "replay must be driven by the real upstream devtools shim");
}

function boundedMismatchDiagnostics(): void {
  reset();
  const callbacks: Array<(value: unknown) => void> = [];
  const recorder = recording.installEffectRecordingDriver((_command, deliver) => callbacks.push(deliver), {
    maxMismatchEntries: 2,
    maxMismatchBytes: recording.DEFAULT_EFFECT_MAX_MISMATCH_BYTES,
  });
  clock.__advanceClock();
  for (let index = 0; index < 4; index++) effects.runEffect("late", { index }, () => {});
  const snapshot = recorder.finish();
  assert.equal(snapshot.incomplete, true);
  assert.equal(snapshot.mismatches?.length, 2, "one slot is reserved for the fixed truncation sentinel");
  assert.equal(snapshot.mismatches?.at(-1)?.message, "effect mismatch diagnostics truncated");
  assert.ok((snapshot.mismatchBytes ?? 0) <= recording.DEFAULT_EFFECT_MAX_MISMATCH_BYTES);
  const mismatchCount = snapshot.mismatches?.length;
  for (const callback of callbacks) callback({ late: true });
  assert.equal(recorder.mismatches.length, mismatchCount, "late mismatches cannot grow diagnostics after truncation");
  assert.throws(() => recording.validateEffectTape(snapshot), recording.RecordingValidationError);
  recorder.dispose();
}

await recordAndReplay();
strictValidation();
upstreamTapeCaptureAndReplay();
boundedMismatchDiagnostics();
exportRecordingFromUpstream();
console.log("RECORDING_FIXTURE_OK");
