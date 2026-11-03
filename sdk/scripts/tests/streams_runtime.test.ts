import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repositoryRoot, "sdk");

type JsonObject = Record<string, unknown>;
type ProbeResponse = {
  ok?: boolean;
  error?: string;
  frame?: Frame;
};
type Frame = {
  events?: FrameEvent[];
  ops?: DrawOp[];
};
type FrameEvent = {
  name?: string;
  payload?: JsonObject;
};
type DrawOp = {
  type?: string;
  text?: string;
};

function nativeProbePath(): string | undefined {
  const configured = process.env.POCKET_NATIVE_PROBE;
  const candidates = configured
    ? [resolve(configured)]
    : [
        join(
          sdkRoot,
          "native/target/aarch64-apple-darwin/release/pocket_probe",
        ),
        join(sdkRoot, "native/target/release/pocket_probe"),
        join(sdkRoot, "native/target/debug/pocket_probe"),
      ];
  return candidates.find(existsSync);
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  return responses.flatMap((response) =>
    response.frame === undefined ? [] : [response.frame],
  );
}

function frameEvents(frame: Frame, name: string): FrameEvent[] {
  return (frame.events ?? []).filter((event) => event.name === name);
}

function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter(
      (op): op is DrawOp & { text: string } =>
        op.type === "text" && typeof op.text === "string",
    )
    .map((op) => op.text)
    .join("\n");
}

function sendEvent(name: string, payload: JsonObject = {}): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function runProbe(probe: string, commands: JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`,
  );
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeResponse);
}

function fixtureSource(): string {
  return `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Screen, Text, View } from "@pocketjs/framework/solid/components";
import { createHostBridge } from "@pocket/ui/host";
import { createPlatformExperience } from "@pocket/ui/platform-experience";
import { createPocketStreamAdapter } from "@pocket/ui/streams";

const host = createHostBridge();
const streams = createPocketStreamAdapter(host, {
  idPrefix: "fixture-stream",
  maxActiveStreams: 8,
  maxBufferedMessages: 4,
});
const experience = createPlatformExperience(host);
const [sampleCount, setSampleCount] = createSignal(0);
const [lastSample, setLastSample] = createSignal("none");
const [streamError, setStreamError] = createSignal("none");
const [remoteCancel, setRemoteCancel] = createSignal("none");
const [linkResult, setLinkResult] = createSignal("pending");
const [ready, setReady] = createSignal("boot");

const dataStream = streams.open("fixture.samples", {}, { id: "fixture-stream-data" });
const errorStream = streams.open("fixture.errors", {}, { id: "fixture-stream-error" });
const cancelStream = streams.open("fixture.cancels", {}, { id: "fixture-stream-cancel" });

dataStream.onData((value) => {
  setSampleCount((count) => count + 1);
  setLastSample(JSON.stringify(value));
  setReady("data");
});
errorStream.onError((error) => {
  setStreamError(error.code + ":" + error.message);
  setReady("error");
});
cancelStream.onEnd((close) => {
  setRemoteCancel(close.error?.code ?? close.state);
  // This is the fixture's leave path: a remote cancellation tears down the
  // still-open guest stream and must emit the canonical stream.cancel packet.
  dataStream.cancel("fixture_leave");
  setReady("cancel");
});

void experience.links.initial().then(
  () => setLinkResult("unexpected_success"),
  (error) => setLinkResult(error.code + ":" + error.message),
);

