/**
 * PocketJS Flutter SDK CLI.
 *
 * This is an adapter around the pinned compiler and the native bytecode
 * compiler already used by the showcase. It deliberately does not contain a
 * second compiler or a source fallback: an external project is built by
 * `scripts/build_guest.ts`, then packaged as real QuickJS bytecode.
 *
 * Usage:
 *   bun pocket.ts init <directory> [--sdk-root=/path/to/pocket/sdk]
 *   bun pocket.ts build <directory> [--out=/path/to/output]
 *   bun pocket.ts editor <directory> [--port=8790]
 */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildGuest } from "./scripts/build_guest.ts";

// `pocket.ts` is the SDK entrypoint itself.  Keep the default rooted at this
// directory so a consumer can run `bun /path/to/pocket/sdk/pocket.ts init`
// without having to repeat `--sdk-root`.
const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const projectIdPattern = /^[a-z][a-z0-9-]{0,47}$/;
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

type JsonObject = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`pocket: ${message}`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): JsonObject {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must contain a JSON object`);
    return value as JsonObject;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("pocket:")) throw error;
    fail(`cannot read JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function copyTree(source: string, destination: string): void {
  if (!existsSync(source) || !lstatSync(source).isDirectory()) fail(`SDK source directory is missing: ${source}`);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "node_modules") continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) fail(`SDK source contains unsupported symlink: ${from}`);
    cpSync(from, to, { recursive: entry.isDirectory(), force: true, errorOnExist: false });
  }
}

function slugForDirectory(directory: string): string {
  const raw = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? "pocket-app";
  const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return projectIdPattern.test(slug) ? slug : "pocket-app";
}

function takeFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = args.findIndex((arg) => arg.startsWith(prefix));
  if (index < 0) return undefined;
  const value = args.splice(index, 1)[0]!.slice(prefix.length);
  if (!value) fail(`--${name} requires a value`);
  return value;
}

