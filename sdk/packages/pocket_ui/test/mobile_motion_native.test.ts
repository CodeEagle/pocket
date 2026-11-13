import { afterAll, test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = JsonObject & { type?: string; text?: string; x?: number; y?: number; w?: number; h?: number; color?: number };
type Frame = { frame?: number; ops?: DrawOp[] };
type ProbeResponse = { ok?: boolean; error?: string; frame?: Frame; nextWakeDelayMs?: number };
type Point = { x: number; y: number };
type Sample = { frame: number; present: boolean; opacity: number };

const testDir = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(testDir, "../../..");
const buildGuest = join(sdkRoot, "scripts/build_guest.ts");
// Use release by default; the debug probe has a different first-frame cost.
const probe = process.env.POCKET_NATIVE_PROBE
  ? resolve(process.env.POCKET_NATIVE_PROBE)
  : [
      join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
      join(sdkRoot, "native/target/release/pocket_probe"),
    ].find(existsSync);
const FRAME_60 = 1000 / 60;
const FRAME_30 = 1000 / 30;
const OPACITY_EPSILON = 1 / 255 + 0.000001;

let projectDir: string | undefined;
let bytecodePath: string | undefined;
let pakPath: string | undefined;

function frame(deltaMs: number): JsonObject { return { op: "frame", deltaMs }; }
function frames(count: number, deltaMs: number): JsonObject[] { return Array.from({ length: count }, () => frame(deltaMs)); }
function pointer(phase: "down" | "up", point: Point): JsonObject {
  return { op: "send", message: { type: "event", name: "input.pointer", payload: { phase, id: 0, x: point.x, y: point.y } } };
}
function tap(point: Point, deltaMs: number): JsonObject[] {
  return [pointer("down", point), frame(deltaMs), pointer("up", point), frame(deltaMs)];
}
function frameCount(commands: JsonObject[]): number { return commands.filter((command) => command.op === "frame").length; }

function textOp(frameValue: Frame, label: string): DrawOp | undefined {
  return (frameValue.ops ?? []).find((op) => op.type === "text" && op.text === label);
}
function centerPoint(frameValue: Frame, label: string): Point {
  const op = textOp(frameValue, label);
  assert.ok(op, `frame is missing interactive label ${label}`);
  return { x: Number(op.x) + Number(op.w) / 2, y: Number(op.y) + Number(op.h) / 2 };
}
function labelY(frameValue: Frame, label: string): number {
  const op = textOp(frameValue, label);
  assert.ok(op, `frame is missing layout label ${label}`);
  return Number(op.y);
}
function buttonBackgroundAlpha(frameValue: Frame, label: string): number {
  const labelNode = textOp(frameValue, label);
  assert.ok(labelNode, `frame is missing button label ${label}`);
  const centerY = Number(labelNode.y) + Number(labelNode.h) / 2;
  const candidates = (frameValue.ops ?? []).filter((op) => {
    if (op.type !== "rect" && op.type !== "rounded") return false;
    const w = Number(op.w); const h = Number(op.h); const y = Number(op.y);
    return w > Number(labelNode.w) + 20 && h >= 6 && h <= 48 && Math.abs(y + h / 2 - centerY) <= 8;
  });
  assert.ok(candidates.length, `frame is missing ${label} background rect`);
  const background = candidates.sort((left, right) => Number(right.w) * Number(right.h) - Number(left.w) * Number(left.h))[0]!;
  return alpha(background);
}
function alpha(op: DrawOp): number {
  return typeof op.color === "number" ? ((Number(op.color) >>> 24) & 0xff) / 255 : 1;
}
function labelSample(frameValue: Frame, label: string): Sample {
  const op = textOp(frameValue, label);
  return { frame: Number(frameValue.frame), present: Boolean(op), opacity: op ? alpha(op) : 0 };
}
function samplesFor(framesValue: Frame[], label: string): Sample[] { return framesValue.map((value) => labelSample(value, label)); }
function assertMonotonic(values: number[], direction: "up" | "down", name: string): void {
  assert.ok(values.length >= 2, `${name} needs at least two samples: ${values.join(",")}`);
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if (direction === "up") assert.ok(current + OPACITY_EPSILON >= previous, `${name} regressed: ${values.join(",")}`);
    else assert.ok(current <= previous + OPACITY_EPSILON, `${name} increased: ${values.join(",")}`);
  }
}

