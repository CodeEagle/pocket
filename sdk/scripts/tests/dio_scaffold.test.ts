import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, patchAndroidHardwareManifest } from "../../pocket.ts";

const dioPackage = join(import.meta.dir, "../../packages/pocket_dio");

function readScaffold(root: string): { pubspec: string; dart: string; manifest: Record<string, any>; editor: Record<string, any> } {
  return {
    pubspec: readFileSync(join(root, "flutter/pubspec.yaml"), "utf8"),
    dart: readFileSync(join(root, "flutter/lib/main.dart"), "utf8"),
    manifest: JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")),
    editor: JSON.parse(readFileSync(join(root, "editor.json"), "utf8")),
  };
}

test("dio remains absent from the default scaffold", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-dio-default-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    const project = await initProject(join(root, "standard"));
    const scaffold = readScaffold(project);
    expect(scaffold.pubspec).not.toContain("pocket_dio");
    expect(scaffold.dart).not.toContain("PocketDioPlugin");
    expect(scaffold.manifest.capabilities.optional).not.toContain("dio.request");
    expect(scaffold.manifest.permissions.optional).not.toContain("network");
    expect(scaffold.editor.dio).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dio adds only the opt-in package, factory, permission, and capability", async () => {
  expect(existsSync(dioPackage)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "pocket-dio-optin-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    const project = await initProject(join(root, "dio"), { dio: true });
    const scaffold = readScaffold(project);
    expect(scaffold.pubspec).toContain("pocket_dio:");
    expect(scaffold.pubspec).toContain("packages/pocket_dio");
    expect(scaffold.dart).toContain("package:pocket_dio/pocket_dio.dart");
    expect(scaffold.dart).toContain("createDioPlugin");
    expect(scaffold.dart).toContain("PocketDioPlugin(allowedOrigins: const {})");
    expect(scaffold.dart).toContain("allowedOrigins is intentionally empty");
    expect(scaffold.dart).toContain("allowedPermissions: const {'network'}");
    expect(scaffold.manifest.capabilities.optional).toContain("dio.request");
    expect(scaffold.manifest.permissions.optional).toContain("network");
    expect(scaffold.editor.dio).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("dio composes with hardware and platform opt-ins", async () => {
  expect(existsSync(dioPackage)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "pocket-dio-combined-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    const project = await initProject(join(root, "combined"), {
      hardware: true,
      dio: true,
      platformExperience: true,
      deepLinkScheme: "pocketapp",
    });
    const scaffold = readScaffold(project);
    expect(scaffold.pubspec).toContain("pocket_hardware:");
    expect(scaffold.pubspec).toContain("pocket_dio:");
    expect(scaffold.pubspec).toContain("pocket_platform:");
    expect(scaffold.dart).toContain("createHardwarePlugin, createDioPlugin, createPlatformPlugin, createDeepLinkPlugin");
    expect(scaffold.dart).toContain("allowedPermissions: {...HardwarePermissions.all, 'network'}");
    expect(scaffold.manifest.capabilities.optional).toContain("hardware.camera.preview.start");
    expect(scaffold.manifest.capabilities.optional).toContain("dio.request");
    expect(scaffold.manifest.capabilities.optional).toContain("platform.systemUi.set");
    expect(scaffold.manifest.capabilities.optional).toContain("platform.links.events");
    expect(scaffold.manifest.permissions.optional).toContain("hardware.network");
    expect(scaffold.manifest.permissions.optional).toContain("network");
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("dio-only Android scaffolding adds INTERNET without hardware permissions and is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-dio-android-"));
  const manifest = join(root, "app/src/main/AndroidManifest.xml");
  mkdirSync(join(root, "app/src/main"), { recursive: true });
  writeFileSync(manifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n');
  try {
    patchAndroidHardwareManifest(root, false, true);
    const once = readFileSync(manifest, "utf8");
    expect(once).toContain('android.permission.INTERNET');
    expect(once).not.toContain('android.permission.CAMERA');
    patchAndroidHardwareManifest(root, false, true);
    expect(readFileSync(manifest, "utf8")).toBe(once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
