import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  createHostBridge,
  type JsonObject,
  type JsonValue,
} from "../src/host.ts";
import {
  createPlatformExperience,
  isUnsupportedPlatformError,
} from "../src/platform-experience.ts";

type Packet = {
  name?: string;
  payload?: JsonObject;
};

function fixture(): {
  host: ReturnType<typeof createHostBridge>;
  packets: Packet[];
} {
  const packets: Packet[] = [];
  const host = createHostBridge((line) => {
    packets.push(JSON.parse(line) as Packet);
    return true;
  });
  return { host, packets };
}

function response(
  host: ReturnType<typeof createHostBridge>,
  packet: Packet,
  result: JsonValue,
): void {
  const requestId = packet.payload?.requestId;
  assert.equal(typeof requestId, "string");
  host.handle(
    JSON.stringify({
      type: "event",
      name: "host.response",
      payload: { requestId, ok: true, result },
    }),
  );
}

test("platform experience is lazy and uses fixed host capabilities", async () => {
  const { host, packets } = fixture();
  const experience = createPlatformExperience(host);
  try {
    assert.equal(
      packets.length,
      0,
      "links must not be collected at construction",
    );

    const initial = experience.initial<{ uri: string }>({ source: "test" });
    assert.equal(packets[0]?.name, "host.request");
    assert.equal(packets[0]?.payload?.capability, "platform.links.initial");
    response(host, packets[0]!, { uri: "pocket://initial" });
    assert.deepEqual(await initial, { uri: "pocket://initial" });

    const latest = experience.links.latest<{ uri: string }>();
    assert.equal(packets[1]?.payload?.capability, "platform.links.latest");
    response(host, packets[1]!, { uri: "pocket://latest" });
    assert.deepEqual(await latest, { uri: "pocket://latest" });

    const systemUi = experience.setSystemUi({
      mode: "dark",
      navigation: "edge-to-edge",
    });
    assert.equal(packets[2]?.payload?.capability, "platform.systemUi.set");
    response(host, packets[2]!, null);
    assert.equal(await systemUi, null);

    const haptic = experience.performHaptic({ kind: "selection" });
    assert.equal(packets[3]?.payload?.capability, "platform.haptics.perform");
    response(host, packets[3]!, { accepted: true });
    assert.deepEqual(await haptic, { accepted: true });
  } finally {
    experience.dispose();
    host.dispose();
  }
});

test("links are an explicit callback subscription with no route or app selection", () => {
  const { host, packets } = fixture();
  const experience = createPlatformExperience(host);
  try {
    const values: JsonValue[] = [];
    const subscription = experience.subscribeLinks(
      (value) => values.push(value),
      {
        params: { source: "explicit" },
      },
    );
    assert.equal(packets[0]?.name, "stream.open");
    assert.equal(packets[0]?.payload?.topic, "platform.links.events");
    assert.deepEqual(packets[0]?.payload?.params, { source: "explicit" });
    const streamId = packets[0]?.payload?.streamId;
    assert.equal(typeof streamId, "string");
    host.handle(
      JSON.stringify({
        type: "event",
        name: "stream.data",
        payload: { streamId, data: { uri: "pocket://event" } },
      }),
    );
    assert.deepEqual(values, [{ uri: "pocket://event" }]);
    subscription.unsubscribe();
    assert.equal(packets.at(-1)?.name, "stream.cancel");
    assert.equal(packets.at(-1)?.payload?.streamId, streamId);
  } finally {
    experience.dispose();
    host.dispose();
  }
});

test("unsupported optional capabilities remain distinguishable", async () => {
  const { host, packets } = fixture();
  const experience = createPlatformExperience(host);
  try {
    const request = experience.latest();
    const packet = packets[0]!;
    const requestId = packet.payload?.requestId;
    host.handle(
      JSON.stringify({
        type: "event",
        name: "host.response",
        payload: {
          requestId,
          ok: false,
          error: {
            code: "capability_unavailable",
            message: "Deep links are not configured",
          },
        },
      }),
    );
    await assert.rejects(request, (error: unknown) =>
      isUnsupportedPlatformError(error),
    );

    const subscription = experience.subscribeLinks(() => {});
    const streamId = packets[1]?.payload?.streamId;
    assert.equal(typeof streamId, "string");
    host.handle(
      JSON.stringify({
        type: "event",
        name: "stream.cancel",
        payload: { streamId, reason: "capability_unavailable" },
      }),
    );
    const closed = await subscription.stream.closed;
    assert.equal(closed.error?.code, "capability_unavailable");
    assert.equal(isUnsupportedPlatformError(closed.error), true);
  } finally {
    experience.dispose();
    host.dispose();
  }
});
