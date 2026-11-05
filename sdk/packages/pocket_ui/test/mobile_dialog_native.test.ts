import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = JsonObject & {
  type?: string;
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: number;
  asset?: string;
};
type Frame = { frame?: number; ops?: DrawOp[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame };

const testDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(testDir, "../../..");
const buildGuest = join(sdkRoot, "scripts/build_guest.ts");
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
      join(sdkRoot, "native/target/debug/pocket_probe"),
    ].find(existsSync);

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe!, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const outputText = String(result.stdout ?? "").trim();
  assert.ok(outputText, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return outputText.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function framesOf(responses: ProbeResponse[]): Frame[] {
  return responses.flatMap((response) => (response.frame ? [response.frame] : []));
}

function textOps(frame: Frame, label: string): DrawOp[] {
  return (frame.ops ?? []).filter((op) => op.type === "text" && op.text === label);
}

function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter((op) => op.type === "text" && typeof op.text === "string")
    .map((op) => op.text)
    .join("\n");
}

function centerPoint(frame: Frame, label: string): { x: number; y: number } {
  const matches = textOps(frame, label);
  assert.equal(matches.length, 1, `frame must contain exactly one ${label}: ${textOf(frame)}`);
  const op = matches[0]!;
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.y, "number", `${label} must expose y`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  assert.equal(typeof op.h, "number", `${label} must expose h`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

function tap(point: { x: number; y: number }, settleFrames = 0): JsonObject[] {
  return [
    { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: point.x, y: point.y } } },
    { op: "frame", deltaMs: 16 },
    { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: point.x, y: point.y } } },
    { op: "frame", deltaMs: 16 },
    ...Array.from({ length: settleFrames }, () => ({ op: "frame", deltaMs: 16 })),
  ];
}

function bootstrap(width: number, bytecodePath: string, pakPath: string): JsonObject[] {
  return [
    { op: "create", width, height: 640 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "frame", deltaMs: 16 },
  ];
}

function assertDialogContentFits(frame: Frame, width: number, labels: string[], name: string): void {
  const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
  const ops = labels.flatMap((label) => (frame.ops ?? []).filter((op) => op.type === "text" && normalize(String(op.text ?? "")) === normalize(label)));
  assert.equal(ops.length, labels.length, `${name} must expose each dialog label exactly once`);
  const left = Math.min(...ops.map((op) => Number(op.x)));
  const right = Math.max(...ops.map((op) => Number(op.x) + Number(op.w)));
  assert.ok(left >= -0.1, `${name} content starts outside the viewport: left=${left}, width=${width}`);
  assert.ok(right <= width + 0.1, `${name} content overflows the viewport: right=${right}, width=${width}`);
  assert.ok(Math.abs((left + right) / 2 - width / 2) <= 28, `${name} content is not safely centered: left=${left}, right=${right}, width=${width}`);
}

function assertEqualActionRow(frame: Frame, width: number, name: string): void {
  const cancel = textOps(frame, "Cancel")[0]!;
  const confirm = textOps(frame, "Confirm")[0]!;
  const title = textOps(frame, "DoubleTitle")[0]!;
  const cancelCenter = Number(cancel.x) + Number(cancel.w) / 2;
  const confirmCenter = Number(confirm.x) + Number(confirm.w) / 2;
  const midpoint = (cancelCenter + confirmCenter) / 2;
  assert.ok(Math.abs(midpoint - width / 2) <= 28, `${name} action row is not centered: midpoint=${midpoint}, width=${width}`);
  const expectedDistance = Number(title.w) / 2 + 4;
  assert.ok(Math.abs(confirmCenter - cancelCenter - expectedDistance) <= 8, `${name} actions are not equal-width cells: centers=${cancelCenter},${confirmCenter}, expected distance=${expectedDistance}`);
}