function markerMetric(frameValue: Frame, label: string, targetRgb?: number): number {
  const labelNode = textOp(frameValue, label);
  if (!labelNode) return 0;
  const labelX = Number(labelNode.x);
  const labelY = Number(labelNode.y) + Number(labelNode.h) / 2;
  const candidates = (frameValue.ops ?? []).filter((op) => {
    if (op.type !== "rect" && op.type !== "rounded" && op.type !== "image") return false;
    const x = Number(op.x); const y = Number(op.y); const w = Number(op.w); const h = Number(op.h);
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)
      && x < labelX && x > labelX - 28 && w > 0 && h > 0 && w <= 12 && h <= 12
      && Math.abs(y + h / 2 - labelY) <= 12
      && (targetRgb === undefined || (Number(op.color) & 0x00ffffff) === targetRgb);
  });
  if (!candidates.length) return 0;
  // Rounded native surfaces are emitted as corner/edge fragments. Their
  // outer fragments sit farther from the box centre than the selected dot;
  // use the cluster centre to ignore those stable border fragments.
  const centers = candidates.map((op) => Number(op.x) + Number(op.w) / 2);
  const clusterCenter = (Math.min(...centers) + Math.max(...centers)) / 2;
  return Math.max(0, ...candidates
    .filter((op) => Math.abs(Number(op.x) + Number(op.w) / 2 - clusterCenter) <= 4)
    .map((op) => Number(op.w) * Number(op.h) * alpha(op)));
}
function assertStateMarker(framesValue: Frame[], label: string, name: string, targetRgb: number): void {
  const values = framesValue.map((value) => markerMetric(value, label, targetRgb));
  const visible = values.filter((value) => value > 0.01);
  assert.ok(visible.length >= 3, `${name} must retain marker frames: ${values.join(",")}`);
  assert.ok(new Set(visible.map((value) => value.toFixed(3))).size >= 2, `${name} must animate marker geometry/opacity: ${values.join(",")}`);
  assert.ok(visible.at(-1)! > visible[0]!, `${name} must settle at the selected marker endpoint: ${values.join(",")}`);
}

