import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

type JsonObject = Record<string, unknown>;
type DrawClip = { x?: number; y?: number; w?: number; h?: number };
type DrawOp = JsonObject & {
  type?: string;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  clip?: DrawClip;
};
type FrameEvent = { name?: string; payload?: JsonObject };
type Frame = { ops?: DrawOp[]; events?: FrameEvent[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

const TEST_TIMEOUT_MS = 180_000;

function event(name: string, payload: JsonObject): JsonObject {
  return { op: "send", message: { type: "event", name, payload } };
}

function scrollEvent(
  point: { x: number; y: number },
  deltaY: number,
  phase: "start" | "update" | "end",
  source: "wheel" | "trackpad",
): JsonObject {
  return event("input.scroll", {
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY: phase === "update" ? deltaY : 0,
    phase,
    source,
  });
}

function scroll(point: { x: number; y: number }, deltaY: number, source: "wheel" | "trackpad"): JsonObject[] {
  return [
    scrollEvent(point, 0, "start", source),
    scrollEvent(point, deltaY, "update", source),
    scrollEvent(point, 0, "end", source),
  ];
}

function pointer(phase: "down" | "move" | "up", point: { x: number; y: number }): JsonObject {
  return event("input.pointer", { phase, id: 0, x: point.x, y: point.y });
}

function runProbe(probe: string, commands: readonly JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function framesOf(responses: readonly ProbeResponse[]): Frame[] {
  return responses.flatMap((response) => response.frame ? [response.frame] : []);
}

function textOp(frame: Frame, label: string): DrawOp {
  const op = (frame.ops ?? []).find((entry) => entry.type === "text" && entry.text === label);
  assert.ok(op, `frame is missing text ${label}`);
  return op;
}

function textY(frame: Frame, label: string): number {
  const y = textOp(frame, label).y;
  assert.equal(typeof y, "number", `${label} DrawOp must expose y`);
  return y!;
}

function hasText(frame: Frame, label: string): boolean {
  return (frame.ops ?? []).some((entry) => entry.type === "text" && entry.text === label);
}

function center(frame: Frame, label: string): { x: number; y: number } {
  const op = textOp(frame, label);
  assert.equal(typeof op.x, "number", `${label} DrawOp must expose x`);
  assert.equal(typeof op.y, "number", `${label} DrawOp must expose y`);
  assert.equal(typeof op.w, "number", `${label} DrawOp must expose w`);
  assert.equal(typeof op.h, "number", `${label} DrawOp must expose h`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

function clipOf(frame: Frame, label: string): DrawClip {
  const clip = textOp(frame, label).clip;
  assert.ok(clip, `${label} DrawOp must retain the page clip`);
  for (const key of ["x", "y", "w", "h"] as const) {
    assert.equal(typeof clip![key], "number", `${label} page clip must expose ${key}`);
  }
  return clip!;
}

function fixtureSource(): string {
  return `
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { FocusScope, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { ActionButton, InputField, ScrollablePage, deliverTextInputEvent } from "@pocket/ui";

const bridge = globalThis as typeof globalThis & {
  __pocketEvent?: (packet: Record<string, unknown>) => void;
};

function App() {
  const [clicks, setClicks] = createSignal(0);
  const [touchClicks, setTouchClicks] = createSignal(0);
  const [draft, setDraft] = createSignal("");
  const rows = Array.from({ length: 18 }, (_, index) => index);
  const nestedRows = Array.from({ length: 18 }, (_, index) => index);

  onMount(() => {
    const previous = bridge.__pocketEvent;
    const receive = (packet: Record<string, unknown>): void => {
      const method = typeof packet.method === "string"
        ? packet.method
        : typeof packet.name === "string" ? packet.name : "";
      const params = packet.params ?? packet.payload;
      if (params && typeof params === "object" && !Array.isArray(params)) {
        deliverTextInputEvent(method, params as any);
      }
      previous?.(packet);
    };
    bridge.__pocketEvent = receive;
    onCleanup(() => {
      if (bridge.__pocketEvent === receive) bridge.__pocketEvent = previous;
    });
  });

  return (
    <Screen class="w-full h-full flex-col bg-white">
      <View class="flex-col w-full h-full gap-2 p-2">
        <Text>outside-scroll-zone</Text>
        <Text>clicks={clicks()} touch-clicks={touchClicks()}</Text>
        <ScrollablePage class="w-full overflow-hidden shrink-0" style={{ height: 128 }}>
          <FocusScope class="flex-col gap-2 p-2" autoFocus restoreFocus={false}>
            <ActionButton label="wheel-focus-target" onPress={() => setClicks((value) => value + 1)} />
            <InputField value={draft} onInput={setDraft} placeholder="Tap to type" />
            <Text>upper-row-0</Text>
            <For each={rows}>{(index) => <Text>upper-row-{index}</Text>}</For>
          </FocusScope>
        </ScrollablePage>
        <Text>between-scroll-zones</Text>
        <ScrollablePage class="w-full overflow-hidden shrink-0" style={{ height: 128 }}>
          <View class="flex-col gap-2 p-2">
            <ActionButton label="lower-touch-target" onPress={() => setTouchClicks((value) => value + 1)} />
            <Text>lower-row-0</Text>
            <For each={rows}>{(index) => <Text>lower-row-{index}</Text>}</For>
          </View>
        </ScrollablePage>
        <Text>nested-sibling-zone</Text>
        <ScrollablePage class="w-full overflow-hidden shrink-0" style={{ height: 224 }}>
          <View class="flex-col gap-2 p-2">
            <Text>nested-parent-top</Text>
            <ScrollablePage class="w-full overflow-hidden shrink-0" style={{ height: 80 }}>
              <View class="relative w-full h-[160]" style={{ height: 160 }}>
                <Text class="absolute top-[40]">nested-child-hit</Text>
                <Text class="absolute top-[140]">nested-child-end</Text>
              </View>
            </ScrollablePage>
            <Text>nested-parent-after-child</Text>
            <For each={nestedRows}>{(index) => <Text>nested-parent-row-{index}</Text>}</For>
          </View>
        </ScrollablePage>
        <Text>outside-footer</Text>
      </View>
    </Screen>
  );
}

mount(() => <App />);
`;
}

test("desktop wheel and trackpad events scroll only their viewport without breaking touch, focus, or IME", async () => {
  const probe = process.env.POCKET_NATIVE_PROBE;
  assert.ok(probe && existsSync(probe), "set POCKET_NATIVE_PROBE to the pinned bytecode-capable pocket_probe");

  const project = mkdtempSync(join(tmpdir(), "pocket-desktop-scroll-"));
  try {
    writeFileSync(join(project, "pocket.json"), JSON.stringify({
      pocket: 2,
      id: "fixture.desktop-scroll",
      app: { entry: "app.tsx", framework: "solid" },
    }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({
      pocket: 2,
      id: "fixture.desktop-scroll",
      capabilities: { requires: [], optional: [] },
    }));
    writeFileSync(join(project, "app.tsx"), fixtureSource());

    const built = await buildGuest({ projectRoot: project, outDir: join(project, "out") });
    const metadata = JSON.parse(readFileSync(built.metadata, "utf8")) as JsonObject;
    assert.equal(metadata.entryFormat, "quickjs-bytecode", "acceptance must boot pinned QJBC");
    assert.ok(existsSync(built.bytecode), "buildGuest must emit guest bytecode");
    assert.ok(existsSync(built.pak), "buildGuest must emit the fixture PAK");

    const bootstrap: JsonObject[] = [
      { op: "create", width: 360, height: 720 },
      { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
    ];
    const initialResponses = runProbe(probe, [...bootstrap, { op: "quit" }]);
    const initialFrames = framesOf(initialResponses);
    const initial = initialFrames.at(-1);
    assert.ok(initial, "native probe must execute and render the built guest");

    const wheelTarget = center(initial!, "wheel-focus-target");
    const outsidePoint = center(initial!, "outside-scroll-zone");
    const lowerTarget = center(initial!, "lower-touch-target");
    const initialLower = textOp(initial!, "lower-row-0");
    const initialUpperClip = clipOf(initial!, "upper-row-0");
    const initialLowerClip = clipOf(initial!, "lower-row-0");
    const inputCenter = center(initial!, "Tap to type");

    const nestedParent = textY(initial!, "nested-parent-after-child");
    const nestedHit = center(initial!, "nested-child-hit");
    const nestedTop = textY(initial!, "nested-parent-top") - 8;
    const nestedResponses = runProbe(probe, [
      ...bootstrap,
      ...scroll(center(initial!, "nested-parent-after-child"), 72, "wheel"),
      { op: "frame", deltaMs: 16 },                    // frame 3: child clipped to 40 of its 80px viewport
      ...scroll({ x: nestedHit.x, y: nestedTop - 20 }, 20, "wheel"),
      { op: "frame", deltaMs: 16 },                    // frame 4: outside the visible child intersection
      ...scroll({ x: nestedHit.x, y: nestedHit.y - 72 }, 100, "wheel"),
      { op: "frame", deltaMs: 16 },                    // frame 5: child reaches its 80px extent, remainder chains to parent
      { op: "quit" },
    ]);
    assert.ok(!nestedResponses.some((response) => response.error), `nested native probe error: ${JSON.stringify(nestedResponses.filter((response) => response.error))}`);
    const nestedFrames = framesOf(nestedResponses);
    const nestedInitial = nestedFrames[2]!;
    const afterParentClip = nestedFrames[3]!;
    const afterClippedHit = nestedFrames[4]!;
    const afterNestedEnd = nestedFrames[5]!;
    const childPartialClip = clipOf(afterParentClip, "nested-child-hit");
    assert.ok(childPartialClip.h !== undefined && Math.abs(childPartialClip.h - 40) <= 1, `nested child should be clipped to the visible 40px intersection, got ${JSON.stringify(childPartialClip)}`);
    assert.ok(Math.abs(textY(afterParentClip, "nested-parent-after-child") - nestedParent + 72) <= 1, "wheel over parent content must scroll the parent around the nested child");
    assert.equal(textY(afterClippedHit, "nested-parent-after-child"), textY(afterParentClip, "nested-parent-after-child"), "wheel outside the 40px visible child intersection must be ignored");
    assert.equal(textY(afterClippedHit, "nested-child-hit"), textY(afterParentClip, "nested-child-hit"), "clipped child coordinates must not reach its hidden portion");
    assert.equal(textY(afterNestedEnd, "nested-parent-after-child"), textY(afterClippedHit, "nested-parent-after-child") - 20, "the 20px remainder after the child's true max must reach the parent");
    const childEnd = textOp(afterNestedEnd, "nested-child-end");
    const childEndClip = clipOf(afterNestedEnd, "nested-child-end");
    assert.ok(childEnd.y !== undefined && childEnd.h !== undefined && childEndClip.y !== undefined && childEndClip.h !== undefined, "nested child end sentinel must expose its real painted geometry");
    const endGap = childEndClip.y! + childEndClip.h! - (childEnd.y! + childEnd.h!);
    assert.ok(endGap >= -1 && endGap <= 8, `nested child should end at contentHeight - 80 without empty clipped space; end gap=${endGap}, op=${JSON.stringify(childEnd)}, clip=${JSON.stringify(childEndClip)}`);
    assert.equal(textY(afterNestedEnd, "upper-row-0"), textY(nestedInitial, "upper-row-0"), "nested remainder must not move the upper sibling page");
    assert.equal(textY(afterNestedEnd, "lower-row-0"), textY(nestedInitial, "lower-row-0"), "nested remainder must not move the lower sibling page");
    console.log(`desktop_scroll_guest nested evidence: childClip=${JSON.stringify(childPartialClip)} parentRemainder=20 childEndGap=${endGap} childEndY=${childEnd.y} childEndClipBottom=${childEndClip.y! + childEndClip.h!}`);

    // Frame indexes below follow the emitted probe frames. Keep the focused
    // first control under the wheel so its normal focus visibility path is
    // exercised while the page moves away from it.
    const topWheelDelta = 48;
    const commands: JsonObject[] = [
      ...bootstrap,
      ...scroll(wheelTarget, topWheelDelta, "wheel"),
      { op: "frame", deltaMs: 16 },                    // frame 3: upper wheel
      ...scroll(outsidePoint, 32, "wheel"),
      { op: "frame", deltaMs: 16 },                    // frame 4: outside viewport
      scrollEvent(wheelTarget, 24, "update", "trackpad"),
      { op: "frame", deltaMs: 16 },                    // frame 5: trackpad update without start
      scrollEvent(outsidePoint, 0, "start", "trackpad"),
      scrollEvent(lowerTarget, 24, "update", "trackpad"),
      scrollEvent(lowerTarget, 0, "end", "trackpad"),
      { op: "frame", deltaMs: 16 },                    // frame 6: start outside must not acquire lower page
      scrollEvent(lowerTarget, 0, "start", "trackpad"),
      scrollEvent(lowerTarget, 24, "update", "trackpad"),
      scrollEvent(lowerTarget, 0, "end", "trackpad"),
      { op: "frame", deltaMs: 16 },                    // frame 7: captured lower-page trackpad
      scrollEvent(lowerTarget, 24, "update", "trackpad"),
      { op: "frame", deltaMs: 16 },                    // frame 8: end must clear captured target
      pointer("down", { x: lowerTarget.x, y: lowerTarget.y - 24 }),
      { op: "frame", deltaMs: 16 },
      pointer("move", { x: lowerTarget.x, y: lowerTarget.y - 38 }),
      { op: "frame", deltaMs: 16 },
      pointer("up", { x: lowerTarget.x, y: lowerTarget.y - 38 }),
      { op: "frame", deltaMs: 16 },                    // frame 11: touch pan
      pointer("down", { x: inputCenter.x, y: inputCenter.y - topWheelDelta }),
      { op: "frame", deltaMs: 16 },
      pointer("up", { x: inputCenter.x, y: inputCenter.y - topWheelDelta }),
      { op: "frame", deltaMs: 16 },                    // frame 13: input opened
      event("textInput.opened", {
        id: "guest-text-input-1",
        editingSession: "guest-text-input-1:1",
        revision: 0,
        jsRevision: 1,
      }),
      { op: "frame", deltaMs: 16 },                    // frame 14: native attach ACK
      event("textInput.edit", {
        id: "guest-text-input-1",
        editingSession: "guest-text-input-1:1",
        text: "wheel IME value",
        selectionBase: 15,
        selectionExtent: 15,
        composingBase: -1,
        composingExtent: -1,
        revision: 1,
        jsRevision: 1,
      }),
      { op: "frame", deltaMs: 16 },                    // frame 15: native text edit
      ...scroll({ x: inputCenter.x, y: inputCenter.y - topWheelDelta }, 4, "wheel"),
      { op: "frame", deltaMs: 16 },                    // frame 16: input remains inside its viewport
      event("textInput.dismiss", {
        id: "guest-text-input-1",
        editingSession: "guest-text-input-1:1",
        text: "wheel IME value",
        selectionBase: 15,
        selectionExtent: 15,
        composingBase: -1,
        composingExtent: -1,
        revision: 1,
        jsRevision: 1,
        reason: "outside",
      }),
      { op: "frame", deltaMs: 16 },                    // frame 17: Guest fallback restored
      { op: "quit" },
    ];
    const responses = runProbe(probe, commands);
    assert.ok(!responses.some((response) => response.error), `native probe error: ${JSON.stringify(responses.filter((response) => response.error))}`);
    const frames = framesOf(responses);
    assert.ok(frames.length >= 18, `expected 18 actual Guest frames, received ${frames.length}`);
    const afterTopWheel = frames[3]!;
    const afterOutside = frames[4]!;
    const afterNoStartTrackpad = frames[5]!;
    const afterOutsideStartTrackpad = frames[6]!;
    const afterLowerTrackpad = frames[7]!;
    const afterEndTrackpad = frames[8]!;
    const afterTouch = frames[11]!;
    const afterInputTap = frames[13]!;
    const afterOpened = frames[14]!;
    const afterEdit = frames[15]!;
    const afterInputWheel = frames[16]!;
    const afterDismiss = frames[17]!;

    const upperY0 = textY(initial!, "upper-row-0");
    const upperY1 = textY(afterTopWheel, "upper-row-0");
    assert.ok(upperY1 < upperY0 - 30, `wheel must move content inside the upper page (${upperY0} -> ${upperY1})`);
    assert.deepEqual(clipOf(afterTopWheel, "upper-row-0"), initialUpperClip, "wheel should preserve the upper viewport clip");
    assert.equal(textY(afterTopWheel, "lower-row-0"), initialLower.y, "wheel over the upper page must leave the lower page still");
    assert.equal(textOp(afterTopWheel, "clicks=0 touch-clicks=0").text, "clicks=0 touch-clicks=0", "wheel over the focused button must not click it");

    assert.equal(textY(afterOutside, "upper-row-0"), upperY1, "wheel outside both scroll viewports must not change the upper offset");
    assert.equal(textY(afterOutside, "lower-row-0"), initialLower.y, "wheel outside both scroll viewports must not change the lower offset");
    assert.equal(textY(afterNoStartTrackpad, "upper-row-0"), upperY1, "trackpad update without start must be ignored");
    assert.equal(textY(afterNoStartTrackpad, "lower-row-0"), initialLower.y, "trackpad update without start must not acquire a target");
    assert.equal(textY(afterOutsideStartTrackpad, "lower-row-0"), initialLower.y, "trackpad start outside must not acquire a page when update moves inside");

    assert.ok(textY(afterTouch, "lower-row-0") < textY(afterEndTrackpad, "lower-row-0") - 4, "native pointer drag must keep the existing lower-page touch scroll");
    assert.equal(textOp(afterTouch, "clicks=0 touch-clicks=0").text, "clicks=0 touch-clicks=0", "touch pan over a focusable target must not trigger its click");
    const lowerAfterTrackpadY = textY(afterLowerTrackpad, "lower-row-0");
    assert.ok(lowerAfterTrackpadY < initialLower.y - 15, "trackpad input must scroll the selected lower viewport");
    assert.deepEqual(clipOf(afterLowerTrackpad, "lower-row-0"), initialLowerClip, "trackpad should preserve the lower viewport clip");
    assert.equal(textY(afterLowerTrackpad, "upper-row-0"), upperY1, "trackpad over the lower page must leave the upper page still");
    assert.equal(textY(afterEndTrackpad, "lower-row-0"), lowerAfterTrackpadY, "trackpad end must clear the target before a later update");
    assert.equal(textOp(afterLowerTrackpad, "clicks=0 touch-clicks=0").text, "clicks=0 touch-clicks=0", "wheel and touch must leave click counters untouched");

    const inputOpen = (afterInputTap.events ?? []).find((item) => item.name === "textInput.open" && item.payload?.id === "guest-text-input-1");
    assert.ok(inputOpen, "pointer tap must still open the focusable InputField after wheel movement");
    const inputOpenRect = inputOpen.payload?.rect as JsonObject | undefined;
    assert.ok(inputOpenRect && typeof inputOpenRect.y === "number", "textInput.open must retain its actual measured rect");
    const inputOpenClip = inputOpen.payload?.clip as JsonObject | undefined;
    const inputGuestClip = clipOf(afterInputTap, "Tap to type");
    const inputGuestText = textOp(afterInputTap, "Tap to type");
    const inputOpenTop = inputOpenRect?.y;
    const inputOpenHeight = inputOpenRect?.height;
    const inputClipTop = inputOpenClip?.y;
    const inputClipHeight = inputOpenClip?.height;
    assert.ok(inputOpenClip && typeof inputClipTop === "number" && typeof inputClipHeight === "number", "textInput.open must retain its visible viewport clip");
    assert.ok(typeof inputOpenTop === "number" && typeof inputOpenHeight === "number", "textInput.open must expose the complete field rectangle");
    const closeFrames = frames.flatMap((frame, index) =>
      (frame.events ?? []).filter((item) => item.name === "textInput.close" && item.payload?.id === "guest-text-input-1").map(() => index),
    );
    console.log(`desktop_scroll_guest IME geometry: rect=${JSON.stringify(inputOpenRect)} clip=${JSON.stringify(inputOpenClip)} painted=${JSON.stringify({ x: inputGuestText.x, y: inputGuestText.y, w: inputGuestText.w, h: inputGuestText.h, clip: inputGuestText.clip })} closeFrames=${JSON.stringify(closeFrames)}`);
    assert.deepEqual(
      inputOpenClip,
      { x: inputGuestClip.x, y: inputGuestClip.y, width: inputGuestClip.w, height: inputGuestClip.h },
      "IME clip must match the actual ScrollablePage that paints the focused fallback",
    );
    assert.ok(
      inputOpenTop >= inputClipTop && inputOpenTop + inputOpenHeight <= inputClipTop + inputClipHeight,
      `focused InputField must stay in its visible clip: rect=${JSON.stringify(inputOpenRect)} clip=${JSON.stringify(inputOpenClip)}`,
    );
    const attachAppearance = (afterOpened.events ?? []).find((item) => item.name === "textInput.update" && item.payload?.id === "guest-text-input-1");
    assert.ok(attachAppearance, "native opened acknowledgement must retain the existing IME appearance handoff");
    assert.equal(hasText(afterEdit, "wheel IME value"), false, "focused native text remains owned by the attached overlay");
    const inputCloses = frames.flatMap((frame) =>
      (frame.events ?? []).filter((item) => item.name === "textInput.close" && item.payload?.id === "guest-text-input-1"),
    );
    assert.equal(inputCloses.length, 0, `small wheel movement inside the actual input clip must preserve focus (rect=${JSON.stringify(inputOpenRect)} clip=${JSON.stringify(inputOpenClip)} close=${JSON.stringify(inputCloses)})`);
    assert.equal(textY(afterInputWheel, "upper-row-0"), textY(afterEdit, "upper-row-0") - 4, "an open IME must not pull the upper scroll offset back");
    assert.ok(textOp(afterDismiss, "wheel IME value"), "textInput.dismiss must restore the edited value to the Guest fallback");
    console.log(`desktop_scroll_guest frame evidence: upperWheelDelta=${upperY0 - upperY1} outsideDelta=${textY(afterOutside, "upper-row-0") - upperY1} lowerTrackpadDelta=${initialLower.y! - lowerAfterTrackpadY} touchPanDelta=${textY(afterEndTrackpad, "lower-row-0") - textY(afterTouch, "lower-row-0")} focusedWheelDelta=${textY(afterEdit, "upper-row-0") - textY(afterInputWheel, "upper-row-0")}`);

    console.log(`desktop_scroll_guest.test: QJBC wheel/trackpad, clipping, selected viewport, touch, focus and IME passed (${probe})`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);