function takeBooleanFlag(args: string[], name: string): boolean {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takePosition(args: string[], label: string): string {
  const value = args.shift();
  if (!value || value.startsWith("-")) fail(`${label} is required`);
  return value;
}

function ensureNoArgs(args: string[]): void {
  if (args.length > 0) fail(`unknown option ${args[0]}`);
}

function sdkUiPackage(sdk: string): string {
  const source = join(sdk, "packages/pocket_ui");
  if (!existsSync(join(source, "package.json"))) {
    fail(`missing @pocket/ui SDK package at ${source}; migrate packages/pocket_ui before init`);
  }
  return source;
}

const hardwareCapabilities = [
  "hardware.permissions",
  "hardware.permissions.request",
  "hardware.camera.preview.start",
  "hardware.camera.preview.stop",
  "hardware.camera.lens.switch",
  "hardware.camera.flash.toggle",
  "hardware.camera.capture",
  "hardware.photos.list",
  "hardware.photos.delete",
  "hardware.bluetooth.scan",
  "hardware.bluetooth.connect",
  "hardware.sensors.read",
  "hardware.biometrics.authenticate",
  "hardware.location.current",
  "hardware.weather.current",
];

const hardwarePermissions = [
  "hardware.camera",
  "hardware.photos",
  "hardware.bluetooth",
  "hardware.sensors",
  "hardware.biometrics",
  "hardware.location",
  "hardware.microphone",
  "hardware.network",
];

/** @internal Exported for scaffold regression tests; not an app SDK API. */
export function patchIosMinimum(iosDirectory: string, hardware = false): void {
  const podfile = join(iosDirectory, "Podfile");
  if (existsSync(podfile)) {
    const text = readFileSync(podfile, "utf8");
    let updated = /^platform :ios,.*$/m.test(text)
      ? text.replace(/^platform :ios,.*$/m, "platform :ios, '15.0'")
      : `platform :ios, '15.0'\n${text}`;
    const deploymentLine = "      target.build_configurations.each { |config| config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'; config.build_settings['ARCHS'] = 'arm64' }\n";
    const deploymentMarker = "target.build_configurations.each { |config|";
    let deploymentSeen = false;
    updated = updated.replace(
      /^[ \t]*target\.build_configurations\.each \{ \|config\| config\.build_settings\['IPHONEOS_DEPLOYMENT_TARGET'\] = '15\.0'; config\.build_settings\['ARCHS'\] = 'arm64' \}[ \t]*$/gm,
      (line) => {
        if (deploymentSeen) return "";
        deploymentSeen = true;
        return line;
      },
    );
    if (/post_install do \|installer\|/.test(updated)) {
      if (!deploymentSeen && !updated.includes(deploymentMarker)) {
        updated = updated.replace(/(\s+flutter_additional_ios_build_settings\(target\)\s*\n)/, `$1${deploymentLine}`);
      }
    } else {
      updated += `\npost_install do |installer|\n  installer.pods_project.targets.each do |target|\n${deploymentLine}  end\nend\n`;
    }
    writeFileSync(podfile, updated);
  }
  const project = join(iosDirectory, "Runner.xcodeproj/project.pbxproj");
  if (existsSync(project)) {
    let projectText = readFileSync(project, "utf8").replace(/IPHONEOS_DEPLOYMENT_TARGET = [0-9.]+;/g, "IPHONEOS_DEPLOYMENT_TARGET = 15.0;");
    // Flutter 3.35's unpack step invokes lipo -verify_arch with a list of
    // architectures; Xcode 27's lipo accepts one arch per invocation. Keep
    // generated consumer projects arm64-only (the supported Apple Silicon
    // simulator/device target) so the SDK build is deterministic.
    if (!/\n\s+ARCHS = arm64;/.test(projectText)) projectText = projectText.replace(/(\n\s+buildSettings = \{\n)/g, "$1\t\t\t\tARCHS = arm64;\n");
    writeFileSync(project, projectText);
  }
  if (hardware) patchHardwareIosUsageDescriptions(iosDirectory);
}

function patchHardwareIosUsageDescriptions(iosDirectory: string): void {
  const plist = join(iosDirectory, "Runner/Info.plist");
  if (!existsSync(plist)) return;
  let text = readFileSync(plist, "utf8");
  const entries: Record<string, string> = {
    NSBluetoothAlwaysUsageDescription: "This app uses Bluetooth only after the guest requests a nearby-device capability.",
    NSBluetoothPeripheralUsageDescription: "This app uses Bluetooth only after the guest requests a nearby-device capability.",
    NSCameraUsageDescription: "This app uses the camera only after the guest requests a camera capability.",
    NSPhotoLibraryAddUsageDescription: "This app saves guest-captured photos only after you allow photo access.",
    NSPhotoLibraryUsageDescription: "This app lists guest-captured photos only after you allow photo access.",
    NSMicrophoneUsageDescription: "This app uses the microphone only after the guest requests that capability.",
    NSLocationWhenInUseUsageDescription: "This app uses location only after the guest requests location or weather data.",
    NSFaceIDUsageDescription: "This app uses Face ID only after the guest requests biometric authentication.",
    NSMotionUsageDescription: "This app reads motion and barometer sensors only after the guest requests them.",
  };
  let additions = "";
  for (const [key, value] of Object.entries(entries)) {
    if (new RegExp(`<key>${key}</key>`).test(text)) continue;
    additions += `\t<key>${key}</key>\n\t<string>${value}</string>\n`;
  }
  if (additions) text = text.replace(/\n<\/dict>\s*<\/plist>\s*$/s, `\n${additions}</dict>\n</plist>\n`);
  writeFileSync(plist, text);
}

/**
 * Add the Android declarations needed by the compiled hardware provider.
 *
 * Android permissions are declarations only; the provider still requests
 * dangerous permissions after a guest capability request.  Keeping this
 * patch in the SDK entrypoint makes `pocket init --hardware` and later
 * `pocket build` behave the same for generated and already-created hosts.
 * The operation is deliberately text based (like the iOS Info.plist patch)
 * so it does not require an Android XML parser in the SDK toolchain and is
 * safe to run repeatedly.
 */
const androidHardwarePermissions: readonly string[] = [
  '<uses-permission android:name="android.permission.INTERNET" />',
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />',
  '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />',
  '<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />',
  '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-permission android:name="android.permission.USE_BIOMETRIC" />',
  '<uses-permission android:name="android.permission.USE_FINGERPRINT" android:maxSdkVersion="27" />',
];

/** @internal Exported for scaffold regression tests; not an app SDK API. */
export function patchAndroidHardwareManifest(androidDirectory: string, hardware = false): void {
  if (!hardware) return;
  const manifest = join(androidDirectory, "app/src/main/AndroidManifest.xml");
  if (!existsSync(manifest)) return;
  const before = readFileSync(manifest, "utf8");
  if (!/<manifest\b[\s\S]*<\/manifest>\s*$/i.test(before)) {
    fail(`AndroidManifest.xml has no patchable manifest root: ${manifest}`);
  }
  let text = before;
  const additions = androidHardwarePermissions.filter((permission) => {
    const name = permission.match(/android:name="([^"]+)"/)?.[1];
    return name !== undefined && !new RegExp(`android:name=["']${name.replaceAll(".", "\\.")}['"]`).test(text);
  });
  if (additions.length === 0) return;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const body = additions.map((permission) => `    ${permission}`).join(newline);
  text = text.replace(/\r?\n?\s*<\/manifest>\s*$/i, `${newline}${body}${newline}</manifest>${newline}`);
  writeFileSync(manifest, text);
}

/** @internal Exported for scaffold regression tests; not an app SDK API. */
export function patchAndroidMinimum(androidDirectory: string): void {
  const kotlinBuild = join(androidDirectory, "app/build.gradle.kts");
  if (existsSync(kotlinBuild)) {
    const before = readFileSync(kotlinBuild, "utf8");
    const updated = before.replace(
      /(^\s*minSdk\s*=\s*)flutter\.minSdkVersion\s*$/m,
      "$1maxOf(flutter.minSdkVersion, 24)",
    );
    if (updated !== before) writeFileSync(kotlinBuild, updated);
    return;
  }
  const groovyBuild = join(androidDirectory, "app/build.gradle");
  if (existsSync(groovyBuild)) {
    const before = readFileSync(groovyBuild, "utf8");
    const updated = before.replace(
      /(^\s*minSdk(?:Version)?\s+)flutter\.minSdkVersion\s*$/m,
      "$1Math.max(flutter.minSdkVersion, 24)",
    );
    if (updated !== before) writeFileSync(groovyBuild, updated);
  }
}

/**
 * Flutter 3.35 still creates a UIKit AppDelegate-only project when asked for
 * an iOS platform. iOS 27's scene-lifecycle guard terminates that template
 * before Flutter can attach its engine. Keep the generated host on Flutter's
 * supported scene path without copying any showcase business code: plugins
 * are registered through FlutterPluginRegistrant and FlutterSceneDelegate
 * owns the scene/window lifecycle.
 *
 * The AppDelegate rewrite is deliberately limited to Flutter's untouched
 * generated delegate. A consumer who has already supplied a custom delegate
 * is never overwritten: an unadapted custom delegate gets an actionable
 * error, while an existing scene manifest is left entirely in the consumer's
 * hands.
 */
const FLUTTER_DEFAULT_APP_DELEGATE = `import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

function normalizeSwift(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

/** @internal Exported for scaffold regression tests; not an app SDK API. */
export function patchIosSceneLifecycle(iosDirectory: string): void {
  const plist = join(iosDirectory, "Runner/Info.plist");
  const plistExists = existsSync(plist);
  const plistBefore = plistExists ? readFileSync(plist, "utf8") : "";
  const hasSceneManifest = /<key>UIApplicationSceneManifest<\/key>/.test(plistBefore);
  const appDelegate = join(iosDirectory, "Runner/AppDelegate.swift");
  if (existsSync(appDelegate)) {
    const text = readFileSync(appDelegate, "utf8");
    const generatedDelegate = normalizeSwift(text) === normalizeSwift(FLUTTER_DEFAULT_APP_DELEGATE);
    if (generatedDelegate) {
      writeFileSync(appDelegate, `import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterPluginRegistrant {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    pluginRegistrant = self
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func register(with registry: FlutterPluginRegistry) {
    GeneratedPluginRegistrant.register(with: registry)
  }
}
`);
    } else if (!hasSceneManifest) {
      fail(`custom iOS AppDelegate is not scene-enabled: ${appDelegate}; add UIApplicationSceneManifest with FlutterSceneDelegate, then rerun pocket build`);
    }
  }

  if (!plistExists || hasSceneManifest) return;
  let text = plistBefore;
  {
    const sceneManifest = `\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<false/>
\t\t<key>UISceneConfigurations</key>
\t\t<dict>
\t\t\t<key>UIWindowSceneSessionRoleApplication</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>UISceneClassName</key>
\t\t\t\t\t<string>UIWindowScene</string>
\t\t\t\t\t<key>UISceneDelegateClassName</key>
\t\t\t\t\t<string>FlutterSceneDelegate</string>
\t\t\t\t\t<key>UISceneConfigurationName</key>
\t\t\t\t\t<string>flutter</string>
\t\t\t\t\t<key>UISceneStoryboardFile</key>
\t\t\t\t\t<string>Main</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</dict>`;
    const closing = /\n<\/dict>\s*<\/plist>\s*$/s;
    if (!closing.test(text)) fail(`iOS Info.plist has no patchable root dictionary: ${plist}`);
    text = text.replace(closing, `\n${sceneManifest}\n</dict>\n</plist>\n`);
  }
  writeFileSync(plist, text);
}

function prepareFlutterDependencies(flutterDirectory: string, required: boolean): boolean {
  if (!existsSync(join(flutterDirectory, "pubspec.yaml"))) return false;
  const flutter = process.env.FLUTTER_BIN ?? "flutter";
  const result = spawnSync(flutter, ["pub", "get"], { cwd: flutterDirectory, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    if (required) fail(`Flutter dependency resolution failed: ${result.error?.message ?? `exit ${result.status ?? 1}`}`);
    console.warn(`pocket init: Flutter dependency resolution was skipped (${result.error?.message ?? `exit ${result.status ?? 1}`})`);
    return false;
  }
  return true;
}

type NativePlatform = "ios-sim" | "ios" | "macos";

function prepareNative(sdk: string, platform: NativePlatform): void {
  const packageRoot = join(sdk, "packages/pocket_flutter");
  const archive = platform === "macos"
    ? join(packageRoot, "macos/Frameworks/libpocket_flutter.a")
    : join(packageRoot, "ios/Frameworks/libpocket_flutter.a");
  const stampPath = join(sdk, ".pocket-build/sdk-native/current.json");
  let stamp: JsonObject | undefined;
  try { stamp = readJson(stampPath); } catch { stamp = undefined; }
  if (stamp?.platform === platform && existsSync(archive)) {
    console.log(`pocket: native ${platform} archive already prepared: ${archive}`);
    return;
  }
  const script = join(sdk, "scripts/build_native.sh");
  if (!existsSync(script)) fail(`native build script is missing: ${script}`);
  console.log(`pocket: preparing native ${platform} archive`);
  const result = spawnSync("bash", [script, platform], { cwd: sdk, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(archive)) fail(`native ${platform} build did not produce ${archive}`);
  writeJson(stampPath, { platform, archive, generatedAt: new Date().toISOString() });
}

function createFlutterHost(project: string, sdk: string, appId: string, hardware: boolean): void {
  const flutterDirectory = join(project, "flutter");
  mkdirSync(flutterDirectory, { recursive: true });
  const flutter = process.env.FLUTTER_BIN ?? "flutter";
  const name = slugForDirectory(project).replace(/-/g, "_");
  const result = spawnSync(flutter, [
    "create",
    "--no-pub",
    "--platforms=ios,android,macos",
    "--project-name",
    name,
    "--org",
    "dev.pocketjs",
    flutterDirectory,
  ], { cwd: project, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    // Keep init useful in a source-only checkout where Flutter is not
    // installed. The generated Dart project is completed by `flutter create`
    // in the documented setup step; SDK build validation still rejects a
    // missing platform project rather than silently claiming success.
    console.warn(`pocket init: Flutter project generation was skipped (${result.error?.message ?? `exit ${result.status ?? 1}`})`);
    mkdirSync(join(flutterDirectory, "lib"), { recursive: true });
    mkdirSync(join(flutterDirectory, "assets"), { recursive: true });
  }

  // macOS exposes /tmp through /private/tmp. Dart resolves path dependencies
  // after realpath normalization, so compute the relative path from the same
  // canonical roots or a generated /tmp project points at /private/Volumes.
  const sdkPackage = sdk;
  const sdkPath = relative(realpathSync(flutterDirectory), realpathSync(sdkPackage)).replaceAll("\\", "/") || ".";
  writeFileSync(join(flutterDirectory, "pubspec.yaml"), `name: ${name}\ndescription: PocketJS Flutter host generated by the local SDK.\npublish_to: none\nversion: 0.1.0+1\n\nenvironment:\n  sdk: ^3.9.2\n  flutter: '>=3.35.0'\n\ndependencies:\n  flutter:\n    sdk: flutter\n  pocket_sdk:\n    path: ${sdkPath}\n\ndev_dependencies:\n  flutter_lints: ^5.0.0\n  flutter_test:\n    sdk: flutter\n\nflutter:\n  uses-material-design: true\n  assets:\n    - assets/app.qjbc\n    - assets/app.bytecode.json\n    - assets/guest-manifest.json\n    - assets/app.pak\n`);
  mkdirSync(join(flutterDirectory, "assets"), { recursive: true });
  const hardwareConfig = hardware
    ? "enableHardware: true,\n    allowedPermissions: HardwarePermissions.all,\n  "
    : "";
  writeFileSync(join(flutterDirectory, "lib/main.dart"), `import 'package:flutter/material.dart';\nimport 'package:pocket_sdk/pocket_sdk.dart';\n\nvoid main() {\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(PocketApp(config: PocketAppConfig(\n    appId: '${appId.replaceAll("'", "\\'")}',\n    ${hardwareConfig})));\n}\n`);
  writeFileSync(join(flutterDirectory, "test/widget_test.dart"), `import 'package:flutter_test/flutter_test.dart';\n\nvoid main() {\n  testWidgets('Pocket SDK scaffold has a test target', (tester) async {\n    expect(tester, isNotNull);\n  });\n}\n`);
  // `flutter create --no-pub` does not materialize ios/Podfile. Resolve the
  // generated local SDK dependency once so the iOS policy can be applied to
  // the real Podfile, while retaining a useful source-only init without
  // Flutter installed.
  const iosDirectory = join(flutterDirectory, "ios");
  const androidDirectory = join(flutterDirectory, "android");
  if (prepareFlutterDependencies(flutterDirectory, false)) patchIosMinimum(iosDirectory, hardware);
  patchAndroidHardwareManifest(androidDirectory, hardware);
  patchAndroidMinimum(androidDirectory);
  patchIosSceneLifecycle(iosDirectory);
}

export async function initProject(directory: string, options: { sdkRoot?: string; appId?: string; name?: string; version?: string; hardware?: boolean } = {}): Promise<string> {
  const project = resolve(directory);
  const sdk = resolve(options.sdkRoot ?? sdkRoot);
  if (existsSync(project) && readdirSync(project).length > 0) fail(`init target must be empty: ${project}`);
  mkdirSync(project, { recursive: true });
  const id = slugForDirectory(project);
  const appId = options.appId ?? `dev.pocketjs.${id}`;
  const name = options.name?.trim() || id;
  const version = options.version ?? "0.1.0";
  const hardware = options.hardware === true;
  if (!projectIdPattern.test(id)) fail(`project id is unsafe: ${id}`);
  if (!appIdPattern.test(appId)) fail(`app id is unsafe: ${appId}`);
  if (!versionPattern.test(version)) fail(`version is unsafe: ${version}`);

  writeJson(join(project, "editor.json"), { id, appId, name, title: name, version, build: 1, tickHz: 60, entry: "app.tsx", framework: "solid", hardware });
  writeJson(join(project, "pocket.json"), {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: appId,
    name,
    title: name,
    version,
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  });
  writeJson(join(project, "manifest.json"), {
    $schema: "https://pocketjs.dev/schema/pocket-guest-manifest.json",
    protocolVersion: 1,
    capabilities: { requires: ["text.glyphs.baked"], optional: hardware ? hardwareCapabilities : [] },
    permissions: { optional: hardware ? hardwarePermissions : [] },
  });
  writeJson(join(project, "package.json"), {
    name: id,
    private: true,
    type: "module",
    dependencies: { "@pocket/ui": "file:vendor/pocket-ui" },
  });
  writeJson(join(project, "tsconfig.json"), { compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "preserve", strict: true, skipLibCheck: true } });
  writeFileSync(join(project, ".gitignore"), "flutter/.dart_tool/\nflutter/build/\nflutter/.packages\nnode_modules/\nbuild/\n.pocket-build/\n.pocket-ui.lock\n.pocket-ui-backup-*\n");
  const starterApp = join(sdk, "templates/starter/app.tsx");
  if (!existsSync(starterApp)) fail(`SDK starter app is missing: ${starterApp}`);
  cpSync(starterApp, join(project, "app.tsx"), { force: true });
  const uiSource = sdkUiPackage(sdk);
  copyTree(uiSource, join(project, "vendor/pocket-ui"));
  createFlutterHost(project, sdk, appId, hardware);
  writeFileSync(join(project, "README.md"), `# ${name}\n\nGenerated by the local PocketJS SDK.\n\n- Edit \`app.tsx\` and files under \`vendor/pocket-ui\` only when intentionally vendoring the UI package.\n- Build real QuickJS bytecode with \`bun ${sdk}/pocket.ts build .\`.\n- Open the project in Pocket Studio with \`bun ${sdk}/pocket.ts editor .\`.\n- The Flutter host is in \`flutter/\`; run \`flutter pub get\` there after the SDK is available.\n${hardware ? "- Hardware mode is enabled for the compiled iOS/Android provider; review Info.plist and AndroidManifest runtime declarations and request permissions only from an explicit guest action.\n" : ""}`);
  return project;
}