mount(() => (
  <Screen class="flex-col gap-2 p-4">
    <View class="flex-col gap-1">
      <Text>streams-runtime-fixture</Text>
      <Text>ready={ready()}</Text>
      <Text>samples={sampleCount()}</Text>
      <Text>last={lastSample()}</Text>
      <Text>error={streamError()}</Text>
      <Text>cancel={remoteCancel()}</Text>
      <Text>link={linkResult()}</Text>
    </View>
  </Screen>
));
`;
}

test(
  "buildGuest bytecode drives Pocket stream packets through the native probe",
  async () => {
    const probe = nativeProbePath();
    assert.ok(
      probe,
      "a bytecode-capable pocket_probe is required; build sdk/native/target/{debug,release}/pocket_probe or set POCKET_NATIVE_PROBE",
    );

    const project = mkdtempSync(join(tmpdir(), "pocket-stream-runtime-"));
    const output = join(project, "out");
    try {
      writeFileSync(
        join(project, "pocket.json"),
        JSON.stringify({
          pocket: 2,
          id: "fixture.stream.runtime",
          app: {
            entry: "app.tsx",
            framework: "solid",
            viewport: {
              fixed: { logical: [390, 780], presentation: "native" },
            },
          },
        }),
      );
      writeFileSync(
        join(project, "manifest.json"),
        JSON.stringify({
          pocket: 2,
          id: "fixture.stream.runtime",
          capabilities: { requires: [], optional: [] },
        }),
      );
      writeFileSync(join(project, "app.tsx"), fixtureSource());

      const built = await buildGuest({ projectRoot: project, outDir: output });
      const metadata = JSON.parse(
        readFileSync(built.metadata, "utf8"),
      ) as JsonObject;
      assert.equal(metadata.entryFormat, "quickjs-bytecode");
      assert.equal(metadata.kind, "script");
      assert.ok(existsSync(built.bytecode));
      assert.ok(existsSync(built.pak));

      const baseCommands: JsonObject[] = [
        {
          op: "create",
          width: 390,
          height: 780,
        },
        {
          op: "loadBytecode",
          bytecodePath: built.bytecode,
          pakPath: built.pak,
        },
        { op: "frame", deltaMs: 16 },
      ];
      const initialResponses = runProbe(probe, [
        ...baseCommands,
        { op: "quit" },
      ]);
      const initialFrames = framesOf(initialResponses);
      assert.ok(initialFrames.length > 0, "fixture must draw an initial frame");
      const linkRequest = initialFrames
        .flatMap((frame) => frameEvents(frame, "host.request"))
        .find(
          (event) => event.payload?.capability === "platform.links.initial",
        );
      assert.equal(
        typeof linkRequest?.payload?.requestId,
        "string",
        "fixture must issue the real optional-link request",
      );
      const linkRequestId = linkRequest!.payload!.requestId as string;
      const initialText = textOf(initialFrames.at(-1)!);
      assert.match(initialText, /streams-runtime-fixture/);
      assert.match(initialText, /samples=0/);
      assert.match(initialText, /link=pending/);

      const scenarioResponses = runProbe(probe, [
        ...baseCommands,
        // Keep the runtime idle for multiple guest frames before delivering
        // the response. The next frame must wake the promise-driven state.
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        sendEvent("stream.data", {
          streamId: "fixture-stream-data",
          data: { value: 7 },
        }),
        sendEvent("stream.data", {
          streamId: "fixture-stream-data",
          data: { value: 7 },
        }),
        sendEvent("stream.error", {
          streamId: "fixture-stream-error",
          error: {
            code: "provider_failed",
            message: "fixture provider stopped",
          },
        }),
        sendEvent("stream.cancel", {
          streamId: "fixture-stream-cancel",
          reason: "capability_unavailable",
        }),
        sendEvent("host.response", {
          requestId: linkRequestId,
          capability: "platform.links.initial",
          ok: false,
          error: {
            code: "capability_unavailable",
            message: "links are disabled",
          },
        }),
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ]);
      const scenarioFrames = framesOf(scenarioResponses);
      assert.ok(
        scenarioFrames.length >= 4,
        "fixture must produce idle and response frames",
      );
      const finalFrame = scenarioFrames.at(-1)!;
      const finalText = textOf(finalFrame);
      assert.match(finalText, /ready=cancel/);
      assert.match(
        finalText,
        /samples=2/,
        "identical stream.data events must both reach JS",
      );
      assert.match(finalText, /last=\{\"value\":7\}/);
      assert.match(finalText, /error=provider_failed:fixture provider stopped/);
      assert.match(finalText, /cancel=capability_unavailable/);
      assert.match(finalText, /link=capability_unavailable:links are disabled/);

      const outboundCancels = scenarioFrames
        .flatMap((frame) => frameEvents(frame, "stream.cancel"))
        .filter((event) => event.payload?.streamId === "fixture-stream-data");
      assert.ok(
        outboundCancels.some(
          (event) => event.payload?.reason === "fixture_leave",
        ),
        "remote cancel must drive the guest leave cancellation upstream",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
