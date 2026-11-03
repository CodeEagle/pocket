import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";

import { buildGuest } from "../../../sdk/scripts/build_guest.ts";

const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(import.meta.dir, "../../..");
const sdkRoot = join(repositoryRoot, "sdk");
const systemSurfacesSource = join(
  sdkRoot,
  "packages/pocket_ui/src/system-surfaces.tsx",
);
const publicUiIndexSource = join(sdkRoot, "packages/pocket_ui/src/index.ts");

type FrameOp = {
  type?: string;
  id?: string;
  surfaceHandle?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  clip?: { x?: number; y?: number; w?: number; h?: number };
};

type ProbeResponse = {
  ok?: boolean;
  error?: string;
  frame?: { ops?: FrameOp[] };
};

function systemSurfaceDefaultClass(): string {
  const source = readFileSync(systemSurfacesSource, "utf8");
  const match = source.match(/props\.class\s*\?\?\s*"([^"]+)"/);
  assert.ok(match, "SystemAppSurfaces must keep a static default class literal");
  return match[1]!;
}

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

function probeFrame(probe: string, sourcePath: string, pakPath: string): ProbeResponse {
  const commands = [
    {
      op: "create",
      width: 120,
      height: 80,
      compositorSurfaces: { "app.child": 2 },
    },
    { op: "load", sourcePath, pakPath },
    { op: "frame", deltaMs: 16 },
    { op: "quit" },
  ];
  const result = spawnSync(probe, {
    input: `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `native surface compiler probe exited ${String(result.status)}: ${result.stderr || result.stdout}`,
  );
  const lines = String(result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 3, "native surface compiler probe returned too few responses");
  const responses = lines.map((line) => JSON.parse(line) as ProbeResponse);
  const frame = responses.find((response) => response.frame);
  assert.ok(frame, "native surface compiler probe did not return a frame");
  return frame;
}

test("SystemAppSurfaces default class survives the pinned compiler", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-system-surface-compiler-"));
  const output = join(project, "out");
  try {
    writeFileSync(
      join(project, "pocket.json"),
      JSON.stringify({
        pocket: 2,
        id: "app.system.surface.compiler",
        app: {
          entry: "app.tsx",
          framework: "solid",
          viewport: { fixed: { logical: [120, 80], presentation: "native" } },
        },
      }),
    );
    writeFileSync(
      join(project, "manifest.json"),
      JSON.stringify({ capabilities: { requires: ["ui.compositor-surfaces"] } }),
    );
    writeFileSync(
      join(project, "app.tsx"),
      `import { mount } from "@pocketjs/framework/solid";
import { Screen } from "@pocketjs/framework/solid/components";
import { SystemAppSurfaces } from "@pocket/ui";

const system = {
  surfaceBindings: () => [{ appId: "app.child", instanceId: "child-1", surfaceHandle: 2, focused: true }],
  subscribe: (_listener: () => void) => () => {},
};

mount(() => <Screen><SystemAppSurfaces system={system} /></Screen>);
`,
    );

    const result = await buildGuest({ projectRoot: project, outDir: output });
    const generated = readFileSync(result.source, "utf8");
    const defaultClass = systemSurfaceDefaultClass();
    const publicUiIndex = readFileSync(publicUiIndexSource, "utf8");
    assert.match(
      publicUiIndex,
      /system-surfaces(?:\.tsx)?/,
      "SystemAppSurfaces must be reachable through the public @pocket/ui entry",
    );
    assert.match(
      generated,
      new RegExp(`SystemAppSurfaces[\\s\\S]*${defaultClass.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}`),
      "generated bundle must retain the SystemAppSurfaces default class",
    );
    assert.ok(
      generated.includes(`"${defaultClass}":`),
      `generated STYLE_IDS must include the exact SystemAppSurfaces class: ${defaultClass}`,
    );

    const probe = nativeProbePath();
    if (!probe) {
      console.log("system_surface_compiler: native probe unavailable; compiler assertion passed");
      return;
    }
    const frame = probeFrame(probe, result.source, result.pak);
    assert.equal(frame.ok, true, `native frame failed: ${frame.error ?? "unknown error"}`);
    const surface = frame.frame?.ops?.find(
      (op) => op.type === "hostSurface" && op.id === "app.child",
    );
    assert.ok(surface, "SystemAppSurfaces must emit a native application surface");
    assert.equal(surface.surfaceHandle, 2);
    assert.ok((surface.w ?? 0) > 0 && (surface.h ?? 0) > 0, "surface bounds must be positive");
    assert.ok((surface.clip?.w ?? 0) > 0 && (surface.clip?.h ?? 0) > 0, "surface clip must be positive");
    console.log(`system_surface_compiler: compiler + native hostSurface path passed (${probe})`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);