function assertCompactPanel(frame: Frame, width: number, name: string): void {
  const panels = (frame.ops ?? []).filter((op) => {
    if (op.type !== "rect") return false;
    const w = Number(op.w);
    const h = Number(op.h);
    const x = Number(op.x);
    return w >= 270 && w <= 292 && h >= 90 && h <= 120 && x >= -0.1 && x + w <= width + 0.1;
  });
  assert.ok(panels.some((op) => Math.abs(Number(op.x) + Number(op.w) / 2 - width / 2) <= 2), `${name} must use a centered compact panel near 280px: ${JSON.stringify(panels)}`);
}

function assertOpaque(frame: Frame, label: string): void {
  const op = textOps(frame, label)[0];
  assert.ok(op, `frame is missing ${label} for opacity check`);
  assert.equal(typeof op.color, "number", `${label} must expose native text color`);
  assert.equal((Number(op.color) >>> 24) & 0xff, 0xff, `${label} must settle at full opacity after the entrance frames`);
}

function alphaOf(op: DrawOp | undefined): number {
  assert.ok(op && typeof op.color === "number", `draw op must expose a color: ${JSON.stringify(op)}`);
  return (Number(op!.color) >>> 24) & 0xff;
}

function modalPanel(frame: Frame, width: number): DrawOp | undefined {
  const candidates = (frame.ops ?? []).filter((op) => {
    if (op.type !== "rect") return false;
    const x = Number(op.x);
    const y = Number(op.y);
    const w = Number(op.w);
    const h = Number(op.h);
    const center = x + w / 2;
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)
      && w >= 220 && w <= 300 && h >= 70 && h <= 220
      && Math.abs(center - width / 2) <= 8;
  });
  return candidates.sort((left, right) => Number(right.w) * Number(right.h) - Number(left.w) * Number(left.h))[0];
}

function modalBackdrops(frame: Frame, width: number, height: number): DrawOp[] {
  return (frame.ops ?? []).filter((op) => {
    if (op.type !== "rect") return false;
    const color = Number(op.color) >>> 0;
    const red = (color >>> 16) & 0xff;
    const green = (color >>> 8) & 0xff;
    const blue = color & 0xff;
    return Math.abs(Number(op.x)) <= 0.1 && Math.abs(Number(op.y)) <= 0.1
      && Math.abs(Number(op.w) - width) <= 0.1 && Math.abs(Number(op.h) - height) <= 0.1
      && typeof op.color === "number" && alphaOf(op) > 0
      // Ignore the light page/background fill; only the near-black default
      // Modal scrim is forbidden above the colorless glass surface.
      && red < 32 && green < 40 && blue < 64;
  });
}

function glassParameters(frame: Frame): JsonObject | undefined {
  const surface = (frame.ops ?? []).find((op) => op.type === "hostSurface" && typeof op.asset === "string");
  if (!surface || typeof surface.asset !== "string") return undefined;
  const descriptor = JSON.parse(surface.asset) as JsonObject;
  return descriptor.parameters as JsonObject | undefined;
}

function dialogTransitionFrames(frames: Frame[], width: number): Frame[] {
  // Native text ops with zero alpha are omitted while the panel is entering;
  // use the retained panel and blur surface as the transition anchors, then
  // assert the title separately on the settled frame.
  return frames.filter((frame) => glassParameters(frame) && modalPanel(frame, width));
}

function assertMonotonic(values: number[], direction: "up" | "down", name: string, tolerance = 0): void {
  assert.ok(values.length >= 2, `${name} must expose at least two transition samples: ${JSON.stringify(values)}`);
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if (direction === "up") assert.ok(current + tolerance >= previous, `${name} regressed at ${index}: ${values.join(",")}`);
    else assert.ok(current <= previous + tolerance, `${name} increased at ${index}: ${values.join(",")}`);
  }
}

function assertApproxThreeHundredMs(samples: Frame[], name: string): void {
  const firstFrame = Number(samples[0]?.frame);
  const lastFrame = Number(samples.at(-1)?.frame);
  assert.ok(Number.isFinite(firstFrame) && Number.isFinite(lastFrame), `${name} must expose probe frame ids`);
  const elapsedFrames = lastFrame - firstFrame;
  // pocket_probe runs the pinned 60 Hz simulation. Allow one frame at either
  // edge for the input edge and final teardown, while rejecting the old
  // 10/12-frame (<200 ms) motion.
  assert.ok(elapsedFrames >= 15 && elapsedFrames <= 22, `${name} must last about 300 ms at 60 Hz: ${elapsedFrames} frames`);
}

