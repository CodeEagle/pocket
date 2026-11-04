import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../../pocket.ts";

test("permissions-only init adds only the independent permission provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-permissions-scaffold-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    const project = await initProject(join(root, "permissions"), {
      permissions: ["hardware.camera", "hardware.location"] as const,
    });
    const pubspec = readFileSync(join(project, "flutter/pubspec.yaml"), "utf8");
    const dart = readFileSync(join(project, "flutter/lib/main.dart"), "utf8");
    const manifest = JSON.parse(readFileSync(join(project, "manifest.json"), "utf8"));
    const editor = JSON.parse(readFileSync(join(project, "editor.json"), "utf8"));
    expect(pubspec).toContain("pocket_permissions:");
    expect(pubspec).not.toContain("pocket_hardware:");
    expect(pubspec).not.toContain("pocket_camera:");
    expect(pubspec).not.toContain("pocket_location:");
    expect(dart).toContain("PocketPermissionsPlugin");
    expect(dart).toContain("allowedPermissions: const {'hardware.camera', 'hardware.location'}");
    expect(dart).not.toContain("PocketCameraPlugin");
    expect(manifest.capabilities.optional).toEqual([
      "permissions.status", "permissions.request", "permissions.openSettings",
    ]);
    expect(manifest.permissions.optional).toEqual(["hardware.camera", "hardware.location"]);
    expect(editor.permissions).toEqual(["hardware.camera", "hardware.location"]);
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission policy input rejects non-runtime aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-permissions-invalid-"));
  try {
    await expect(initProject(join(root, "invalid"), {
      permissions: ["hardware.biometrics"] as const,
    })).rejects.toThrow("runtime policy keys");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
