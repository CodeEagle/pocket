import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { test } from "bun:test";
import { buildGuest } from "../build_guest.ts";

type JsonObject = Record<string, unknown>;
type DrawOp = {
  readonly type?: string;
  readonly asset?: string;
  readonly w?: number;
};
type FrameResource = {
  readonly asset?: string;
  readonly revision?: number;
  readonly width?: number;
  readonly height?: number;
  readonly pixels?: readonly number[];
};
type Frame = {
  readonly ops?: readonly DrawOp[];
  readonly resources?: readonly FrameResource[];
  readonly releasedResources?: readonly string[];
};
type ProbeResponse = {
  readonly ok?: boolean;
  readonly error?: string;
  readonly frame?: Frame;
};

const TEST_TIMEOUT_MS = 180_000;
const repositoryRoot = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repositoryRoot, "sdk");
const assetKey = "art/reload.png";

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

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
    }
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

function rgbaPng(rgba: readonly number[]): Buffer {
  assert.equal(rgba.length, 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  const row = Buffer.from([0, ...rgba, ...rgba]);
  const pixels = Buffer.concat([row, row]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function runProbe(probe: string, commands: readonly JsonObject[]): ProbeResponse[] {
  const result = spawnSync(probe, {
    input: `${commands.map(command => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `pocket_probe exited ${String(result.status)}: ${result.stderr || result.stdout}`,
  );
  const output = String(result.stdout ?? "").trim();
  assert.ok(output, `pocket_probe returned no output: ${result.stderr || ""}`);
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as ProbeResponse);
}

function appSource(): string {
  return `
import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Focusable, Image, Screen, Text } from "@pocketjs/framework/solid/components";

const [expanded, setExpanded] = createSignal(false);
mount(() => <Screen class="relative w-full h-full">
  <Focusable class="absolute left-0 top-0 w-[100] h-[32] bg-[#334455] flex items-center justify-center" onPress={() => setExpanded(value => !value)}>
    <Text class="text-sm text-white">reload-toggle</Text>
  </Focusable>
  <Image src="${assetKey}" class={expanded() ? "absolute left-0 top-[40] w-[40] h-[20]" : "absolute left-0 top-[40] w-[20] h-[20]"} />
</Screen>);
`;
}

test(
  "pinned Guest reload replaces same-key image pixels and retires old public resource generation",
  async () => {
    const probe = nativeProbePath();
    assert.ok(
      probe,
      "set POCKET_NATIVE_PROBE to the release pocket_probe used for this reload validation",
    );

    const project = mkdtempSync(join(tmpdir(), "pocket-package-reload-guest-"));
    const imagePath = join(project, assetKey);
    try {
      writeFileSync(
        join(project, "pocket.json"),
        JSON.stringify({
          pocket: 2,
          id: "fixture.package.reload",
          app: { entry: "app.tsx", framework: "solid" },
        }),
      );
      writeFileSync(
        join(project, "manifest.json"),
        JSON.stringify({ pocket: 2, id: "fixture.package.reload", capabilities: { requires: [], optional: [] } }),
      );
      writeFileSync(join(project, "images.json"), JSON.stringify({ [assetKey]: { linear: true } }));
      writeFileSync(join(project, "app.tsx"), appSource());
      mkdirSync(join(project, "art"), { recursive: true });

      const red = [240, 12, 24, 255] as const;
      const blue = [16, 80, 224, 255] as const;
      writeFileSync(imagePath, rgbaPng(red));
      const first = await buildGuest({ projectRoot: project, outDir: join(project, "out-red") });
      const firstMetadata = JSON.parse(readFileSync(first.metadata, "utf8")) as JsonObject;
      assert.equal(firstMetadata.entryFormat, "quickjs-bytecode");
      assert.ok(existsSync(first.bytecode) && existsSync(first.pak));

      writeFileSync(imagePath, rgbaPng(blue));
      const second = await buildGuest({ projectRoot: project, outDir: join(project, "out-blue") });
      const secondMetadata = JSON.parse(readFileSync(second.metadata, "utf8")) as JsonObject;
      assert.equal(secondMetadata.entryFormat, "quickjs-bytecode");
      assert.ok(existsSync(second.bytecode) && existsSync(second.pak));

      // One native host handle is created once; the same two pinned Guest
      // packages are then reloaded A -> B -> A. Each generation receives real
      // pointer input so an image draw op must change from 20px to 40px.
      const commands: JsonObject[] = [
        { op: "create", width: 120, height: 100 },
        { op: "loadBytecode", bytecodePath: first.bytecode, pakPath: first.pak, render: true },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 10, y: 10 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 10, y: 10 } } },
        { op: "frame", deltaMs: 16 },
        { op: "loadBytecode", bytecodePath: second.bytecode, pakPath: second.pak, render: true },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 10, y: 10 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 10, y: 10 } } },
        { op: "frame", deltaMs: 16 },
        { op: "loadBytecode", bytecodePath: first.bytecode, pakPath: first.pak, render: true },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "down", id: 0, x: 10, y: 10 } } },
        { op: "frame", deltaMs: 16 },
        { op: "send", message: { type: "event", name: "input.pointer", payload: { phase: "up", id: 0, x: 10, y: 10 } } },
        { op: "frame", deltaMs: 16 },
        { op: "quit" },
      ];
      const responses = runProbe(probe, commands);
      assert.equal(responses.length, commands.length, "probe must return one response per public operation");
      assert.ok(responses.every(response => response.ok !== false), `probe errors: ${JSON.stringify(responses.filter(response => response.ok === false))}`);

      const loadFrames = [responses[1].frame, responses[6].frame, responses[11].frame];
      assert.ok(loadFrames.every((frame): frame is Frame => frame !== undefined), "each loadBytecode(render:true) must return its first rendered frame");
      const resourcePixels = loadFrames.map(frame => {
        const resource = frame.resources?.find(item => item.asset === assetKey);
        assert.ok(resource, `FrameResource ${assetKey} must be present after package load`);
        assert.equal(resource.width, 2);
        assert.equal(resource.height, 2);
        return resource.pixels ?? [];
      });
      const expectedPixels = (rgba: readonly number[]) => Array.from({ length: 4 }, () => [...rgba]).flat();
      assert.deepEqual(resourcePixels[0], expectedPixels(red), "first generation must export the red fixture pixels");
      assert.deepEqual(resourcePixels[1], expectedPixels(blue), "same-key replacement must export the blue fixture pixels");
      assert.deepEqual(resourcePixels[2], expectedPixels(red), "second reload must restore the first fixture pixels");

      assert.deepEqual(loadFrames[0]!.releasedResources ?? [], [], "initial load has no older confirmed image resource to release");
      for (const [index, frame] of loadFrames.slice(1).entries()) {
        assert.ok(
          frame.releasedResources?.includes(assetKey),
          `reload ${index + 1} must release the previous same-key FrameResource generation`,
        );
      }

      const inputFrames = [responses[5].frame, responses[10].frame, responses[15].frame];
      for (const [index, frame] of inputFrames.entries()) {
        const images = frame?.ops?.filter(op => op.type === "image" && op.asset === assetKey) ?? [];
        assert.equal(images.length, 1, `input-driven frame ${index + 1} must draw the registered image`);
        assert.equal(images[0]?.w, 40, `real pointer input must change image geometry in generation ${index + 1}: ${JSON.stringify(frame)}`);
      }
      for (const [index, frame] of loadFrames.entries()) {
        const image = frame.ops?.find(op => op.type === "image" && op.asset === assetKey);
        assert.equal(image?.w, 20, `generation ${index + 1} must start from its default 20px geometry`);
      }

      console.log("package_reload_guest: " + JSON.stringify({
        probe,
        buildGuestEntryFormat: firstMetadata.entryFormat,
        loadOrder: ["red", "blue", "red"],
        sameAssetKey: assetKey,
        firstPixelPerGeneration: resourcePixels.map(pixels => pixels.slice(0, 4)),
        releaseRecorded: loadFrames.map(frame => frame.releasedResources?.includes(assetKey) ?? false),
        imageWidthBeforeInput: loadFrames.map(frame => frame.ops?.find(op => op.type === "image" && op.asset === assetKey)?.w),
        imageWidthAfterInput: inputFrames.map(frame => frame?.ops?.find(op => op.type === "image" && op.asset === assetKey)?.w),
        reloadsOnOneHandle: 3,
      }));
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  },
  240_000,
);
