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
type Bounds = { x: number; y: number; w: number; h: number };

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

function textOf(frame: Frame): string {
  return (frame.ops ?? [])
    .filter((op) => op.type === "text" && typeof op.text === "string")
    .map((op) => op.text)
    .join("\n");
}

function textOp(frame: Frame, needle: string, name: string): DrawOp {
  const textOps = (frame.ops ?? []).filter(
    (item) => item.type === "text" && typeof item.text === "string" && item.text.includes(needle),
  );
  const op = textOps.find((item) => item.text === needle) ?? textOps[0];
  assert.ok(op, `${name} is missing text containing ${needle}`);
  return op!;
}

function bounds(op: DrawOp, name: string): Bounds {
  for (const key of ["x", "y", "w", "h"] as const)
    assert.equal(typeof op[key], "number", `${name} must expose ${key}`);
  return { x: op.x!, y: op.y!, w: op.w!, h: op.h! };
}

function contains(outer: Bounds, inner: Bounds, epsilon = 0.5): boolean {
  return inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.w <= outer.x + outer.w + epsilon &&
    inner.y + inner.h <= outer.y + outer.h + epsilon;
}

function cardBounds(frame: Frame, width: number, anchors: string[], name: string): Bounds {
  const anchorBounds = anchors.map((needle) => bounds(textOp(frame, needle, `${name} anchor`), `${name} ${needle}`));
  const candidates = (frame.ops ?? [])
    .filter((op) => op.type === "rect" || op.type === "rounded")
    .map((op) => {
      try {
        return bounds(op, `${name} card candidate`);
      } catch {
        return undefined;
      }
    })
    .filter((candidate): candidate is Bounds => Boolean(candidate))
    .filter((candidate) => candidate.x > 0 && candidate.w > width * 0.6 && candidate.w < width - 1)
    .filter((candidate) => anchorBounds.every((anchor) => contains(candidate, anchor)));
  assert.ok(candidates.length > 0, `${name} did not expose a bounded card rect around its content`);
  return candidates.sort((left, right) => left.w * left.h - right.w * right.h)[0]!;
}

function assertFeedbackLayout(
  frame: Frame,
  width: number,
  name: string,
  anchors: string[],
  actions: string[],
): void {
  const card = cardBounds(frame, width, anchors, name);
  const content = anchors.map((needle) => bounds(textOp(frame, needle, name), `${name} ${needle}`));
  const actionBounds = actions.map((needle) => bounds(textOp(frame, needle, name), `${name} ${needle}`));
  for (const [index, item] of [...content, ...actionBounds].entries()) {
    assert.ok(contains({ x: 0, y: 0, w: width, h: 640 }, item), `${name} text/action ${index} escaped the viewport`);
    assert.ok(contains(card, item), `${name} text/action ${index} escaped its card: card=${JSON.stringify(card)} item=${JSON.stringify(item)}`);
  }
  const contentBottom = Math.max(...content.map((item) => item.y + item.h));
  const actionTop = Math.min(...actionBounds.map((item) => item.y));
  assert.ok(actionTop >= contentBottom - 0.5, `${name} actions must occupy a row below the wrapped content`);
}

function bootstrap(width: number, bytecodePath: string, pakPath: string): JsonObject[] {
  return [
    { op: "create", width, height: 640 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "frame", deltaMs: 16 },
    ...Array.from({ length: 8 }, () => ({ op: "frame", deltaMs: 16 })),
  ];
}

test("MobileAlert and MobileToast keep wrapped content/actions inside compact cards", () => {
  assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required; set POCKET_NATIVE_PROBE");
  const project = mkdtempSync(join(tmpdir(), "pocket-ui-feedback-native-"));
  const output = join(project, "out");
  try {
    writeFileSync(
      join(project, "package.json"),
      JSON.stringify({ name: "feedback-native-fixture", private: true, type: "module" }),
    );
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({ appId: "pocket.test.feedback", entry: "app.tsx" }),
    );
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
    writeFileSync(
      join(project, "app.tsx"),
      `import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { FocusScope, Screen, Text } from "@pocketjs/framework/solid/components";
import {
  MobileAlert,
  MobileCard,
  MobileScaffold,
  MobileThemeProvider,
  MobileToast,
} from "@pocket/ui";

function App() {
  const [alertOpen, setAlertOpen] = createSignal(true);
  const [toastOpen, setToastOpen] = createSignal(true);
  return (
    <Screen class="w-full h-full flex-col bg-[#F5F6FA]">
      <FocusScope class="flex-1 flex-col" autoFocus>
        <MobileThemeProvider>
          <MobileScaffold class="flex-col gap-3 p-4 bg-[#F5F6FA]">
            <MobileCard title="Feedback & Overlays" detail="Wrapped feedback content and actions.">
              <MobileAlert
                open={alertOpen()}
                tone="warning"
                title="Alert overflow title"
                body="A long alert body explains why message content must wrap inside its available column without pushing Dismiss beyond the card edge."
                actionLabel="Review"
                onAction={() => setAlertOpen(false)}
                closable
                onClose={() => setAlertOpen(false)}
              />
              <MobileToast
                open={toastOpen()}
                tone="info"
                message="Toast overflow message"
                detail="A long toast detail must wrap inside the content row while Undo and Hide remain inside the same card."
                actionLabel="Undo"
                onAction={() => setToastOpen(false)}
                onClose={() => setToastOpen(false)}
              />
            </MobileCard>
            <Text>Feedback fixture ready</Text>
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
    assert.ok(existsSync(bytecodePath), "feedback fixture bytecode is missing");
    assert.ok(existsSync(pakPath), "feedback fixture PAK is missing");

    for (const width of [320, 390]) {
      const frame = framesOf(runProbe([
        ...bootstrap(width, bytecodePath, pakPath),
        { op: "quit" },
      ])).at(-1)!;
      assert.match(textOf(frame), /Alert overflow title/);
      assert.match(textOf(frame), /Toast overflow message/);
      assertFeedbackLayout(
        frame,
        width,
        `${width}px Alert`,
        ["Alert overflow title", "A long alert body"],
        ["Review", "Dismiss"],
      );
      assertFeedbackLayout(
        frame,
        width,
        `${width}px Toast`,
        ["Toast overflow message", "A long toast detail"],
        ["Undo", "Hide"],
      );
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 150_000);

