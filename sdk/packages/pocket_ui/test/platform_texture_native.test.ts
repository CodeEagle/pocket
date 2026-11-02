import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

type JsonObject = Record<string, unknown>;
type DrawOp = JsonObject & { type?: string };
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
assert.ok(probe && existsSync(probe), "a bytecode-capable pocket_probe is required");

const project = mkdtempSync(join(tmpdir(), "pocket-ui-platform-texture-native-"));
const output = join(project, "out");
const app = `import { mount } from "@pocketjs/framework/solid";
import { Screen, View } from "@pocketjs/framework/solid/components";
import { PlatformTextureSurface } from "@pocket/ui";

function App() {
  return <Screen>
    <View class="flex-col gap-2 p-4">
      <PlatformTextureSurface textureId={11} sourceWidth={640} sourceHeight={480} class="w-full h-[80]" />
      <PlatformTextureSurface textureId={12} sourceWidth={640} sourceHeight={480} radius={0} class="w-full h-[80]" />
      <PlatformTextureSurface textureId={13} sourceWidth={640} sourceHeight={480} radius={-8} class="w-full h-[80]" />
      <PlatformTextureSurface textureId={14} sourceWidth={640} sourceHeight={480} radius={Number.NaN} class="w-full h-[80]" />
      <PlatformTextureSurface textureId={15} sourceWidth={640} sourceHeight={480} radius={999} class="w-full h-[80]" />
    </View>
  </Screen>;
}

mount(() => <App />);
`;

function runProbe(commands: JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe!, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return String(result.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeResponse);
}

try {
  writeFileSync(join(project, "app.tsx"), app);
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: "pocket-ui-platform-texture-native-fixture",
    version: "0.1.0",
    private: true,
    type: "module",
  }));
  writeFileSync(join(project, "pocket.json"), JSON.stringify({
    "$schema": "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.pocket.ui.platform-texture-native-fixture",
    version: "0.1.0",
    app: {
      entry: "app.tsx",
      output: "app",
      framework: "solid",
      viewport: { fixed: { logical: [360, 640], presentation: "native" } },
    },
  }));
  writeFileSync(join(project, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));

  const build = spawnSync("bun", [buildGuest, `--project-root=${project}`, `--outdir=${output}`], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const bytecodePath = join(output, "app.qjbc");
  const pakPath = join(output, "app.pak");
  assert.ok(existsSync(bytecodePath), "platform texture fixture bytecode is missing");
  assert.ok(existsSync(pakPath), "platform texture fixture PAK is missing");

  const responses = runProbe([
    { op: "create", width: 360, height: 640 },
    { op: "loadBytecode", bytecodePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "quit" },
  ]);
  const frame = responses.find((response) => response.frame)?.frame;
  assert.ok(frame, "platform texture fixture did not produce a frame");
  const surfaces = (frame.ops ?? []).filter((op) => op.type === "hostSurface");
  assert.equal(surfaces.length, 5, "all platform texture surfaces must reach native hostSurface");
  const radiusByTexture = new Map<number, number>();
  for (const op of surfaces) {
    const descriptor = JSON.parse(String(op.asset ?? "{}")) as { kind?: string; parameters?: JsonObject };
    assert.equal(descriptor.kind, "platformTexture");
    const parameters = descriptor.parameters ?? {};
    radiusByTexture.set(Number(parameters.textureId), Number(parameters.radius));
  }
  assert.equal(radiusByTexture.get(11), 12, "default radius must match rounded-xl");
  assert.equal(radiusByTexture.get(12), 0, "explicit zero must preserve square corners");
  assert.equal(radiusByTexture.get(13), 0, "negative radius must clamp to zero");
  assert.equal(radiusByTexture.get(14), 12, "non-finite radius must use the safe default");
  assert.equal(radiusByTexture.get(15), 200, "oversized radius must be bounded");

  // Keep the fixture source readable in a failed test log without making the
  // native assertion depend on a generated source artifact.
  assert.match(readFileSync(join(project, "app.tsx"), "utf8"), /PlatformTextureSurface/);
  console.log(`platform_texture_native.test: hostSurface radius payload passed (${probe})`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
