import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

type JsonObject = Record<string, unknown>;
type DrawOp = { readonly type?: string; readonly asset?: string; readonly text?: string; readonly points?: readonly { x: number; y: number }[] };
type Frame = { readonly ops?: readonly DrawOp[] };
type ProbeResponse = { readonly ok?: boolean; readonly error?: string; readonly frame?: Frame };

const repositoryRoot = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repositoryRoot, "sdk");

function nativeProbePath(): string | undefined {
  const configured = process.env.POCKET_NATIVE_PROBE;
  const candidates = configured
    ? [resolve(configured)]
    : [
        join(sdkRoot, "native/target/aarch64-apple-darwin/release/pocket_probe"),
        join(sdkRoot, "native/target/release/pocket_probe"),
        join(sdkRoot, "native/target/debug/pocket_probe"),
      ];
  return candidates.find(existsSync);
}

function runProbe(probe: string, commands: readonly JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map(command => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`);
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  return output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as ProbeResponse);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function pngChunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, "ascii");
  const payload = Buffer.from(data);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return Buffer.concat([length, type, payload, checksum]);
}

function skinFixturePng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => [16, 32, 48, 255]).flat()]);
  const pixels = Buffer.concat([row, row, row, row]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("pinned guest keeps the skin texture on its Image node and passes taps to its parent control", async () => {
  const probe = nativeProbePath();
  assert.ok(probe, "a bytecode-capable pocket_probe is required for the native skin hit-pass check");
  const project = mkdtempSync(join(tmpdir(), "pocket-skin-guest-"));
  const source = join(project, "vendor/pocket-vn/src");
  const output = join(project, "out");
  try {
    mkdirSync(source, { recursive: true });
    for (const file of ["skin.ts", "mesh.ts", "mesh-view.tsx", "skin-view.tsx"]) {
      copyFileSync(join(sdkRoot, "packages/pocket_vn/src", file), join(source, file));
    }
    writeFileSync(join(project, "vendor/pocket-vn/package.json"), JSON.stringify({
      name: "@pocket/vn",
      type: "module",
      exports: { "./skin-view": "./src/skin-view.tsx" },
    }));
    writeFileSync(join(project, "package.json"), JSON.stringify({ dependencies: { "@pocket/vn": "file:vendor/pocket-vn" } }));
    writeFileSync(join(project, "pocket.json"), JSON.stringify({ pocket: 2, id: "fixture.skin", app: { entry: "app.tsx", framework: "solid" } }));
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ pocket: 2, id: "fixture.skin", capabilities: { requires: [], optional: [] } }));
    writeFileSync(join(project, "images.json"), JSON.stringify({ "art/ui/frame.png": { linear: true } }));
    mkdirSync(join(project, "art/ui"), { recursive: true });
    writeFileSync(join(project, "art/ui/frame.png"), skinFixturePng());
    writeFileSync(join(project, "app.tsx"), `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Screen, Text } from "@pocketjs/framework/solid/components";
import { NovelSkinFrame } from "@pocket/vn/skin-view";
const [pressed, setPressed] = createSignal(false);
mount(() => <Screen class="relative w-full h-full">
  <Focusable class="absolute left-0 top-0 w-[100] h-[90]" onPress={() => setPressed(true)}>
    <Text class="absolute left-0 top-0">skin hit target={pressed() ? "pressed" : "idle"}</Text>
    <NovelSkinFrame frame={{ image: "art/ui/frame.png", width: 4, height: 4, inset: 1 }} width={100} height={90} border={40} debugName="skin-frame" />
  </Focusable>
</Screen>);
`);

    const built = await buildGuest({ projectRoot: project, outDir: output });
    const responses = runProbe(probe, [
      { op: "create", width: 320, height: 240 },
      { op: "loadBytecode", bytecodePath: built.bytecode, pakPath: built.pak },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 30, y: 20 } } },
      { op: "frame", deltaMs: 16 },
      { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 30, y: 20 } } },
      { op: "frame", deltaMs: 16 },
      { op: "frame", deltaMs: 16 },
      { op: "quit" },
    ]);
    const frames = responses.flatMap(response => response.frame ? [response.frame] : []);
    const painted = frames.at(-1);
    assert.ok(frames.some(frame => frame.ops?.some(op => op.type === "text" && op.text?.includes("skin hit target=idle"))));
    assert.ok(painted?.ops?.some(op => op.type === "text" && op.text?.includes("skin hit target=pressed")), "the parent Focusable must receive taps through the skin image's hitPass");
    const triangles = painted?.ops?.filter(op => op.type === "textureTriangle") ?? [];
    assert.equal(triangles.length, 18, "nine slices must use eighteen PMS1 triangles");
    assert.ok(triangles.every(op => op.asset === "art/ui/frame.png"), "all slice triangles must borrow the frame's registered Image texture");
    const points = triangles.flatMap(op => op.points ?? []);
    assert.equal(Math.min(...points.map(point => point.x)), 0);
    assert.equal(Math.min(...points.map(point => point.y)), 0);
    assert.equal(Math.max(...points.map(point => point.x)), 100);
    assert.equal(Math.max(...points.map(point => point.y)), 90);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 150_000);
