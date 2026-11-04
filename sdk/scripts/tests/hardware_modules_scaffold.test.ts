import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initProject, patchAndroidHardwareManifest, patchIosMinimum } from "../../pocket.ts";

function readProject(project: string): { pubspec: string; dart: string; manifest: any; editor: any } {
  return {
    pubspec: readFileSync(join(project, "flutter/pubspec.yaml"), "utf8"),
    dart: readFileSync(join(project, "flutter/lib/main.dart"), "utf8"),
    manifest: JSON.parse(readFileSync(join(project, "manifest.json"), "utf8")),
    editor: JSON.parse(readFileSync(join(project, "editor.json"), "utf8")),
  };
}

test("source-only init selects feature packages without the aggregate hardware package", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-hardware-modules-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    const project = await initProject(join(root, "camera-bluetooth"), {
      hardwareModules: ["camera", "bluetooth"] as const,
    });
    const scaffold = readProject(project);
    expect(scaffold.pubspec).toContain("pocket_camera:");
    expect(scaffold.pubspec).toContain("pocket_bluetooth:");
    expect(scaffold.pubspec).toContain("pocket_permissions:");
    expect(scaffold.pubspec).not.toContain("pocket_hardware:");
    expect(scaffold.dart).toContain("package:pocket_camera/pocket_camera.dart");
    expect(scaffold.dart).toContain("package:pocket_bluetooth/pocket_bluetooth.dart");
    expect(scaffold.dart).toContain("createCameraPlugin, createBluetoothPlugin, createPermissionsPlugin");
    expect(scaffold.dart).toContain("authorizePlatformTexture");
    expect(scaffold.dart).toContain("revokePlatformTexture");
    expect(scaffold.manifest.capabilities.optional).toContain("hardware.camera.preview.start");
    expect(scaffold.manifest.capabilities.optional).toContain("hardware.bluetooth.scan");
    expect(scaffold.manifest.capabilities.optional).toContain("permissions.status");
    expect(scaffold.manifest.capabilities.optional).not.toContain("hardware.sensors.read");
    expect(scaffold.manifest.capabilities.optional).not.toContain("hardware.location.current");
    expect(scaffold.manifest.permissions.optional).toEqual([
      "hardware.camera", "hardware.photos", "hardware.bluetooth",
    ]);
    expect(scaffold.editor.hardwareModules).toEqual(["camera", "bluetooth"]);
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("sensors-only selection stays free of permission_handler until explicitly requested", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-sensors-scaffold-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    const project = await initProject(join(root, "sensors"), {
      hardwareModules: ["sensors"] as const,
    });
    const scaffold = readProject(project);
    expect(scaffold.pubspec).toContain("pocket_sensors:");
    expect(scaffold.pubspec).not.toContain("pocket_permissions:");
    expect(scaffold.dart).toContain("PocketSensorsPlugin");
    expect(scaffold.dart).not.toContain("PocketPermissionsPlugin");
    expect(scaffold.manifest.capabilities.optional).toContain("hardware.sensors.read");
    expect(scaffold.manifest.capabilities.optional).not.toContain("permissions.status");
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature platform declarations are minimal and idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-hardware-platform-"));
  const android = join(root, "android");
  const ios = join(root, "ios");
  const androidManifest = join(android, "app/src/main/AndroidManifest.xml");
  const plistPath = join(ios, "Runner/Info.plist");
  const podfilePath = join(ios, "Podfile");
  mkdirSync(dirname(androidManifest), { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(androidManifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n');
  writeFileSync(plistPath, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>Test</string></dict></plist>\n');
  writeFileSync(podfilePath, "platform :ios, '13.0'\ntarget 'Runner' do\nend\npost_install do |installer|\n  installer.pods_project.targets.each do |target|\n  end\nend\n");
  try {
    patchAndroidHardwareManifest(android, false, false, ["camera"], ["hardware.camera", "hardware.photos"]);
    const androidOnce = readFileSync(androidManifest, "utf8");
    expect(androidOnce).toContain("android.permission.CAMERA");
    expect(androidOnce).not.toContain("BLUETOOTH_SCAN");
    expect(androidOnce).not.toContain("ACCESS_FINE_LOCATION");
    patchAndroidHardwareManifest(android, false, false, ["camera"], ["hardware.camera", "hardware.photos"]);
    expect(readFileSync(androidManifest, "utf8")).toBe(androidOnce);

    patchIosMinimum(ios, false, ["camera"]);
    const iosOnce = [readFileSync(plistPath, "utf8"), readFileSync(podfilePath, "utf8")];
    expect(iosOnce[0]).toContain("NSCameraUsageDescription");
    expect(iosOnce[0]).toContain("NSPhotoLibraryAddUsageDescription");
    expect(iosOnce[0]).not.toContain("NSBluetoothAlwaysUsageDescription");
    expect(iosOnce[1]).toContain("PERMISSION_CAMERA=1");
    expect(iosOnce[1]).toContain("PERMISSION_PHOTOS_ADD_ONLY=1");
    expect(iosOnce[1]).not.toContain("PERMISSION_BLUETOOTH=1");
    patchIosMinimum(ios, false, ["camera"]);
    expect([readFileSync(plistPath, "utf8"), readFileSync(podfilePath, "utf8")]).toEqual(iosOnce);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("iOS macro fallback creates a complete target loop", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-ios-macro-fallback-"));
  const plistPath = join(root, "Runner/Info.plist");
  const podfilePath = join(root, "Podfile");
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, "<plist><dict></dict></plist>\n");
  writeFileSync(podfilePath, "post_install do |installer|\nend\n");
  try {
    patchIosMinimum(root, false, ["camera"]);
    const podfile = readFileSync(podfilePath, "utf8");
    expect(podfile).toContain("installer.pods_project.targets.each do |target|");
    expect(podfile).toContain("PERMISSION_CAMERA=1");
    expect(podfile.match(/installer\.pods_project\.targets\.each do \|target\|/g)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
