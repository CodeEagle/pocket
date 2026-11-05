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

function lastFrame(responses: ProbeResponse[]): Frame {
  const frame = responses.flatMap((response) => (response.frame ? [response.frame] : [])).at(-1);
  assert.ok(frame, "accent fixture did not produce a frame");
  return frame;
}

function textOp(frame: Frame, label: string): DrawOp {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `frame is missing text label ${label}`);
  assert.equal(typeof op.color, "number", `${label} must expose a native text color`);
  return op;
}

function centerPoint(frame: Frame, label: string): { x: number; y: number } {
  const op = textOp(frame, label);
  assert.equal(typeof op.x, "number", `${label} must expose x`);
  assert.equal(typeof op.y, "number", `${label} must expose y`);
  assert.equal(typeof op.w, "number", `${label} must expose w`);
  assert.equal(typeof op.h, "number", `${label} must expose h`);
  return { x: op.x! + op.w! / 2, y: op.y! + op.h! / 2 };
}

test("Mobile accent palette reaches native text colors", () => {
  assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-accent-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "accent-native-fixture", private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({ appId: "pocket.test.accent", entry: "app.tsx" }),
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
  createMobileTheme,
  MobileFilledButton,
  MobileScaffold,
  MobileTextButton,
  MobileThemeProvider,
} from "@pocket/ui";

function App() {
  const [accent, setAccent] = createSignal<"blue" | "rose">("blue");
  return (
    <Screen class="w-full h-full flex-col bg-[#F5F6FA]">
      <FocusScope class="flex-1 flex-col" autoFocus>
        <MobileThemeProvider theme={() => createMobileTheme(false, accent())}>
          <MobileScaffold class="flex-col gap-3 p-4">
            <MobileFilledButton
              label={accent() === "blue" ? "Use rose" : "Use blue"}
              onPress={() => setAccent((value) => value === "blue" ? "rose" : "blue")}
            />
            <MobileTextButton label="Accent sample" />
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
    assert.ok(existsSync(bytecodePath), "accent fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "accent fixture PAK is missing");

    const initial = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    assert.equal(textOp(initial, "Accent sample").color, 0xff315deb, "blue accent did not reach native text color");

    const toggle = centerPoint(initial, "Use rose");
    const afterRose = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: toggle.x, y: toggle.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: toggle.x, y: toggle.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    assert.equal(textOp(afterRose, "Accent sample").color, 0xffbe123c, "rose accent did not reach native text color");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 60_000);
