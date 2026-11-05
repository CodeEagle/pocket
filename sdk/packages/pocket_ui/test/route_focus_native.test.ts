import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = JsonObject & { type?: string; text?: string };
type Frame = { ops?: DrawOp[] };
type ProbeResponse = { frame?: Frame; error?: string };

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
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no responses: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ProbeResponse);
}

function lastFrame(responses: ProbeResponse[]): Frame {
  const frame = responses.flatMap((response) => response.frame ? [response.frame] : []).at(-1);
  assert.ok(frame, "route focus fixture did not produce a frame");
  return frame;
}

function textOp(frame: Frame, label: string): DrawOp {
  const op = (frame.ops ?? []).find((item) => item.type === "text" && item.text === label);
  assert.ok(op, `frame is missing ${label}`);
  return op;
}

function centerPoint(frame: Frame, label: string): { x: number; y: number } {
  const op = textOp(frame, label);
  return {
    x: Number(op.x) + Number(op.w) / 2,
    y: Number(op.y) + Number(op.h) / 2,
  };
}

function hasText(frame: Frame, label: string): boolean {
  return (frame.ops ?? []).some((item) => item.type === "text" && item.text === label);
}

test("retained RouteView blocks stale CIRCLE and hidden-route d-pad focus", () => {
  assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-route-focus-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "route-focus-native-fixture", private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({ appId: "pocket.test.route-focus", entry: "app.tsx" }),
    );
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(
      join(project, "app.tsx"),
      `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { focusNode } from "@pocketjs/framework/input";
import { FocusScope, Screen, Text, View } from "@pocketjs/framework/solid/components";
import { RouteView } from "@pocket/ui";

function App() {
  const [route, setRoute] = createSignal<"old" | "new">("old");
  const [oldCount, setOldCount] = createSignal(0);
  const [newCount, setNewCount] = createSignal(0);
  let oldButton: any;

  const switchRoute = () => {
    // Reproduce a real push boundary: the old route is focused just before
    // its retained slot becomes Display.None.
    focusNode(oldButton ?? null);
    setRoute("new");
  };

  const switchRouteWithoutFocus = () => {
    focusNode(oldButton ?? null);
    setRoute("new");
    focusNode(null);
  };

  return (
    <Screen class="w-full h-full flex-col p-4">
      <FocusScope class="flex-1 flex-col gap-3" autoFocus>
        <Text>{() => \`Old count: \${oldCount()}\`}</Text>
        <Text>{() => \`New count: \${newCount()}\`}</Text>
        <RouteView active={() => route() === "old"}>
          <View
            class="p-4 bg-[#E8EDFF]"
            focusable
            ref={(node) => (oldButton = node)}
            onPress={() => setOldCount((value) => value + 1)}
          >
            <Text>Old action</Text>
          </View>
        </RouteView>
        <RouteView active={() => route() === "new"}>
          <View class="p-4 bg-[#E8EDFF]" focusable onPress={() => setNewCount((value) => value + 1)}>
            <Text>New action</Text>
          </View>
        </RouteView>
        <View class="p-4 bg-[#315DEB]" focusable onPress={switchRoute}>
          <Text class="text-white">Switch route</Text>
        </View>
        <View class="p-4 bg-[#315DEB]" focusable onPress={switchRouteWithoutFocus}>
          <Text class="text-white">Switch clear</Text>
        </View>
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
    assert.ok(existsSync(bytecodePath), "route focus fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "route focus fixture PAK is missing");

    const initial = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    assert.ok(hasText(initial, "Old action"), "old route should be visible before push");
    assert.equal(hasText(initial, "New action"), false, "new retained route should start hidden");

    const switchPoint = centerPoint(initial, "Switch route");
    const clearPoint = centerPoint(initial, "Switch clear");
    const circle = 0x2000;
    const down = 0x0040;
    const afterSwitch = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: switchPoint.x, y: switchPoint.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: switchPoint.x, y: switchPoint.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.buttons", payload: { buttons: circle } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.buttons", payload: { buttons: 0 } } },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    assert.ok(hasText(afterSwitch, "New action"), "new route should be visible after push");
    assert.equal(hasText(afterSwitch, "Old action"), false, "old route should be hidden after push");
    assert.ok(hasText(afterSwitch, "Old count: 0"), "stale CIRCLE activated the hidden old route");
    assert.ok(hasText(afterSwitch, "New count: 0"), "new route changed before D-pad activation");

    const final = lastFrame(runProbe([
      { op: "create", width: 390, height: 760 },
      { op: "loadBytecode", bytecodePath, pakPath },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: clearPoint.x, y: clearPoint.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: clearPoint.x, y: clearPoint.y } } },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.buttons", payload: { buttons: down } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.buttons", payload: { buttons: 0 } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.buttons", payload: { buttons: circle } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.buttons", payload: { buttons: 0 } } },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]));
    assert.ok(hasText(final, "New count: 1"), "D-pad did not reach the active route button");
    assert.ok(hasText(final, "Old count: 0"), "hidden old route changed during D-pad/CIRCLE traversal");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