function assertDialogEntrance(frames: Frame[], width: number, height: number, title: string, name: string): void {
  const samples = dialogTransitionFrames(frames, width);
  assert.ok(frames.some((frame) => textOps(frame, title).length === 1), `${name} must expose its settled title`);
  assert.ok(samples.length >= 4, `${name} must expose several entrance frames, got ${samples.length}`);
  const first = samples[0]!;
  const settled = samples.at(-1)!;
  const firstPanel = modalPanel(first, width)!;
  const settledPanel = modalPanel(settled, width)!;
  const panelWidth = samples.map((frame) => Number(modalPanel(frame, width)!.w));
  const panelHeight = samples.map((frame) => Number(modalPanel(frame, width)!.h));
  const glassOpacity = samples.map((frame) => Number(glassParameters(frame)!.opacity));
  // Native rects are integer-quantized; a scale step can round one pixel
  // backward while the underlying phase continues monotonically.
  assertMonotonic(panelWidth, "up", `${name} panel scale`, 2);
  assertMonotonic(panelHeight, "up", `${name} panel scale height`, 2);
  assertMonotonic(glassOpacity, "up", `${name} blur opacity`, 0.000001);
  assertApproxThreeHundredMs(samples, `${name} entrance`);
  assert.ok(
    Number(firstPanel.w) < Number(settledPanel.w),
    `${name} panel must start below settled scale: first=${JSON.stringify(firstPanel)} settled=${JSON.stringify(settledPanel)} blur=${JSON.stringify(glassOpacity)}`,
  );
  assert.ok(glassOpacity[0]! < 1 && glassOpacity.at(-1)! >= 0.99, `${name} blur must fade to full opacity`);
  assert.equal(JSON.parse((frames.find((frame) => glassParameters(frame))!.ops ?? []).find((op) => op.type === "hostSurface")!.asset as string).parameters.tintOpacity, 0, `${name} blur must not add a tint colour`);
  assert.equal(modalBackdrops(first, width, height).length, 0, `${name} must not paint the official Modal black backdrop above the colorless blur`);
  assert.equal(modalBackdrops(settled, width, height).length, 0, `${name} must keep the official Modal backdrop transparent`);
}

function assertDialogExit(frames: Frame[], width: number, title: string, name: string): void {
  const samples = dialogTransitionFrames(frames, width);
  assert.ok(samples.length >= 4, `${name} must expose several exit frames, got ${samples.length}`);
  const first = samples[0]!;
  const settled = samples.at(-1)!;
  const panelWidth = samples.map((frame) => Number(modalPanel(frame, width)!.w));
  const panelHeight = samples.map((frame) => Number(modalPanel(frame, width)!.h));
  const glassOpacity = samples.map((frame) => Number(glassParameters(frame)!.opacity));
  assertMonotonic(panelWidth, "down", `${name} panel scale`, 2);
  assertMonotonic(panelHeight, "down", `${name} panel scale height`, 2);
  assertMonotonic(glassOpacity, "down", `${name} blur opacity`, 0.000001);
  assertApproxThreeHundredMs(samples, `${name} exit`);
  assert.ok(Number(first.frame) < Number(settled.frame), `${name} must advance virtual time during exit`);
  assert.ok(panelWidth[0]! > panelWidth.at(-1)!, `${name} panel must shrink during exit`);
  assert.ok(glassOpacity[0]! > glassOpacity.at(-1)!, `${name} blur must fade during exit`);
  assert.doesNotMatch(textOf(frames.at(-1)!), new RegExp(title));
}

