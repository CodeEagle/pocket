import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  resolveSystemDocument,
  validateSystemDocument,
  validateSystemFile,
} from "../scripts/build_system.ts";
import { POCKET_FLUTTER_TARGET_ID } from "../scripts/flutter_target.ts";

const demoJsRoot = resolve(import.meta.dir, "../../demo/js");
const systemDocument = JSON.parse(readFileSync(join(demoJsRoot, "pocket.system.json"), "utf8")) as Record<string, any>;
const fixtureRoots: string[] = [];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fixture(): { readonly root: string; readonly document: Record<string, any> } {
  const root = mkdtempSync(join(tmpdir(), "pocket-system-contract-"));
  fixtureRoots.push(root);
  for (const { manifest: relativePath } of systemDocument.applications.catalog) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), readFileSync(join(demoJsRoot, relativePath)));
  }
  return { root, document: clone(systemDocument) };
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PocketSystemV1 build validation", () => {
  test("accepts the demo's official contract and all four installed package manifests", async () => {
    const result = await validateSystemFile(join(demoJsRoot, "pocket.system.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.value.kind).toBe("validated-pocket-system-contract");
    expect(result.value.contract.roles.systemUI).toBe("pocket.host.demo");
    expect(result.value.contract.applications.backgroundExecution).toBe("suspend");
    expect(result.value.contract.installation.installedPackages).toEqual([
      "pocket.host.demo",
      "pocket.demo.lantern",
      "pocket.demo.profile",
      "pocket.demo.lobby",
    ]);
    expect(result.value.packages.map((entry) => entry.package)).toEqual([
      "pocket.host.demo",
      "pocket.demo.lantern",
      "pocket.demo.profile",
      "pocket.demo.lobby",
    ]);
    expect(result.value.packages.every((entry) => entry.installed)).toBe(true);
    expect(result.value.packages.map((entry) => entry.manifest.id)).toEqual([
      "pocket.host.demo",
      "pocket.demo.lantern",
      "pocket.demo.profile",
      "pocket.demo.lobby",
    ]);
    expect(result.value.contract.applications.catalog[0]?.memory).toEqual({
      heapLimitBytes: 134217728,
      maxPakBytes: 8388608,
    });
    expect(result.value.contract.applications.catalog[2]?.memory).toEqual({
      heapLimitBytes: 134217728,
    });
    expect(result.value.contract.applications.catalog[2]?.memoryPolicy).toBe("UI_MINI");
    expect(result.value.contract.applications.catalog[3]?.memory).toEqual({
      maxPakBytes: 8388608,
    });
  });

  test("preserves normalized memory requests in a resolved target plan", async () => {
    const result = await resolveSystemDocument(systemDocument, {
      appRoot: demoJsRoot,
      target: POCKET_FLUTTER_TARGET_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.plan.systemUI.memory).toEqual({
      heapLimitBytes: 134217728,
      maxPakBytes: 8388608,
    });
    expect(result.plan.applications.find((entry) => entry.package === "pocket.demo.profile")?.memory).toEqual({ heapLimitBytes: 134217728 });
    expect(result.plan.applications.find((entry) => entry.package === "pocket.demo.profile")?.memoryPolicy).toBe("UI_MINI");
  });

  test("rejects malformed memory values, unknown fields, and tier conflicts", async () => {
    const invalid = clone(systemDocument);
    invalid.applications.catalog[0].memory = { heapLimitBytes: 0 };
    const invalidResult = await validateSystemDocument(invalid, { appRoot: demoJsRoot });
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) expect(invalidResult.diagnostics.map((item) => item.code)).toContain("system.invalidMemoryBudget");

    const unknown = clone(systemDocument);
    unknown.applications.catalog[0].memory = { maxPakBytes: 1, gcThreshold: 2 };
    const unknownResult = await validateSystemDocument(unknown, { appRoot: demoJsRoot });
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) expect(unknownResult.diagnostics.map((item) => item.code)).toContain("system.invalidMemoryBudget");

    const conflict = clone(systemDocument);
    conflict.applications.catalog[0].memoryPolicy = "UI_MINI";
    conflict.applications.catalog[0].memory = { heapLimitBytes: 64 * 1024 };
    const conflictResult = await validateSystemDocument(conflict, { appRoot: demoJsRoot });
    expect(conflictResult.ok).toBe(false);
    if (!conflictResult.ok) expect(conflictResult.diagnostics.map((item) => item.code)).toContain("system.memoryPolicyMismatch");
  });

  test("uses the official schema validator before semantic checks", async () => {
    const invalidSchema = clone(systemDocument);
    invalidSchema.pocketSystem = 2;
    const result = await validateSystemDocument(invalidSchema, { appRoot: demoJsRoot });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid official schema unexpectedly passed");
    expect(result.diagnostics.some((item) => item.path === "/pocketSystem")).toBe(true);
  });

  test("requires systemUI to be cataloged, required, and installed", async () => {
    const missing = clone(systemDocument);
    missing.roles.systemUI = "pocket.demo.missing";
    const missingResult = await validateSystemDocument(missing, { appRoot: demoJsRoot });
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.diagnostics.map((item) => item.code)).toContain("system.systemUIMissing");

    const removable = clone(systemDocument);
    removable.applications.catalog[0].required = false;
    const removableResult = await validateSystemDocument(removable, { appRoot: demoJsRoot });
    expect(removableResult.ok).toBe(false);
    if (!removableResult.ok) expect(removableResult.diagnostics.map((item) => item.code)).toContain("system.systemUIRemovable");

    const absent = clone(systemDocument);
    absent.installation.installedPackages = absent.installation.installedPackages.filter((id: string) => id !== "pocket.host.demo");
    const absentResult = await validateSystemDocument(absent, { appRoot: demoJsRoot });
    expect(absentResult.ok).toBe(false);
    if (!absentResult.ok) {
      expect(absentResult.diagnostics.map((item) => item.code)).toContain("system.requiredPackageNotInstalled");
      expect(absentResult.diagnostics.map((item) => item.code)).toContain("system.systemUINotInstalled");
    }
  });

  test("rejects duplicate catalog package and manifest identities", async () => {
    const { root, document } = fixture();
    document.applications.catalog.push(clone(document.applications.catalog[1]));
    const result = await validateSystemDocument(document, { appRoot: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain("system.duplicatePackage");
      expect(result.diagnostics.map((item) => item.code)).toContain("system.duplicateManifest");
    }
  });

  test("rejects a catalog package whose manifest declares a different id", async () => {
    const { root, document } = fixture();
    const showcasePath = join(root, "pocket.json");
    const showcase = JSON.parse(readFileSync(showcasePath, "utf8")) as Record<string, any>;
    showcase.id = "pocket.host.other";
    writeFileSync(showcasePath, JSON.stringify(showcase));

    const result = await validateSystemDocument(document, { appRoot: root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("system.packageMismatch");
  });

  test("rejects duplicate package output names", async () => {
    const { root, document } = fixture();
    const profilePath = join(root, "apps/profile/pocket.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, any>;
    profile.app.output = "showcase-app";
    writeFileSync(profilePath, JSON.stringify(profile));

    const result = await validateSystemDocument(document, { appRoot: root });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("system.duplicateOutput");
  });

  test("does not emit a plan without an explicit registered target", async () => {
    const noTarget = await resolveSystemDocument(systemDocument, { appRoot: demoJsRoot });
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) expect(noTarget.diagnostics[0]?.code).toBe("system.targetRequired");

    const unknownTarget = await resolveSystemDocument(systemDocument, { appRoot: demoJsRoot, target: "flutter-canvas-poc" });
    expect(unknownTarget.ok).toBe(false);
    if (!unknownTarget.ok) expect(unknownTarget.diagnostics[0]?.code).toBe("target.unknown");
  });

  test("does not infer missing compositor capability from the Flutter host", async () => {
    const { root, document } = fixture();
    for (const { manifest: relativePath } of systemDocument.applications.catalog) {
      const path = join(root, relativePath);
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
      manifest.engine.capabilities.requires = ["text.glyphs.baked"];
      manifest.engine.capabilities.enhances = [];
      manifest.app.viewport.fixed.logical = [800, 600];
      writeFileSync(path, JSON.stringify(manifest, null, 2));
    }
    const result = await resolveSystemDocument(document, { appRoot: root, target: "web-app" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("system.systemUICapabilityMissing");
  });

  test("resolves the demo with the official Pocket Flutter target and handles", async () => {
    const result = await resolveSystemDocument(systemDocument, {
      appRoot: demoJsRoot,
      target: POCKET_FLUTTER_TARGET_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));

    expect(result.plan.target.id).toBe(POCKET_FLUTTER_TARGET_ID);
    expect(result.plan.systemUI.package).toBe("pocket.host.demo");
    expect(result.plan.applications.map((application) => application.package)).toEqual([
      "pocket.demo.lantern",
      "pocket.demo.profile",
      "pocket.demo.lobby",
    ]);
    expect(result.compositorSurfaces).toEqual({
      "pocket.demo.lantern": 2,
      "pocket.demo.profile": 3,
      "pocket.demo.lobby": 4,
    });
  });

  test("CLI requires a PocketSystemV1 file instead of selecting a bundled demo", () => {
    const script = resolve(import.meta.dir, "../scripts/build_system.ts");
    const result = spawnSync("bun", [script], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: bun sdk/scripts/build_system.ts <pocket.system.json>");
    expect(result.stdout).toBe("");
  });
});