function projectConfig(project: string): { appId: string; version: string; build: number; tickHz: number; hardware: boolean } {
  const editor = readJson(join(project, "editor.json"));
  const pocket = readJson(join(project, "pocket.json"));
  const appId = typeof editor.appId === "string" ? editor.appId : pocket.id;
  const version = typeof editor.version === "string" ? editor.version : pocket.version;
  const build = typeof editor.build === "number" ? editor.build : 1;
  const tickHz = typeof editor.tickHz === "number" ? editor.tickHz : 60;
  const hardware = editor.hardware === true;
  if (typeof appId !== "string" || !appIdPattern.test(appId)) fail(`unsafe appId in ${project}`);
  if (typeof version !== "string" || !versionPattern.test(version)) fail(`unsafe version in ${project}`);
  if (!Number.isSafeInteger(build) || build < 0) fail(`unsafe build in ${project}`);
  if (!Number.isInteger(tickHz) || tickHz < 1 || tickHz > 120) fail(`unsafe tickHz in ${project}`);
  return { appId, version, build, tickHz, hardware };
}

export async function buildProject(directory: string, options: { outDir?: string; sdkRoot?: string; platform?: NativePlatform } = {}): Promise<{ project: string; output: string; qjbc: string; pak: string; metadata: string }> {
  const project = resolve(directory);
  const sdk = resolve(options.sdkRoot ?? sdkRoot);
  if (!existsSync(join(project, "app.tsx")) || !existsSync(join(project, "manifest.json"))) fail(`not an initialized PocketJS project: ${project}`);
  const config = projectConfig(project);
  // A host may have been generated before Flutter was installed, so repeat
  // the Android platform patch on every build. This is independent of native
  // archive preparation and is harmless when the Android project has not been
  // materialized yet.
  const androidDirectory = join(project, "flutter/android");
  patchAndroidHardwareManifest(androidDirectory, config.hardware);
  patchAndroidMinimum(androidDirectory);
  if (options.platform) {
    prepareNative(sdk, options.platform);
    if (options.platform === "ios-sim" || options.platform === "ios") {
      const flutterDirectory = join(project, "flutter");
      const iosDirectory = join(flutterDirectory, "ios");
      if (prepareFlutterDependencies(flutterDirectory, true)) patchIosMinimum(iosDirectory, config.hardware);
      patchIosSceneLifecycle(iosDirectory);
    }
  }
  const output = resolve(options.outDir ?? join(project, "build/pocket"));
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "pocket-sdk-build-"));
  try {
    const built = await buildGuest({ projectRoot: project, outDir: staging, tickHz: config.tickHz });
    for (const name of ["app.js", "app.pak", "app.qjbc", "app.bytecode.json"] as const) {
      const source = join(staging, name);
      if (!existsSync(source)) fail(`compiler did not produce ${name}`);
      cpSync(source, join(output, name));
    }
    cpSync(join(project, "manifest.json"), join(output, "guest-manifest.json"));
    const metadata = readJson(join(output, "app.bytecode.json"));
    if (metadata.entryFormat !== "quickjs-bytecode" || typeof metadata.runtimeAbi !== "string" || !metadata.runtimeAbi) fail("bytecode metadata is not a real QuickJS artifact");
    const flutterAssets = join(project, "flutter/assets");
    mkdirSync(flutterAssets, { recursive: true });
    for (const name of ["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"]) cpSync(join(output, name), join(flutterAssets, name));
    const buildInfo = { appId: config.appId, version: config.version, build: config.build, tickHz: config.tickHz, entryFormat: "quickjs-bytecode", runtimeAbi: metadata.runtimeAbi, output };
    writeJson(join(output, "build.json"), buildInfo);
    console.log(JSON.stringify({ ok: true, project, output, qjbc: join(output, "app.qjbc"), pak: join(output, "app.pak"), metadata: join(output, "app.bytecode.json"), runtimeAbi: metadata.runtimeAbi }, null, 2));
    return { project, output, qjbc: join(output, "app.qjbc"), pak: join(output, "app.pak"), metadata: join(output, "app.bytecode.json") };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function runEditor(directory: string, options: { port?: number; workspace?: string }): Promise<void> {
  const project = resolve(directory);
  if (!existsSync(join(project, "pocket.json"))) fail(`not an initialized PocketJS project: ${project}`);
  const { startEditor } = await import("./editor/server.ts");
  const server = await startEditor({ projectRoot: project, workspace: options.workspace ?? join(project, ".pocket-editor"), port: options.port });
  console.log(`Pocket Studio listening at http://${server.hostname}:${server.port}`);
  console.log(`project: ${project}`);
  await new Promise<void>((resolveExit) => {
    const stop = () => { server.stop(true); resolveExit(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function usage(): never {
  console.error("usage: bun pocket.ts init <directory> [--sdk-root=DIR] [--app-id=ID] [--name=NAME] [--version=VERSION] [--hardware]\n       bun pocket.ts build <directory> [--sdk-root=DIR] [--out=DIR] [--platform=ios-sim|ios|macos]\n       bun pocket.ts editor <directory> [--port=N] [--workspace=DIR]");
  process.exit(1);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const command = args.shift();
    if (!command) usage();
    if (command === "init") {
      const directory = takePosition(args, "directory");
      const sdk = takeFlag(args, "sdk-root");
      const appId = takeFlag(args, "app-id");
      const name = takeFlag(args, "name");
      const version = takeFlag(args, "version");
      const hardware = takeBooleanFlag(args, "hardware");
      ensureNoArgs(args);
      console.log(`pocket init: ${await initProject(directory, { sdkRoot: sdk, appId, name, version, hardware })}`);
    } else if (command === "build") {
      const directory = takePosition(args, "project directory");
      const out = takeFlag(args, "out");
      const sdk = takeFlag(args, "sdk-root");
      const platformValue = takeFlag(args, "platform");
      const platform = platformValue as NativePlatform | undefined;
      if (platform !== undefined && platform !== "ios-sim" && platform !== "ios" && platform !== "macos") fail("--platform must be ios-sim, ios, or macos");
      ensureNoArgs(args);
      await buildProject(directory, { outDir: out, sdkRoot: sdk, platform });
    } else if (command === "editor") {
      const directory = takePosition(args, "project directory");
      const portValue = takeFlag(args, "port");
      const workspace = takeFlag(args, "workspace");
      ensureNoArgs(args);
      const port = portValue === undefined ? undefined : Number(portValue);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) fail("--port must be an integer from 0 through 65535");
      await runEditor(directory, { port, workspace });
    } else usage();
  } catch (error) {
    console.error(`pocket: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
