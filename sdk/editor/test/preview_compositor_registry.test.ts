import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compositorSurfacesFromProject } from "../preview.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "pocket-preview-surfaces-"));
  roots.push(root);
  writeFileSync(join(root, "pocket.system.json"), JSON.stringify({
    pocketSystem: 1,
    roles: { systemUI: "system.app" },
    applications: { catalog: [
      { package: "system.app", manifest: "pocket.json", required: true },
      { package: "child.app", manifest: "child/pocket.json", required: true },
    ] },
    installation: { installedPackages: ["system.app", "child.app"] },
  }));
  return root;
}

describe("generated Editor compositor registry", () => {
  test("uses the completed-build registry while retaining manifest children", async () => {
    const root = project();
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "compositor-surfaces.json"), JSON.stringify({
      schemaVersion: 1,
      surfaces: { "child.app": 2, "generated.app": 4 },
      applications: {
        "generated.app": { title: "Generated App", assetDirectory: "apps/generated" },
      },
    }));
    expect(await compositorSurfacesFromProject(root)).toEqual({ "child.app": 2, "generated.app": 4 });
  });

  test("rejects a generated registry that drops a static installed child", async () => {
    const root = project();
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "compositor-surfaces.json"), JSON.stringify({
      schemaVersion: 1,
      surfaces: { "generated.app": 4 },
    }));
    await expect(compositorSurfacesFromProject(root)).rejects.toThrow(/omits an installed manifest child/);
  });
});
