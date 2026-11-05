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
};
type Frame = { ops?: DrawOp[] };
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
  const ops = labels.flatMap((label) => textOps(frame, label));
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
import { onFrame } from "@pocketjs/framework/solid/lifecycle";
import { FocusScope, Screen, Text } from "@pocketjs/framework/solid/components";
import {
  MobileDialog,
  MobileFilledButton,
  MobileScaffold,
  MobileThemeProvider,
} from "@pocket/ui";

function App() {
  const [wholeState, setWholeState] = createSignal({ open: false, unrelatedFrame: 0 });
  const singleOpen = () => wholeState().open;
  const setSingleOpen = (open: boolean) => setWholeState(previous => ({ ...previous, open }));
  // A whole-store getter invalidates every frame while its derived open key
  // stays unchanged. Entrance progress must still settle rather than restart.
  onFrame(() => setWholeState(previous => ({ ...previous, unrelatedFrame: previous.unrelatedFrame + 1 })));
  const [doubleOpen, setDoubleOpen] = createSignal(false);
  const [singleStatus, setSingleStatus] = createSignal("idle");
  const [doubleStatus, setDoubleStatus] = createSignal("idle");
  const [confirming, setConfirming] = createSignal(false);

  return (
    <Screen class="w-full h-full flex-col bg-[#F5F6FA]">
      <FocusScope class="flex-1 flex-col" autoFocus>
        <MobileThemeProvider>
          <MobileScaffold class="flex-col gap-2 p-3 bg-[#F5F6FA]">
            <MobileFilledButton label="OpenSingle" onPress={() => setSingleOpen(true)} />
            <MobileFilledButton label="OpenDouble" onPress={() => setDoubleOpen(true)} />
            <Text>SingleStatus:{singleStatus()}</Text>
            <Text>DoubleStatus:{doubleStatus()}</Text>
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
              open={doubleOpen()}
              title="DoubleTitle"
              body="Choose one action."
              tone="danger"
              cancelLabel="Cancel"
              confirmLabel="Confirm"
              onConfirm={() => {
                setConfirming(true);
                setDoubleStatus("confirmed");
              }}
              onClose={() => {
                if (!confirming()) setDoubleStatus("cancelled");
                setConfirming(false);
                setDoubleOpen(false);
              }}
            />
          </MobileScaffold>
        </MobileThemeProvider>
      </FocusScope>
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

    for (const width of [390, 320]) {
      const initial = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        { op: "quit" },
      ])).at(-1)!;
      assert.match(textOf(initial), /SingleStatus:idle/);
      assert.match(textOf(initial), /DoubleStatus:idle/);

      const openSingle = centerPoint(initial, "OpenSingle");
      const singleFrames = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        ...tap(openSingle, 20),
        { op: "quit" },
      ]));
      const single = singleFrames.at(-1)!;
      assert.match(textOf(single), /SingleTitle/);
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
        { op: "quit" },
      ]));
      const afterDismiss = afterDismissFrames.at(-1)!;
      assert.doesNotMatch(textOf(afterDismiss), /SingleTitle/);
      assert.match(textOf(afterDismiss), /SingleStatus:dismissed/);

      const openDouble = centerPoint(afterDismiss, "OpenDouble");
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
        { op: "quit" },
      ]));
      const afterConfirm = afterConfirmFrames.at(-1)!;
      assert.doesNotMatch(textOf(afterConfirm), /DoubleTitle/);
      assert.match(textOf(afterConfirm), /DoubleStatus:confirmed/);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 150_000);