function assertInterruptedReopen(frames: Frame[], width: number, title: string, name: string): void {
  const samples = dialogTransitionFrames(frames, width);
  assert.ok(samples.length >= 8, `${name} must expose the close/reopen trajectory, got ${samples.length}`);
  const opacity = samples.map((frame) => Number(glassParameters(frame)!.opacity));
  const firstSettled = opacity.findIndex((value) => value >= 0.99);
  assert.ok(firstSettled >= 0, `${name} must settle before the interruption: ${opacity.join(",")}`);
  let minimumIndex = firstSettled;
  for (let index = firstSettled + 1; index < opacity.length; index += 1) {
    if (opacity[index]! < opacity[minimumIndex]!) minimumIndex = index;
  }
  assert.ok(minimumIndex > firstSettled, `${name} must reverse after close: ${opacity.join(",")}`);
  assertMonotonic(opacity.slice(firstSettled, minimumIndex + 1), "down", `${name} close opacity`, 0.02);
  assertMonotonic(opacity.slice(minimumIndex), "up", `${name} reopen opacity`, 0.02);
  assert.ok(opacity[minimumIndex]! < 0.99, `${name} must visibly leave its settled phase`);
  assert.ok(opacity.at(-1)! >= 0.99, `${name} must settle again after reopening`);
  assert.match(textOf(frames.at(-1)!), new RegExp(title));
}