function ensureFixture(): void {
  if (bytecodePath && pakPath) return;
  assert.ok(probe && existsSync(probe), "a release pocket_probe is required; set POCKET_NATIVE_PROBE explicitly if needed");
  projectDir = mkdtempSync(join(tmpdir(), "pocket-ui-mobile-motion-"));
  const outDir = join(projectDir, "out");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "mobile-motion", private: true, type: "module" }));
  writeFileSync(join(projectDir, "pocket.json"), JSON.stringify({ appId: "pocket.test.mobile-motion", entry: "app.tsx" }));
  writeFileSync(join(projectDir, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(projectDir, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { FocusScope, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { MOBILE_THEME_LIGHT, MobileAccordion, MobileAlert, MobileButton, MobileCheckbox, MobileRadioGroup, MobileThemeProvider, MobileToast } from "@pocket/ui";
function App() {
  const [toast, setToast] = createSignal(false);
  const [alert, setAlert] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [checked, setChecked] = createSignal(false);
  const [radio, setRadio] = createSignal("a");
  return <Screen class="w-full h-full flex-col bg-white"><FocusScope class="flex-col w-full h-full gap-2 p-3" autoFocus>
    <MobileThemeProvider theme={() => MOBILE_THEME_LIGHT}>
      <MobileButton compact label="MotionHoldButton" onPress={() => {}} />
      <MobileButton compact label={toast() ? "HideToast" : "ShowToast"} onPress={() => setToast((value) => !value)} />
      <MobileToast open={toast} tone="success" message="MotionToast" detail="Toast motion fixture" />
      <MobileButton compact label={alert() ? "HideAlert" : "ShowAlert"} onPress={() => setAlert((value) => !value)} />
      <MobileAlert open={alert} tone="warning" title="MotionAlert" body="Alert motion fixture" />
      <MobileAccordion title="MotionAccordion" detail="Accordion motion fixture" expanded={expanded()} onToggle={() => setExpanded((value) => !value)}><Text>MotionAccordionBody</Text></MobileAccordion>
      <MobileCheckbox checked={checked()} onChange={setChecked} label={checked() ? "MotionCheckOn" : "MotionCheckOff"} />
      <MobileRadioGroup value={radio()} onChange={setRadio} items={[{ id: "a", label: "MotionRadioA" }, { id: "b", label: "MotionRadioB" }]} />
      <View class="h-[1] w-full" />
    </MobileThemeProvider>
  </FocusScope></Screen>;
}
mount(() => <App />);
`);
  const build = spawnSync("bun", [buildGuest, `--project-root=${projectDir}`, `--outdir=${outDir}`], { encoding: "utf8", timeout: 120_000 });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  bytecodePath = join(outDir, "app.qjbc");
  pakPath = join(outDir, "app.pak");
  assert.ok(existsSync(bytecodePath) && existsSync(pakPath), "build_guest must produce QJBC and pak assets");
}

function runProbe(commands: JsonObject[], deltaMs: number): { responses: ProbeResponse[]; frames: Frame[] } {
  ensureFixture();
  const bootstrap: JsonObject[] = [
    { op: "create", width: 390, height: 1000 },
    { op: "loadBytecode", bytecodePath, pakPath },
    frame(deltaMs), frame(deltaMs),
  ];
  const result = spawnSync(probe!, {
    input: [...bootstrap, ...commands, { op: "quit" }].map((command) => JSON.stringify(command)).join("\n") + "\n",
    encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  const responses = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
  for (const response of responses) assert.notEqual(response.ok, false, response.error);
  return { responses, frames: responses.flatMap((response) => response.frame ? [response.frame] : []) };
}
function bootFrame(deltaMs = FRAME_60): Frame { return runProbe([], deltaMs).frames.at(-1)!; }
function framesAfterBoot(result: { frames: Frame[] }): Frame[] { return result.frames.slice(2); }
function textProjection(frameValue: Frame): string {
  return (frameValue.ops ?? []).filter((op) => op.type === "text").map((op) => `${op.text}:${typeof op.color === "number" ? Number(op.color) >>> 0 : "none"}`).join("|");
}

afterAll(() => { if (projectDir) rmSync(projectDir, { recursive: true, force: true }); });

test("Toast, Alert, and Accordion retain fractional entrance and exit frames", () => {
  ensureFixture();
  const initial = bootFrame();
  const cases = [
    { trigger: "ShowToast", marker: "MotionToast", name: "Toast" },
    { trigger: "ShowAlert", marker: "MotionAlert", name: "Alert" },
    { trigger: "MotionAccordion", marker: "MotionAccordionBody", name: "Accordion" },
  ];
  for (const item of cases) {
    const point = centerPoint(initial, item.trigger);
    const openCommands = [...tap(point, FRAME_60), ...frames(24, FRAME_60)];
    const opened = framesAfterBoot(runProbe(openCommands, FRAME_60));
    const openSamples = samplesFor(opened, item.marker).filter((sample) => sample.present);
    assert.ok(openSamples.length >= 4, `${item.name} must expose several entrance frames`);
    assert.ok(openSamples.some((sample) => sample.opacity > OPACITY_EPSILON && sample.opacity < 1 - OPACITY_EPSILON), `${item.name} must expose fractional entrance opacity`);
    assertMonotonic(openSamples.map((sample) => sample.opacity), "up", `${item.name} entrance opacity`);
    assert.ok(openSamples.at(-1)!.opacity >= 1 - OPACITY_EPSILON, `${item.name} must settle fully visible`);

    const cycle = framesAfterBoot(runProbe([...openCommands, ...tap(point, FRAME_60), ...frames(24, FRAME_60)], FRAME_60));
    const exitSamples = samplesFor(cycle.slice(frameCount(openCommands)), item.marker);
    const exitVisible = exitSamples.filter((sample) => sample.present);
    assert.ok(exitVisible.length >= 3, `${item.name} must retain visible exit frames`);
    assert.ok(exitVisible.some((sample) => sample.opacity > OPACITY_EPSILON && sample.opacity < 1 - OPACITY_EPSILON), `${item.name} exit must expose fractional opacity`);
    assertMonotonic(exitVisible.map((sample) => sample.opacity), "down", `${item.name} exit opacity`);
    assert.ok(!exitSamples.at(-1)!.present, `${item.name} must unmount only after its exit settles`);
  }
}, 120_000);

test("Accordion height moves the following row and button press alpha recovers", () => {
  ensureFixture();
  const initial = bootFrame();
  const initialCheckboxY = labelY(initial, "MotionCheckOff");
  const accordionPoint = centerPoint(initial, "MotionAccordion");
  const expandCommands = [...tap(accordionPoint, FRAME_60), ...frames(24, FRAME_60)];
  const expanded = framesAfterBoot(runProbe(expandCommands, FRAME_60));
  const expandedY = expanded.map((value) => labelY(value, "MotionCheckOff"));
  assert.ok(new Set(expandedY.map((value) => value.toFixed(2))).size >= 4, `Accordion height must expose multiple native y positions: ${expandedY.join(",")}`);
  assertMonotonic(expandedY, "up", "Accordion following-row y", 1.1);
  assert.ok(expandedY.at(-1)! > initialCheckboxY + 4, `Accordion must move Checkbox down: ${initialCheckboxY} -> ${expandedY.at(-1)}`);

  const collapsedCycle = framesAfterBoot(runProbe([...expandCommands, ...tap(accordionPoint, FRAME_60), ...frames(24, FRAME_60)], FRAME_60));
  const collapseY = collapsedCycle.slice(frameCount(expandCommands)).map((value) => labelY(value, "MotionCheckOff"));
  assertMonotonic(collapseY, "down", "Accordion following-row collapse y", 1.1);
  assert.ok(collapseY[0]! > collapseY.at(-1)! + 4, `Accordion must move Checkbox up while collapsing: ${collapseY.join(",")}`);
  assert.ok(Math.abs(collapseY.at(-1)! - initialCheckboxY) <= 2, `Accordion collapse must return Checkbox to its original y: ${initialCheckboxY} -> ${collapseY.at(-1)}`);

  const buttonPoint = centerPoint(initial, "MotionHoldButton");
  const pressed = framesAfterBoot(runProbe([
    pointer("down", buttonPoint), frame(FRAME_60), ...frames(4, FRAME_60),
    pointer("up", buttonPoint), frame(FRAME_60), ...frames(12, FRAME_60),
  ], FRAME_60));
  const normalAlpha = buttonBackgroundAlpha(initial, "MotionHoldButton");
  const heldAlpha = pressed.slice(0, 5).map((value) => buttonBackgroundAlpha(value, "MotionHoldButton"));
  assert.ok(heldAlpha.every((value) => value < normalAlpha - 0.05), `button DOWN must lower native alpha: normal=${normalAlpha}, held=${heldAlpha.join(",")}`);
  const restoredAlpha = buttonBackgroundAlpha(pressed.at(-1)!, "MotionHoldButton");
  assert.ok(Math.abs(restoredAlpha - normalAlpha) <= OPACITY_EPSILON, `button UP must restore alpha: normal=${normalAlpha}, restored=${restoredAlpha}`);
}, 120_000);

test("presence reverse is continuous and checkbox/radio marks animate", () => {
  ensureFixture();
  const initial = bootFrame();
  const toastPoint = centerPoint(initial, "ShowToast");
  const opening = [...tap(toastPoint, FRAME_60), ...frames(4, FRAME_60)];
  // Reverse while the presentation is still mounted; allowing it to reach
  // phase zero would test a fresh entrance rather than a retarget.
  const closing = [...tap(toastPoint, FRAME_60), ...frames(2, FRAME_60)];
  const reopening = [...tap(toastPoint, FRAME_60), ...frames(20, FRAME_60)];
  const rapidFrames = framesAfterBoot(runProbe([...opening, ...closing, ...reopening], FRAME_60));
  const closeEnd = frameCount(opening) + frameCount(closing);
  const beforeRetarget = labelSample(rapidFrames[closeEnd - 1]!, "MotionToast");
  const firstAfterRetarget = labelSample(rapidFrames[closeEnd + 1]!, "MotionToast");
  assert.ok(beforeRetarget.present && firstAfterRetarget.present, "rapid retarget must retain the Toast subtree");
  assert.ok(Math.abs(firstAfterRetarget.opacity - beforeRetarget.opacity) <= 0.35, `rapid retarget jumped: ${beforeRetarget.opacity} -> ${firstAfterRetarget.opacity}`);
  assert.ok(firstAfterRetarget.opacity < 1 - OPACITY_EPSILON, "rapid retarget must not snap to the endpoint");
  const reopenSamples = samplesFor(rapidFrames.slice(closeEnd + 1), "MotionToast").filter((sample) => sample.present);
  assertMonotonic(reopenSamples.map((sample) => sample.opacity), "up", "Toast rapid reopen");
  assert.ok(reopenSamples.at(-1)!.opacity >= 1 - OPACITY_EPSILON, "rapid reopen must settle at the latest target");

  const checkPoint = centerPoint(initial, "MotionCheckOff");
  const checkFrames = framesAfterBoot(runProbe([...tap(checkPoint, FRAME_60), ...frames(18, FRAME_60)], FRAME_60));
  assertStateMarker(checkFrames, "MotionCheckOn", "Checkbox", 0x00fafafa);
  const radioPoint = centerPoint(initial, "MotionRadioB");
  const radioFrames = framesAfterBoot(runProbe([...tap(radioPoint, FRAME_60), ...frames(18, FRAME_60)], FRAME_60));
  assertStateMarker(radioFrames, "MotionRadioB", "Radio selection", 0x0018181b);
  const oldRadioValues = radioFrames.map((value) => markerMetric(value, "MotionRadioA", 0x0018181b)).filter((value) => value > 0.01);
  assert.ok(oldRadioValues.length >= 3, "Radio A must retain its exit marker frames");
  assert.ok(oldRadioValues.at(-1)! < oldRadioValues[0]!, `Radio A marker must fade out: ${oldRadioValues.join(",")}`);
}, 120_000);

function measureToastEntrance(deltaMs: number): { durationMs: number } {
  const point = centerPoint(bootFrame(deltaMs), "ShowToast");
  const samples = samplesFor(framesAfterBoot(runProbe([...tap(point, deltaMs), ...frames(24, deltaMs)], deltaMs)), "MotionToast");
  const first = samples.find((sample) => sample.present && sample.opacity > OPACITY_EPSILON);
  assert.ok(first, `Toast must show a nonzero sample at ${deltaMs}ms`);
  const settled = samples.find((sample) => sample.frame >= first.frame && sample.opacity >= 1 - OPACITY_EPSILON);
  assert.ok(settled, `Toast must settle at ${deltaMs}ms`);
  return { durationMs: (settled.frame - first.frame) * deltaMs };
}

test("presence duration is clock-based at 30/60Hz and parks after settling", () => {
  ensureFixture();
  const at60 = measureToastEntrance(FRAME_60);
  const at30 = measureToastEntrance(FRAME_30);
  assert.ok(at60.durationMs >= 250 && at60.durationMs <= 340, `60Hz duration must follow the 300ms presentation token: ${at60.durationMs}ms`);
  assert.ok(at30.durationMs >= 250 && at30.durationMs <= 340, `30Hz duration must follow the 300ms presentation token: ${at30.durationMs}ms`);
  assert.ok(Math.abs(at60.durationMs - at30.durationMs) <= 50, `30/60Hz durations diverged: ${at60.durationMs}ms vs ${at30.durationMs}ms`);

  const point = centerPoint(bootFrame(), "ShowToast");
  const idle = runProbe([...tap(point, FRAME_60), ...frames(24, FRAME_60), { op: "schedule" }, ...frames(3, FRAME_60), { op: "schedule" }], FRAME_60);
  const wakeDelays = idle.responses.flatMap((response) => typeof response.nextWakeDelayMs === "number" ? [response.nextWakeDelayMs] : []);
  assert.equal(wakeDelays.at(-1), -1, `settled MobileToast must park: ${wakeDelays.join(",")}`);
  const idleFrames = framesAfterBoot(idle).slice(-3).map(textProjection);
  assert.equal(new Set(idleFrames).size, 1, `settled idle frames must not mutate the visual tree: ${idleFrames.join(" || ")}`);
}, 120_000);
