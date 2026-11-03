import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initProject } from "../../pocket.ts";
import { patchDeepLinkPlatforms, resolvePlatformExperience } from "../platform_scaffold.ts";

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Keep me</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>consumer</string><key>CFBundleURLSchemes</key><array><string>existing</string></array></dict></array>
<key>UIApplicationSceneManifest</key><dict><key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict><key>UISceneDelegateClassName</key><string>FlutterSceneDelegate</string></dict></array></dict></dict>
</dict></plist>`;
const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
<!-- keep consumer comment -->
<application android:label="Keep me"><activity android:name=".MainActivity" android:exported="true">
<intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
</activity></application></manifest>`;

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pocket-platform-scaffold-"));
  for (const [path, content] of [
    ["ios/Runner/Info.plist", plist],
    ["ios/Runner/AppDelegate.swift", "import Flutter\nimport UIKit\n@main class AppDelegate: FlutterAppDelegate {}\n"],
    ["android/app/src/main/AndroidManifest.xml", manifest],
  ]) {
    const file = join(root, path!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content!);
  }
  return root;
}

test("Deep Link configuration is a no-op unless explicitly enabled", () => {
  const root = fixture();
  try {
    const before = readFileSync(join(root, "ios/Runner/Info.plist"), "utf8");
    patchDeepLinkPlatforms(root);
    expect(readFileSync(join(root, "ios/Runner/Info.plist"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "utf8")).toBe(manifest);
    expect(resolvePlatformExperience({})).toEqual({ platformExperience: false });
    expect(resolvePlatformExperience({ platformExperience: true })).toEqual({ platformExperience: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("opt-in preserves consumer entries and is byte-for-byte idempotent", () => {
  const root = fixture();
  try {
    patchDeepLinkPlatforms(root, "pocketapp");
    const paths = ["ios/Runner/Info.plist", "ios/Runner/AppDelegate.swift", "android/app/src/main/AndroidManifest.xml"];
    const once = paths.map((path) => readFileSync(join(root, path), "utf8"));
    expect(once[0]).toContain("PocketDeepLinksEnabled");
    expect(once[0]).toContain("<string>existing</string>");
    expect(once[0]).toContain("Keep me");
    expect(once[0]).toContain("FlutterDeepLinkingEnabled");
    expect(once[1]?.match(/class PocketDeepLinkSceneDelegate/g)).toHaveLength(1);
    expect(once[1]).toContain("connectionOptions.urlContexts.first?.url");
    expect(once[1]).toContain("openURLContexts");
    expect(once[2]).toContain('android:scheme="pocketapp"');
    expect(once[2]).toContain("keep consumer comment");
    expect(once[2]).toContain("DEEP_LINK_SCHEMES");
    patchDeepLinkPlatforms(root, "pocketapp");
    expect(paths.map((path) => readFileSync(join(root, path), "utf8"))).toEqual(once);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom scene delegate is preserved and rejected before any file is changed", () => {
  const root = fixture();
  try {
    const custom = plist.replace("<string>FlutterSceneDelegate</string>", "<string>$(PRODUCT_MODULE_NAME).MySceneDelegate</string>");
    writeFileSync(join(root, "ios/Runner/Info.plist"), custom);
    expect(() => patchDeepLinkPlatforms(root, "pocketapp")).toThrow("custom SceneDelegate");
    expect(readFileSync(join(root, "ios/Runner/Info.plist"), "utf8")).toBe(custom);
    expect(readFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "utf8")).toBe(manifest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid Android configuration cannot leave the iOS half patched", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "<manifest/>");
    expect(() => patchDeepLinkPlatforms(root, "pocketapp")).toThrow("no application");
    expect(readFileSync(join(root, "ios/Runner/Info.plist"), "utf8")).toBe(plist);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("URL schemes cannot inject XML, Dart or shell syntax", () => {
  for (const deepLinkScheme of ["http", "https", "file", "data", "intent", "content", "javascript", "UPPER", "", "x'\nimport bad", "a<xml", "a;id", "a".repeat(33)]) {
    expect(() => resolvePlatformExperience({ deepLinkScheme })).toThrow();
  }
});

test("source-only scaffold keeps default and opt-in dependencies/capabilities separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-platform-init-"));
  const previous = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = "/usr/bin/false";
  try {
    for (const [name, options] of [
      ["standard", {}],
      ["experience", { platformExperience: true }],
      ["linked", { deepLinkScheme: "pocketapp" }],
    ] as const) {
      const project = join(root, name);
      await initProject(project, options);
      const pubspec = readFileSync(join(project, "flutter/pubspec.yaml"), "utf8");
      const dart = readFileSync(join(project, "flutter/lib/main.dart"), "utf8");
      const guest = JSON.parse(readFileSync(join(project, "manifest.json"), "utf8"));
      expect(guest.capabilities.requires).toEqual(["text.glyphs.baked"]);
      if (name === "standard") {
        expect(pubspec).not.toContain("pocket_platform");
        expect(dart).not.toContain("PocketPlatformPlugin");
        expect(guest.capabilities.optional).toEqual([]);
      } else {
        expect(pubspec).toContain("pocket_platform");
        expect(dart).toContain("PocketPlatformPlugin");
        expect(guest.capabilities.optional).toContain("platform.systemUi.set");
        expect(guest.capabilities.optional).toContain("platform.haptics.perform");
        if (name === "linked") {
          expect(dart).toContain("PocketDeepLinkPlugin(");
          expect(dart).toContain("createPlatformPlugin, createDeepLinkPlugin");
          expect(dart).toContain("deepLinkScheme: 'pocketapp'");
          expect(guest.capabilities.optional).toContain("platform.links.events");
        } else {
          expect(dart).not.toContain("PocketDeepLinkPlugin(");
          expect(guest.capabilities.optional).not.toContain("platform.links.events");
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