test("MobileDialog opens, dismisses, and separates cancel/confirm callbacks in native runtime", () => {
  assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required; set POCKET_NATIVE_PROBE");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-mobile-dialog-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "mobile-dialog-native-fixture", private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({ appId: "pocket.test.mobile-dialog", entry: "app.tsx" }),
    );
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(
      join(project, "app.tsx"),
      `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { after } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { FocusScope, Screen, Text } from "@pocketjs/framework/solid/components";
import {
  MobileDialog,
  MobileFilledButton,
  MobileScaffold,
  MobileThemeProvider,
} from "@pocket/ui";

function App() {
  const [wholeState, setWholeState] = createSignal({ open: false, detailsOpen: false, unrelatedFrame: 0 });
  const singleOpen = () => wholeState().open;
  const setSingleOpen = (open: boolean) => setWholeState(previous => ({ ...previous, open }));
  const detailsOpen = () => wholeState().detailsOpen;
  const setDetailsOpen = (open: boolean) => setWholeState(previous => ({ ...previous, detailsOpen: open }));
  // A whole-store getter invalidates every frame while its derived open key
  // stays unchanged. Entrance progress must still settle rather than restart.
  onFrame(() => setWholeState(previous => ({ ...previous, unrelatedFrame: previous.unrelatedFrame + 1 })));
  const [doubleOpen, setDoubleOpen] = createSignal(false);
  const [singleStatus, setSingleStatus] = createSignal("idle");
  const [detailsStatus, setDetailsStatus] = createSignal("idle");
  const [rapidOpen, setRapidOpen] = createSignal(false);
  const [doubleStatus, setDoubleStatus] = createSignal("idle");
  const [confirmCount, setConfirmCount] = createSignal(0);
  const [confirming, setConfirming] = createSignal(false);

  return (
    <Screen class="w-full h-full flex-col bg-[#F5F6FA]">
      <MobileThemeProvider>
        <FocusScope class="flex-1 flex-col" autoFocus>
          <MobileScaffold class="flex-col gap-2 p-3 bg-[#F5F6FA]">
            <MobileFilledButton label="OpenSingle" onPress={() => setSingleOpen(true)} />
            <MobileFilledButton label="OpenDetails" onPress={() => setDetailsOpen(true)} />
            <MobileFilledButton label="OpenRapid" onPress={() => setRapidOpen(true)} />
            <MobileFilledButton label="OpenDouble" onPress={() => setDoubleOpen(true)} />
            <Text>SingleStatus:{singleStatus()}</Text>
            <Text>DetailsStatus:{detailsStatus()}</Text>
            <Text>RapidStatus:{rapidOpen() ? "open" : "closed"}</Text>
            <Text>DoubleStatus:{doubleStatus()}</Text>
            <Text>ConfirmCount:{confirmCount()}</Text>
          </MobileScaffold>
        </FocusScope>
        <MobileDialog
          open={singleOpen()}
          title="SingleTitle"
          body="Dismiss this compact dialog."
          cancelLabel="Close"
          onClose={() => {
            setSingleStatus("dismissed");
            setSingleOpen(false);
          }}
        />
        <MobileDialog
          open={wholeState().detailsOpen}
          title="DetailsTitle"
          body="Mounted by parent route."
          cancelLabel="Close"
          onClose={() => {
            setDetailsStatus("dismissed");
            setDetailsOpen(false);
          }}
        />
        <MobileDialog
          open={rapidOpen()}
          title="RapidTitle"
          body="Reverse and reopen."
          cancelLabel="Close"
          onClose={() => setRapidOpen(false)}
        >
          <MobileFilledButton
            label="RapidReopen"
            compact
            onPress={() => {
              setRapidOpen(false);
              after(0.12, () => setRapidOpen(true));
            }}
          />
        </MobileDialog>
        <MobileDialog
          open={doubleOpen()}
          title="DoubleTitle"
          body="Choose one action."
          tone="danger"
          cancelLabel="Cancel"
          confirmLabel="Confirm"
          onConfirm={() => {
            setConfirmCount(previous => previous + 1);
            setConfirming(true);
            setDoubleStatus("confirmed");
          }}
          onClose={() => {
            if (!confirming()) setDoubleStatus("cancelled");
            setConfirming(false);
            setDoubleOpen(false);
          }}
        />
      </MobileThemeProvider>
    </Screen>
  );
}

mount(App);
`,
    );

    const build = spawnSync("bun", [buildGuest, `--project-root=${project}`, `--outdir=${output}`], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const bytecodePath = join(output, "app.qjbc");
    const pakPath = join(output, "app.pak");
    assert.ok(existsSync(bytecodePath), "MobileDialog fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "MobileDialog fixture PAK is missing");

    const widths = process.env.POCKET_DIALOG_WIDTHS
      ? process.env.POCKET_DIALOG_WIDTHS.split(",").map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : [390, 320];
    for (const width of widths) {
      const initial = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        { op: "quit" },
      ])).at(-1)!;
      assert.match(textOf(initial), /SingleStatus:idle/);
      assert.match(textOf(initial), /DetailsStatus:idle/);
      assert.match(textOf(initial), /DoubleStatus:idle/);

      const openSingle = centerPoint(initial, "OpenSingle");
      const singleFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openSingle, 20),
        { op: "quit" },
      ]));
      const single = singleFrames.at(-1)!;
      assert.match(textOf(single), /SingleTitle/);
      assertDialogEntrance(singleFrames, width, 640, "SingleTitle", `${width}px single dialog`);
      assertOpaque(single, "SingleTitle");
      assert.equal(textOps(single, "Close").length, 1, `${width}px single-action dialog must have one Close action`);
      assert.equal(textOps(single, "Cancel").length, 0, `${width}px single-action dialog must not expose Cancel`);
      assert.equal(textOps(single, "Confirm").length, 0, `${width}px single-action dialog must not expose Confirm`);
      assertDialogContentFits(single, width, ["SingleTitle", "Dismiss this compact dialog.", "Close"], `${width}px single dialog`);
      assertCompactPanel(single, width, `${width}px single dialog`);

      const close = centerPoint(single, "Close");
      const afterDismissFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openSingle, 20),
        ...tap(close),
        ...Array.from({ length: 20 }, () => ({ op: "frame", deltaMs: 16 })),
        { op: "quit" },
      ]));
      assertDialogExit(afterDismissFrames.slice(-22), width, "SingleTitle", `${width}px single dialog`);
      const afterDismiss = afterDismissFrames.at(-1)!;
      assert.doesNotMatch(textOf(afterDismiss), /SingleTitle/);
      assert.match(textOf(afterDismiss), /SingleStatus:dismissed/);

      const openDetails = centerPoint(afterDismiss, "OpenDetails");
      const detailsFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openDetails, 20),
        { op: "quit" },
      ]));
      const details = detailsFrames.at(-1)!;
      assert.match(textOf(details), /DetailsTitle/);
      assertDialogEntrance(detailsFrames, width, 640, "DetailsTitle", `${width}px persistent details dialog`);
      assertOpaque(details, "DetailsTitle");
      assert.equal(textOps(details, "Close").length, 1, `${width}px persistent details dialog must have one Close action`);
      assert.equal(textOps(details, "Cancel").length, 0, `${width}px persistent details dialog must not expose Cancel`);
      assert.equal(textOps(details, "Confirm").length, 0, `${width}px persistent details dialog must not expose Confirm`);
      assertDialogContentFits(details, width, ["DetailsTitle", "Mounted by parent route.", "Close"], `${width}px persistent details dialog`);
      assertCompactPanel(details, width, `${width}px persistent details dialog`);

      const detailsClose = centerPoint(details, "Close");
      const afterDetailsFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openDetails, 20),
        ...tap(detailsClose),
        ...Array.from({ length: 20 }, () => ({ op: "frame", deltaMs: 16 })),
        { op: "quit" },
      ]));
      assertDialogExit(afterDetailsFrames.slice(-22), width, "DetailsTitle", `${width}px persistent details dialog`);
      const afterDetails = afterDetailsFrames.at(-1)!;
      assert.doesNotMatch(textOf(afterDetails), /DetailsTitle/);
      assert.match(textOf(afterDetails), /DetailsStatus:dismissed/);

      const openRapid = centerPoint(afterDetails, "OpenRapid");
      const rapidOpenFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openRapid, 20),
        { op: "quit" },
      ]));
      const rapid = rapidOpenFrames.at(-1)!;
      assert.match(textOf(rapid), /RapidTitle/);
      const rapidReopen = centerPoint(rapid, "RapidReopen");
      const rapidCycleFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openRapid, 20),
        ...tap(rapidReopen),
        ...Array.from({ length: 30 }, () => ({ op: "frame", deltaMs: 16 })),
        { op: "quit" },
      ]));
      assertInterruptedReopen(rapidCycleFrames, width, "RapidTitle", `${width}px rapid dialog reopen`);

      const openDouble = centerPoint(afterDetails, "OpenDouble");
      const doubleFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openDouble, 20),
        { op: "quit" },
      ]));
      const double = doubleFrames.at(-1)!;
      assert.match(textOf(double), /DoubleTitle/);
      assertOpaque(double, "DoubleTitle");
      assert.equal(textOps(double, "Cancel").length, 1, `${width}px double-action dialog must expose Cancel`);
      assert.equal(textOps(double, "Confirm").length, 1, `${width}px double-action dialog must expose Confirm`);
      assert.equal(textOps(double, "Close").length, 0, `${width}px double-action dialog must not fall back to Close`);
      assertDialogContentFits(double, width, ["DoubleTitle", "Choose one action.", "Cancel", "Confirm"], `${width}px double dialog`);
      assertEqualActionRow(double, width, `${width}px double dialog`);
      assertCompactPanel(double, width, `${width}px double dialog`);

      const cancel = centerPoint(double, "Cancel");
      const afterCancelFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openDouble, 20),
        ...tap(cancel),
        ...Array.from({ length: 20 }, () => ({ op: "frame", deltaMs: 16 })),
        { op: "quit" },
      ]));
      const afterCancel = afterCancelFrames.at(-1)!;
      assert.doesNotMatch(textOf(afterCancel), /DoubleTitle/);
      assert.match(textOf(afterCancel), /DoubleStatus:cancelled/);

      const confirm = centerPoint(double, "Confirm");
      const afterConfirmFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openDouble, 20),
        ...tap(confirm),
        // The retained exit is still painted here; a second confirm must not
        // re-run the business callback while requested open=false.
        ...tap(confirm),
        ...Array.from({ length: 20 }, () => ({ op: "frame", deltaMs: 16 })),
        { op: "quit" },
      ]));
      const afterConfirm = afterConfirmFrames.at(-1)!;
      assert.doesNotMatch(textOf(afterConfirm), /DoubleTitle/);
      assert.match(textOf(afterConfirm), /DoubleStatus:confirmed/);
      assert.match(textOf(afterConfirm), /ConfirmCount:1/);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 150_000);
