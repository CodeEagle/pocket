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

function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter((op) => op.type === "text" && typeof op.text === "string")
    .map((op) => op.text)
    .join("\n");
}

function centerPoint(frame: Frame, label: string): { x: number; y: number } {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `frame is missing interactive label ${label}`);
  return { x: Number(op.x) + Number(op.w) / 2, y: Number(op.y) + Number(op.h) / 2 };
}

test("Option C Design System components execute and animate state changes in native runtime", () => {
  assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-design-system-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "design-system-fixture", private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({ appId: "pocket.test.design", entry: "app.tsx" }),
    );
    writeFileSync(
      join(project, "manifest.json"),
      JSON.stringify({ capabilities: { requires: [] } }),
    );
    writeFileSync(
      join(project, "app.tsx"),
      `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { FocusScope, Screen, View } from "@pocketjs/framework/solid/components";
import {
  MOBILE_THEME_DARK,
  MOBILE_THEME_LIGHT,
  MobileAccordion,
  MobileAlert,
  MobileAvatar,
  MobileBadge,
  MobileCheckbox,
  MobileDialog,
  MobileFilledButton,
  MobilePopup,
  MobileProgress,
  MobileRadioGroup,
  MobileScaffold,
  MobileSkeleton,
  MobileTag,
  MobileThemeProvider,
  MobileToast,
  MobileTonalButton,
} from "@pocket/ui";

function App() {
  const [dark, setDark] = createSignal(false);
  const [density, setDensity] = createSignal<"touch" | "desktop">("touch");
  const [toastOpen, setToastOpen] = createSignal(true);
  const [alertOpen, setAlertOpen] = createSignal(true);
  const [popupOpen, setPopupOpen] = createSignal(false);
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [checked, setChecked] = createSignal(false);
  const [radio, setRadio] = createSignal("a");
  const [expanded, setExpanded] = createSignal(false);
  const [progress, setProgress] = createSignal(30);
  const [status, setStatus] = createSignal("idle");

  return (
    <Screen class="w-full h-full flex-col bg-[#F5F6FA]">
      <FocusScope class="flex-1 flex-col" autoFocus>
        <MobileThemeProvider
          theme={() => (dark() ? MOBILE_THEME_DARK : MOBILE_THEME_LIGHT)}
          density={() => density()}
        >
          <MobileScaffold class="flex-col gap-2 p-3 bg-[#F5F6FA]">
            <View class="flex-row items-center gap-2">
              <MobileTonalButton label="TogglePC" compact onPress={() => setDensity(d => d === "touch" ? "desktop" : "touch")} />
              <MobileFilledButton label="OpenPopup" compact onPress={() => setPopupOpen(true)} />
              <MobileFilledButton label="OpenDialog" compact onPress={() => setDialogOpen(true)} />
              <MobileBadge label={\`Mode:\${density()}:\${status()}\`} />
            </View>
            <MobileToast
              open={toastOpen()}
              tone="success"
              message="ToastActive"
              onClose={() => setToastOpen(false)}
            />
            <MobileAlert
              open={alertOpen()}
              tone="warning"
              title="AlertActive"
              closable
              onClose={() => setAlertOpen(false)}
            />
            <MobileCheckbox
              checked={checked()}
              onChange={setChecked}
              label={checked() ? "CheckOn" : "CheckOff"}
            />
            <MobileRadioGroup
              value={radio()}
              onChange={setRadio}
              items={[
                { id: "a", label: "RadioA" },
                { id: "b", label: "RadioB" },
              ]}
            />
            <MobileAccordion
              title="AccordionHeader"
              expanded={expanded()}
              onToggle={() => {
                setExpanded(v => !v);
                setProgress(80);
              }}
            >
              <MobileTag label="AccordionBodyTag" selected />
            </MobileAccordion>
            <MobileProgress value={progress()} max={100} label="LoadProgress" />
            <View class="flex-row items-center gap-2">
              <MobileAvatar label="UI" status="online" />
              <MobileSkeleton rows={2} avatar={false} />
            </View>
            <MobilePopup
              open={popupOpen()}
              title="PopupSheetTitle"
              actions={[{ id: "act1", label: "RunPopupAction" }]}
              onSelectAction={(id) => setStatus(id)}
              onClose={() => setPopupOpen(false)}
            />
            <MobileDialog
              open={dialogOpen()}
              title="DialogModalTitle"
              confirmLabel="ConfirmDialog"
              onConfirm={() => setStatus("confirmed")}
              onClose={() => setDialogOpen(false)}
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

    // 1. Initial frame renders Toast, Alert, Checkbox, RadioGroup, Accordion, Progress
    const initialFrames = framesOf(
      runProbe([
        { op: "create", width: 390, height: 760 },
        { op: "loadBytecode", bytecodePath, pakPath },
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ]),
    );
    const ready = initialFrames.at(-1)!;
    const readyText = textOf(ready);
    assert.match(readyText, /ToastActive/);
    assert.match(readyText, /AlertActive/);
    assert.match(readyText, /CheckOff/);
    assert.match(readyText, /Mode:touch:idle/);
    assert.match(readyText, /30%/);

    // 2. Toggle density to desktop, toggle checkbox, expand accordion, open Popup & execute action, open Dialog & confirm
    const pcPt = centerPoint(ready, "TogglePC");
    const checkPt = centerPoint(ready, "CheckOff");
    const accPt = centerPoint(ready, "AccordionHeader");
    const popupPt = centerPoint(ready, "OpenPopup");

    const step1Frames = framesOf(
      runProbe([
        { op: "create", width: 390, height: 760 },
        { op: "loadBytecode", bytecodePath, pakPath },
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: pcPt.x, y: pcPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: pcPt.x, y: pcPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: checkPt.x, y: checkPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: checkPt.x, y: checkPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: accPt.x, y: accPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: accPt.x, y: accPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: popupPt.x, y: popupPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: popupPt.x, y: popupPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ]),
    );
    const popupOpenFrame = step1Frames.at(-1)!;
    const popupText = textOf(popupOpenFrame);
    assert.match(popupText, /Mode:desktop:idle/);
    assert.match(popupText, /CheckOn/);
    assert.match(popupText, /AccordionBodyTag/);
    assert.match(popupText, /80%/);
    assert.match(popupText, /PopupSheetTitle/);
    assert.match(popupText, /RunPopupAction/);

    const actionPt = centerPoint(popupOpenFrame, "RunPopupAction");
    const dialogBtnPt = centerPoint(ready, "OpenDialog");
    const step2Frames = framesOf(
      runProbe([
        { op: "create", width: 390, height: 760 },
        { op: "loadBytecode", bytecodePath, pakPath },
        { op: "frame", deltaMs: 16 },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: popupPt.x, y: popupPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: popupPt.x, y: popupPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: actionPt.x, y: actionPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: actionPt.x, y: actionPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: dialogBtnPt.x, y: dialogBtnPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: dialogBtnPt.x, y: dialogBtnPt.y } } },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ]),
    );
    const dialogFrame = step2Frames.at(-1)!;
    const dialogText = textOf(dialogFrame);
    assert.match(dialogText, /Mode:touch:act1/);
    assert.match(dialogText, /DialogModalTitle/);
    assert.match(dialogText, /ConfirmDialog/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 60_000);
