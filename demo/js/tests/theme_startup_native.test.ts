import { test } from "bun:test";
import { strict as assert } from "node:assert";
import {
  NativeSession,
  readNativeArtifacts,
  textOps,
  type Frame,
} from "./native_session.ts";

const width = 390;
const height = 844;
const darkCanvas = 0xff0e1728;
const lightCanvas = 0xfff5f6fa;

function rootColor(frame: Frame): number | undefined {
  const frameWidth = frame.width ?? width;
  const frameHeight = frame.height ?? height;
  return (frame.ops ?? []).find((op) =>
    op.type === "rect" && op.x === 0 && op.y === 0 && op.w === frameWidth && op.h === frameHeight,
  )?.color;
}

async function verifyRestoredFirstDraw(
  label: string,
  response: unknown,
  ok: boolean,
  expectedColor: number,
): Promise<void> {
  const session = new NativeSession(readNativeArtifacts("POCKET_THEME_STARTUP"), {
    width,
    height,
    deferCapabilities: ["platform.storage.get", "platform.systemUi.set", "system.runtime.configure"],
    deadlineMs: 30_000,
  });
  try {
    let frame = await session.boot();
    const appearanceRequest = session.requests.find((request) =>
      request.capability === "platform.storage.get" && request.params.key === "appearance",
    );
    assert.ok(appearanceRequest, `${label}: startup must request the saved appearance`);
    assert.ok(
      session.requests.some((request) => request.capability === "system.runtime.configure"),
      `${label}: the test must keep System runtime initialization pending`,
    );

    assert.equal(rootColor(frame), undefined, `${label}: no business canvas may draw while saved appearance is pending`);
    assert.equal(textOps(frame, "Made to feel native.").length, 0, `${label}: Home must stay hidden while saved appearance is pending`);
    assert.equal(
      session.requests.filter((request) => request.capability === "platform.systemUi.set").length,
      0,
      `${label}: default-light system UI must not be sent before saved appearance is restored`,
    );

    session.respondPending(
      "platform.storage.get",
      response,
      ok,
      (request) => request.requestId === appearanceRequest!.requestId,
    );

    let businessUiVisible = false;
    for (let index = 0; index < 30 && !businessUiVisible; index += 1) {
      frame = await session.frame();
      const color = rootColor(frame);
      if (color !== undefined) {
        assert.equal(color, expectedColor, `${label}: the first painted business canvas must use the restored theme`);
      }
      businessUiVisible = textOps(frame, "Made to feel native.").length > 0;
    }
    assert.ok(businessUiVisible, `${label}: Home must become visible after preference restore settles`);
    assert.equal(rootColor(frame), expectedColor, `${label}: visible Home must use its final theme`);

    // The unresolved systemUi.set request above is optional host work. It must
    // not hold the guest's first business draw behind a platform capability.
    assert.ok(
      session.requests.some((request) => request.capability === "platform.systemUi.set"),
      `${label}: final system UI should be requested after preference restoration`,
    );
  } finally {
    await session.quit();
  }
}

test("first visible root draw waits for saved dark/light theme and recovers when storage fails", { timeout: 120_000 }, async () => {
  await verifyRestoredFirstDraw(
    "saved dark theme",
    { version: 1, dark: true, accent: "blue", density: "auto" },
    true,
    darkCanvas,
  );
  await verifyRestoredFirstDraw(
    "saved light theme",
    { version: 1, dark: false, accent: "blue", density: "auto" },
    true,
    lightCanvas,
  );
  await verifyRestoredFirstDraw("storage error fallback", null, false, lightCanvas);
});
