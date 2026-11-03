import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWechat } from "../build_wechat.ts";

function writeProject(root: string, pocket: Record<string, unknown>): void {
  writeFileSync(join(root, "pocket.json"), `${JSON.stringify(pocket, null, 2)}\n`);
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ capabilities: { requires: [] } }));
  writeFileSync(join(root, "app.tsx"), "export default function App(){ return <text value='admission'/>; }\n");
}

test("build_wechat rejects domains.worker before output or guest/Cargo work", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-wechat-worker-admission-"));
  const output = join(project, "wechat-output");
  try {
    writeProject(project, {
      app: { entry: "app.tsx" },
      domains: {
        worker: {
          entry: "worker.ts",
          nodes: [],
          channels: [],
        },
      },
    });

    await expect(buildWechat({ projectRoot: project, outDir: output })).rejects.toThrow(
      /domains\.worker.*not supported/,
    );
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("build_wechat rejects PocketSystem before output creation", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-wechat-system-admission-"));
  const output = join(project, "wechat-output");
  try {
    writeProject(project, { app: { entry: "app.tsx" } });
    writeFileSync(join(project, "pocket.system.json"), "{}\n");

    await expect(buildWechat({ projectRoot: project, outDir: output })).rejects.toThrow(
      /PocketSystem dynamic child compositing is not supported/,
    );
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("build_wechat lets a single Guest reach the real guest admission stage", async () => {
  const project = mkdtempSync(join(tmpdir(), "pocket-wechat-single-guest-admission-"));
  const output = join(project, "wechat-output");
  try {
    writeProject(project, { app: { entry: "missing-app.tsx" } });

    // The missing entry fails inside the real buildGuest validation before the
    // compiler or native bytecode builder is invoked. The output directory's
    // existence proves the WeChat-only preflight did not reject this Guest.
    await expect(buildWechat({ projectRoot: project, outDir: output })).rejects.toThrow(
      /app entry does not exist/,
    );
    expect(existsSync(output)).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
