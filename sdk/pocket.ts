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
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildGuest, resolveReleaseIdentity } from "./scripts/build_guest.ts";
import { patchDeepLinkPlatforms, resolvePlatformExperience, type PlatformExperienceOptions } from "./scripts/platform_scaffold.ts";

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
  const flag = `--${name}`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith(prefix)) {
      args.splice(i, 1);
      const value = arg.slice(prefix.length);
      if (!value) fail(`--${name} requires a value`);
      return value;
    }
    if (arg === flag) {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("-")) {
        fail(`--${name} requires a value`);
      }
      args.splice(i, 1);
      const value = args.splice(i, 1)[0]!;
      return value;
    }
  }
  return undefined;
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
  "hardware.sensors.watch",
  "hardware.bluetooth.read",
  "hardware.bluetooth.write",
  "hardware.bluetooth.notifications",
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

type HardwareModule = "camera" | "bluetooth" | "sensors" | "location" | "biometrics" | "weather";

type HardwareModuleDefinition = {
  packageName: string;
  importPath: string;
  factoryName: string;
  className: string;
  capabilities: readonly string[];
  permissions: readonly string[];
  runtimePermissions: readonly string[];
  androidPermissions: readonly string[];
  iosUsageKeys: readonly string[];
};

const runtimePermissionKeys = new Set([
  "hardware.camera",
  "hardware.photos",
  "hardware.bluetooth",
  "hardware.sensors",
  "hardware.location",
  "hardware.microphone",
]);

const hardwareModuleDefinitions: Record<HardwareModule, HardwareModuleDefinition> = {
  camera: {
    packageName: "pocket_camera",
    importPath: "package:pocket_camera/pocket_camera.dart",
    factoryName: "createCameraPlugin",
    className: "PocketCameraPlugin",
    capabilities: [
      "hardware.camera.preview.start", "hardware.camera.preview.stop",
      "hardware.camera.lens.switch", "hardware.camera.flash.toggle",
      "hardware.camera.capture", "hardware.photos.list", "hardware.photos.delete",
    ],
    permissions: ["hardware.camera", "hardware.photos"],
    runtimePermissions: ["hardware.camera", "hardware.photos"],
    androidPermissions: ['<uses-permission android:name="android.permission.CAMERA" />'],
    iosUsageKeys: ["NSCameraUsageDescription", "NSPhotoLibraryAddUsageDescription"],
  },
  bluetooth: {
    packageName: "pocket_bluetooth",
    importPath: "package:pocket_bluetooth/pocket_bluetooth.dart",
    factoryName: "createBluetoothPlugin",
    className: "PocketBluetoothPlugin",
    capabilities: [
      "hardware.bluetooth.scan", "hardware.bluetooth.connect",
      "hardware.bluetooth.read", "hardware.bluetooth.write", "hardware.bluetooth.notifications",
    ],
    permissions: ["hardware.bluetooth"],
    runtimePermissions: ["hardware.bluetooth"],
    androidPermissions: [
      '<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />',
      '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />',
      '<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />',
      '<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />',
      '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
      '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
    ],
    iosUsageKeys: ["NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"],
  },
  sensors: {
    packageName: "pocket_sensors",
    importPath: "package:pocket_sensors/pocket_sensors.dart",
    factoryName: "createSensorsPlugin",
    className: "PocketSensorsPlugin",
    capabilities: ["hardware.sensors.read", "hardware.sensors.watch"],
    permissions: ["hardware.sensors"],
    runtimePermissions: ["hardware.sensors"],
    androidPermissions: [],
    iosUsageKeys: ["NSMotionUsageDescription"],
  },
  location: {
    packageName: "pocket_location",
    importPath: "package:pocket_location/pocket_location.dart",
    factoryName: "createLocationPlugin",
    className: "PocketLocationPlugin",
    capabilities: ["hardware.location.current"],
    permissions: ["hardware.location"],
    runtimePermissions: ["hardware.location"],
    androidPermissions: [
      '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
      '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
    ],
    iosUsageKeys: ["NSLocationWhenInUseUsageDescription"],
  },
  biometrics: {
    packageName: "pocket_biometrics",
    importPath: "package:pocket_biometrics/pocket_biometrics.dart",
    factoryName: "createBiometricsPlugin",
    className: "PocketBiometricsPlugin",
    capabilities: ["hardware.biometrics.authenticate"],
    permissions: ["hardware.biometrics"],
    runtimePermissions: [],
    androidPermissions: [
      '<uses-permission android:name="android.permission.USE_BIOMETRIC" />',
    ],
    iosUsageKeys: ["NSFaceIDUsageDescription"],
  },
  weather: {
    packageName: "pocket_weather",
    importPath: "package:pocket_weather/pocket_weather.dart",
    factoryName: "createWeatherPlugin",
    className: "PocketWeatherPlugin",
    capabilities: ["hardware.weather.current"],
    permissions: ["hardware.network"],
    runtimePermissions: [],
    androidPermissions: ['<uses-permission android:name="android.permission.INTERNET" />'],
    iosUsageKeys: [],
  },
};

const hardwareModuleNames = Object.keys(hardwareModuleDefinitions) as HardwareModule[];

type HardwareSelection = {
  hardware: boolean;
  modules: HardwareModule[];
  capabilities: string[];
  permissions: string[];
  runtimePermissions: string[];
  explicitPermissions: string[];
  permissionsExplicit: boolean;
};

function parseHardwareModules(raw: unknown, label: string): HardwareModule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string" || !hardwareModuleNames.includes(item as HardwareModule))) {
    fail(`${label} must be an array of supported hardware modules`);
  }
  return [...new Set(raw as HardwareModule[])];
}

function parsePermissionKeys(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return validatePermissionKeys(values, "--permissions");
}

function validatePermissionKeys(values: Iterable<unknown>, label: string): string[] {
  const normalized = [...values];
  if (normalized.some((value) => typeof value !== "string" || !runtimePermissionKeys.has(value))) {
    fail(`${label} accepts only runtime policy keys: ${[...runtimePermissionKeys].sort().join(", ")}`);
  }
  return [...new Set(normalized as string[])];
}

function hardwareSelection(hardware: boolean, modules: Iterable<HardwareModule>, explicitPermissions: Iterable<string>): HardwareSelection {
  const selectedModules = [...new Set(modules)];
  const explicit = [...new Set(explicitPermissions)];
  if (hardware) {
    return {
      hardware: true,
      modules: [],
      capabilities: [...hardwareCapabilities],
      permissions: [...hardwarePermissions],
      runtimePermissions: [...runtimePermissionKeys],
      explicitPermissions: explicit,
      permissionsExplicit: explicit.length > 0,
    };
  }
  const capabilities = new Set<string>();
  const permissions = new Set<string>(explicit);
  const runtimePermissions = new Set<string>(explicit);
  for (const module of selectedModules) {
    const definition = hardwareModuleDefinitions[module];
    for (const capability of definition.capabilities) capabilities.add(capability);
    for (const permission of definition.permissions) permissions.add(permission);
    for (const permission of definition.runtimePermissions) runtimePermissions.add(permission);
  }
  return {
    hardware: false,
    modules: selectedModules,
    capabilities: [...capabilities],
    permissions: [...permissions],
    runtimePermissions: [...runtimePermissions].filter((permission) => runtimePermissionKeys.has(permission)),
    explicitPermissions: explicit,
    permissionsExplicit: explicit.length > 0,
  };
}

function shouldRegisterPermissionPlugin(selection: HardwareSelection): boolean {
  if (selection.hardware) return selection.permissionsExplicit;
  const promptingRuntimePermissions = selection.runtimePermissions.filter(
    (permission) => permission !== "hardware.sensors",
  );
  // Android exposes no dangerous sensor runtime permission. Keep a
  // sensors-only (or sensors+weather) scaffold free of permission_handler;
  // an explicit --permissions hardware.sensors opt-in still installs the
  // provider for iOS motion permission requests.
  if (promptingRuntimePermissions.length === 0 && selection.explicitPermissions.length === 0) return false;
  return true;
}

/** @internal Exported for scaffold regression tests; not an app SDK API. */
export function patchIosMinimum(
  iosDirectory: string,
  hardware = false,
  modules: readonly HardwareModule[] = [],
  permissionKeys: readonly string[] = [],
): void {
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
  if (hardware) patchHardwareIosUsageDescriptions(iosDirectory, hardwareModuleNames, ["hardware.microphone"]);
  else if (modules.length > 0 || permissionKeys.length > 0) patchHardwareIosUsageDescriptions(iosDirectory, modules, permissionKeys);
}

function patchHardwareIosUsageDescriptions(
  iosDirectory: string,
  modules: readonly HardwareModule[],
  permissionKeys: readonly string[] = [],
): void {
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
  const selectedKeys = new Set(modules.flatMap((module) => hardwareModuleDefinitions[module].iosUsageKeys));
  for (const permission of permissionKeys) {
    if (permission === "hardware.camera") selectedKeys.add("NSCameraUsageDescription");
    if (permission === "hardware.photos") {
      selectedKeys.add("NSPhotoLibraryAddUsageDescription");
    }
    if (permission === "hardware.bluetooth") {
      selectedKeys.add("NSBluetoothAlwaysUsageDescription");
      selectedKeys.add("NSBluetoothPeripheralUsageDescription");
    }
    if (permission === "hardware.location") selectedKeys.add("NSLocationWhenInUseUsageDescription");
    if (permission === "hardware.microphone") selectedKeys.add("NSMicrophoneUsageDescription");
    if (permission === "hardware.sensors") selectedKeys.add("NSMotionUsageDescription");
  }
  let additions = "";
  for (const [key, value] of Object.entries(entries)) {
    if (!selectedKeys.has(key)) continue;
    if (new RegExp(`<key>${key}</key>`).test(text)) continue;
    additions += `\t<key>${key}</key>\n\t<string>${value}</string>\n`;
  }
  if (additions) text = text.replace(/\s*<\/dict>\s*<\/plist>\s*$/s, `\n${additions}</dict>\n</plist>\n`);
  writeFileSync(plist, text);
}

/**
 * Add the Android declarations needed by the compiled hardware provider.
 *
 * Android permissions are declarations only; the provider still requests
 * dangerous permissions after a guest capability request.  Keeping this
 * patch in the SDK entrypoint makes `pocket init --hardware`/`--dio` and later
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
];

/** @internal Exported for scaffold regression tests; not an app SDK API. */
export function patchAndroidHardwareManifest(
  androidDirectory: string,
  hardware = false,
  dio = false,
  modules: readonly HardwareModule[] = [],
  permissionKeys: readonly string[] = [],
): void {
  if (!hardware && !dio && modules.length === 0 && permissionKeys.length === 0) return;
  const manifest = join(androidDirectory, "app/src/main/AndroidManifest.xml");
  if (!existsSync(manifest)) return;
  const before = readFileSync(manifest, "utf8");
  if (!/<manifest\b[\s\S]*<\/manifest>\s*$/i.test(before)) {
    fail(`AndroidManifest.xml has no patchable manifest root: ${manifest}`);
  }
  let text = before;
  const permissions = hardware
    ? androidHardwarePermissions
    : [
        ...(dio ? androidHardwarePermissions.slice(0, 1) : []),
        ...modules.flatMap((module) => hardwareModuleDefinitions[module].androidPermissions),
        ...permissionKeys.flatMap((permission) => {
          if (permission === "hardware.camera") return ['<uses-permission android:name="android.permission.CAMERA" />'];
          if (permission === "hardware.bluetooth") return hardwareModuleDefinitions.bluetooth.androidPermissions;
          if (permission === "hardware.location") return hardwareModuleDefinitions.location.androidPermissions;
          if (permission === "hardware.microphone") return ['<uses-permission android:name="android.permission.RECORD_AUDIO" />'];
          return [];
        }),
      ];
  const additions = permissions.filter((permission) => {
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

type NativePlatform = "ios-sim" | "ios" | "macos" | "android";

function nativeInputFingerprint(sdk: string): string {
  const inputs = [
    join(sdk, "native/src"),
    join(sdk, "native/Cargo.toml"),
    join(sdk, "native/build.rs"),
    join(sdk, "native/Cargo.lock"),
    join(sdk, "native/patches"),
    join(sdk, "scripts/build_native.sh"),
    join(sdk, "scripts/prepare_upstream.py"),
    join(sdk, ".cache/pocketjs/.pocketjs-revision"),
    join(sdk, ".cache/pocketjs/Cargo.lock"),
    join(sdk, ".cache/pocketjs/bun.lock"),
    join(sdk, ".cache/pocketjs/package.json"),
  ];
  const files: string[] = [];
  const collect = (path: string): void => {
    if (!existsSync(path)) return;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return;
    if (!info.isDirectory()) {
      files.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      collect(join(path, entry.name));
    }
  };
  for (const input of inputs) collect(input);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(sdk, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function prepareNative(sdk: string, platform: NativePlatform): void {
  const packageRoot = join(sdk, "packages/pocket_flutter");
  const archive = platform === "macos"
    ? join(packageRoot, "macos/Frameworks/libpocket_flutter.a")
    : platform === "android"
      ? join(packageRoot, "android/src/main/jniLibs/arm64-v8a/libpocket_flutter.so")
      : join(packageRoot, "ios/pocket_flutter/Frameworks/PocketFlutter.xcframework");
  // Keep a stamp per target. A shared current.json lets an iOS simulator
  // build race a device/Android build and incorrectly satisfy the other
  // consumer's cache check.
  const stampPath = join(sdk, `.pocket-build/sdk-native/${platform}.json`);
  let stamp: JsonObject | undefined;
  try { stamp = readJson(stampPath); } catch { stamp = undefined; }
  const fingerprint = nativeInputFingerprint(sdk);
  if (stamp?.platform === platform && stamp?.fingerprint === fingerprint && existsSync(archive)) {
    console.log(`pocket: native ${platform} archive already prepared: ${archive}`);
    return;
  }
  const script = join(sdk, "scripts/build_native.sh");
  if (!existsSync(script)) fail(`native build script is missing: ${script}`);
  console.log(`pocket: preparing native ${platform} archive`);
  const result = spawnSync("bash", [script, platform], { cwd: sdk, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(archive)) fail(`native ${platform} build did not produce ${archive}`);
  writeJson(stampPath, { platform, archive, fingerprint, generatedAt: new Date().toISOString() });
}

function scaffoldTest(flutterDirectory: string, appId: string): void {
  mkdirSync(join(flutterDirectory, "test"), { recursive: true });
  writeFileSync(
    join(flutterDirectory, "test/widget_test.dart"),
    `import 'package:flutter_test/flutter_test.dart';\nimport 'package:pocket_sdk/pocket_sdk.dart';\n\nvoid main() {\n  testWidgets('PocketAppConfig constructs and validates configuration', (tester) async {\n    const config = PocketAppConfig(\n      appId: '${appId.replaceAll("'", "\\'")}',\n    );\n    expect(config.appId, equals('${appId.replaceAll("'", "\\'")}'));\n    expect(config.bytecodeAsset, equals('assets/app.qjbc'));\n    expect(config.manifestAsset, equals('assets/guest-manifest.json'));\n    expect(config.pakAsset, equals('assets/app.pak'));\n  });\n}\n`,
  );
}

function createFlutterHost(
  project: string,
  sdk: string,
  appId: string,
  selection: HardwareSelection,
  dio: boolean,
  platform: ReturnType<typeof resolvePlatformExperience>,
): void {
  const hardware = selection.hardware;
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
  const packagePath = (packageName: string): string => {
    const packageDirectory = join(sdk, "packages", packageName);
    if (!existsSync(packageDirectory) || !lstatSync(packageDirectory).isDirectory()) {
      fail(`hardware support requested but the SDK package is missing: ${packageDirectory}`);
    }
    return relative(realpathSync(flutterDirectory), realpathSync(packageDirectory)).replaceAll("\\", "/");
  };
  const hardwareDependency = hardware
    ? `\n  pocket_hardware:\n    path: ${packagePath("pocket_hardware")}`
    : "";
  const moduleDependencies = selection.modules
    .map((module) => `\n  ${hardwareModuleDefinitions[module].packageName}:\n    path: ${packagePath(hardwareModuleDefinitions[module].packageName)}`)
    .join("");
  // Permission access is a separate optional provider.  Runtime-capable
  // modules get the smallest matching allowlist automatically; weather and
  // biometrics have no permission_handler runtime policy and add nothing.
  const permissionPlugin = shouldRegisterPermissionPlugin(selection);
  const permissionsDependency = permissionPlugin
    ? `\n  pocket_permissions:\n    path: ${packagePath("pocket_permissions")}`
    : "";
  const dioPackage = join(sdk, "packages/pocket_dio");
  if (dio && (!existsSync(dioPackage) || !lstatSync(dioPackage).isDirectory())) {
    fail(`Dio support requested but the SDK package is missing: ${dioPackage}`);
  }
  const dioPath = dio ? relative(realpathSync(flutterDirectory), realpathSync(dioPackage)).replaceAll("\\", "/") : "";
  const dioDependency = dio ? `\n  pocket_dio:\n    path: ${dioPath}` : "";
  const platformDependency = platform.platformExperience
    ? `\n  pocket_platform:\n    path: ${relative(realpathSync(flutterDirectory), realpathSync(join(sdk, "packages/pocket_platform"))).replaceAll("\\", "/")}`
    : "";
  // Compose feature-specific path dependencies in the generated host. This
  // keeps source-only init deterministic even when Flutter is unavailable.
  writeFileSync(join(flutterDirectory, "pubspec.yaml"), `name: ${name}\ndescription: PocketJS Flutter host generated by the local SDK.\npublish_to: none\nversion: 0.1.0+1\n\nenvironment:\n  sdk: ^3.9.2\n  flutter: '>=3.35.0'\n\ndependencies:\n  flutter:\n    sdk: flutter\n  pocket_sdk:\n    path: ${sdkPath}${hardwareDependency}${moduleDependencies}${dioDependency}${permissionsDependency}${platformDependency}\n\ndev_dependencies:\n  flutter_lints: ^5.0.0\n  flutter_test:\n    sdk: flutter\n\nflutter:\n  config:\n    enable-swift-package-manager: true\n  uses-material-design: true\n  assets:\n    - assets/app.qjbc\n    - assets/app.bytecode.json\n    - assets/guest-manifest.json\n    - assets/app.pak\n`);
  mkdirSync(join(flutterDirectory, "assets"), { recursive: true });
  const moduleImports = selection.modules
    .map((module) => `import '${hardwareModuleDefinitions[module].importPath}';\n`)
    .join("");
  const hardwareImport = (hardware ? "import 'package:pocket_hardware/pocket_hardware.dart';\n" : "") +
    moduleImports +
    (dio ? "import 'package:pocket_dio/pocket_dio.dart';\n" : "") +
    (permissionPlugin ? "import 'package:pocket_permissions/pocket_permissions.dart';\n" : "") +
    (platform.platformExperience ? "import 'package:pocket_platform/pocket_platform.dart';\n" : "");
  const factories = [
    ...(hardware ? ["createHardwarePlugin"] : []),
    ...selection.modules.map((module) => hardwareModuleDefinitions[module].factoryName),
    ...(dio ? ["createDioPlugin"] : []),
    ...(permissionPlugin ? ["createPermissionsPlugin"] : []),
    ...(platform.platformExperience ? ["createPlatformPlugin"] : []),
    ...(platform.deepLinkScheme ? ["createDeepLinkPlugin"] : []),
  ];
  const featurePermissionValues = [...new Set([
    ...selection.permissions,
    ...(dio ? ["network"] : []),
  ])].sort();
  const featurePermissionLiteral = `const {${featurePermissionValues.map((permission) => `'${permission}'`).join(", ")}}`;
  const allowedPermissions = hardware && dio
    ? "allowedPermissions: {...HardwarePermissions.all, 'network'},\n    "
    : hardware
      ? "allowedPermissions: HardwarePermissions.all,\n    "
      : (featurePermissionValues.length > 0 ? `allowedPermissions: ${featurePermissionLiteral},\n    ` : "");
  const hardwareConfig = (factories.length ? `pluginFactories: [${factories.join(", ")}],\n    ` : "") + allowedPermissions;
  const hardwareFactory = hardware
    ? "\nPocketPlugin createHardwarePlugin(PocketViewController controller) => HardwarePlugin(\n  onTextureRegistered: controller.authorizePlatformTexture,\n  onTextureReleased: controller.revokePlatformTexture,\n);\n"
    : "";
  const moduleFactories = selection.modules.map((module) => {
    const definition = hardwareModuleDefinitions[module];
    if (module === "camera") {
      return `\nPocketPlugin ${definition.factoryName}(PocketViewController controller) => ${definition.className}(\n  onTextureRegistered: controller.authorizePlatformTexture,\n  onTextureReleased: controller.revokePlatformTexture,\n);\n`;
    }
    return `\nPocketPlugin ${definition.factoryName}(PocketViewController controller) => ${definition.className}();\n`;
  }).join("");
  const permissionFactory = permissionPlugin
    ? `\nPocketPlugin createPermissionsPlugin(PocketViewController controller) => PocketPermissionsPlugin(allowedPermissions: const {${(hardware ? selection.explicitPermissions : selection.runtimePermissions).sort().map((permission) => `'${permission}'`).join(", ")}});\n`
    : "";
  const dioFactory = dio
    ? "\n// allowedOrigins is intentionally empty; configure the consumer's explicit HTTPS origins before using dio.request.\nPocketPlugin createDioPlugin(PocketViewController controller) => PocketDioPlugin(allowedOrigins: const {});\n"
    : "";
  const platformFactory = (platform.platformExperience
    ? "\nPocketPlugin createPlatformPlugin(PocketViewController controller) => PocketPlatformPlugin();\n"
    : "") + (platform.deepLinkScheme
    ? `\nPocketPlugin createDeepLinkPlugin(PocketViewController controller) => PocketDeepLinkPlugin(deepLinkScheme: '${platform.deepLinkScheme}');\n`
    : "");
  writeFileSync(join(flutterDirectory, "lib/main.dart"), `${hardwareImport}import 'package:flutter/material.dart';\nimport 'package:pocket_sdk/pocket_sdk.dart';\n\nvoid main() {\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(PocketApp(config: PocketAppConfig(\n    appId: '${appId.replaceAll("'", "\\'")}',\n    ${hardwareConfig})));\n}\n${hardwareFactory}${moduleFactories}${dioFactory}${permissionFactory}${platformFactory}`);
  scaffoldTest(flutterDirectory, appId);
  const iosDirectory = join(flutterDirectory, "ios");
  const androidDirectory = join(flutterDirectory, "android");
  patchIosMinimum(iosDirectory, hardware, selection.modules, selection.runtimePermissions);
  patchAndroidHardwareManifest(androidDirectory, hardware, dio, selection.modules, selection.runtimePermissions);
  patchAndroidMinimum(androidDirectory);
  patchIosSceneLifecycle(iosDirectory);
  patchDeepLinkPlatforms(flutterDirectory, platform.deepLinkScheme);
}

export async function initProject(directory: string, options: {
  sdkRoot?: string;
  appId?: string;
  name?: string;
  version?: string;
  hardware?: boolean;
  dio?: boolean;
  hardwareModules?: Iterable<HardwareModule>;
  permissions?: Iterable<string>;
} & PlatformExperienceOptions = {}): Promise<string> {
  const project = resolve(directory);
  const sdk = resolve(options.sdkRoot ?? sdkRoot);
  if (existsSync(project) && readdirSync(project).length > 0) fail(`init target must be empty: ${project}`);
  mkdirSync(project, { recursive: true });
  const id = slugForDirectory(project);
  const appId = options.appId ?? `dev.pocketjs.${id}`;
  const name = options.name?.trim() || id;
  const version = options.version ?? "0.1.0";
  const hardware = options.hardware === true;
  const dio = options.dio === true;
  const modules = parseHardwareModules(options.hardwareModules === undefined ? undefined : [...options.hardwareModules], "hardwareModules");
  const explicitPermissions = validatePermissionKeys(options.permissions ?? [], "permissions");
  const selection = hardwareSelection(hardware, modules, explicitPermissions);
  const platform = resolvePlatformExperience(options);
  if (!projectIdPattern.test(id)) fail(`project id is unsafe: ${id}`);
  if (!appIdPattern.test(appId)) fail(`app id is unsafe: ${appId}`);
  if (!versionPattern.test(version)) fail(`version is unsafe: ${version}`);

  writeJson(join(project, "editor.json"), { id, appId, name, title: name, version, build: 1, tickHz: 60, entry: "app.tsx", framework: "solid", hardware, dio,
    ...(selection.modules.length > 0 ? { hardwareModules: selection.modules } : {}),
    ...(explicitPermissions.length > 0 ? { permissions: explicitPermissions } : {}),
    ...(platform.platformExperience ? { platformExperience: true } : {}),
    ...(platform.deepLinkScheme ? { deepLinkScheme: platform.deepLinkScheme } : {}),
  });
  writeJson(join(project, "pocket.json"), {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: appId,
    name,
    title: name,
    version,
    build: 1,
    engine: { capabilities: { requires: ["text.glyphs.baked"], enhances: [] } },
    app: { entry: "app.tsx", output: "app", framework: "solid" },
  });
  writeJson(join(project, "manifest.json"), {
    $schema: "https://pocketjs.dev/schema/pocket-guest-manifest.json",
    protocolVersion: 1,
    capabilities: { requires: ["text.glyphs.baked"], optional: [
      ...selection.capabilities,
      ...(shouldRegisterPermissionPlugin(selection)
        ? ["permissions.status", "permissions.request", "permissions.openSettings"]
        : []),
      ...(dio ? ["dio.request"] : []),
      ...(platform.platformExperience ? ["platform.systemUi.set", "platform.haptics.perform"] : []),
      ...(platform.deepLinkScheme ? ["platform.links.initial", "platform.links.latest", "platform.links.events"] : []),
    ] },
    permissions: { optional: [...selection.permissions, ...(dio ? ["network"] : [])] },
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
  createFlutterHost(project, sdk, appId, selection, dio, platform);
  writeFileSync(join(project, "README.md"), `# ${name}\n\nGenerated by the local PocketJS SDK.\n\n- Edit \`app.tsx\` and files under \`vendor/pocket-ui\` only when intentionally vendoring the UI package.\n- Build real QuickJS bytecode with \`bun ${sdk}/pocket.ts build .\`.\n- Open the project in Pocket Studio with \`bun ${sdk}/pocket.ts editor .\`.\n- The Flutter host is in \`flutter/\`; run \`flutter pub get\` there after the SDK is available.\n${hardware ? "- Hardware mode is enabled for the compiled iOS/Android provider; review Info.plist and AndroidManifest runtime declarations and request permissions only from an explicit guest action.\n" : ""}`);
  return project;
}

function projectConfig(project: string): {
  appId: string;
  version: string;
  build: number;
  tickHz: number;
  hardware: boolean;
  dio: boolean;
  selection: HardwareSelection;
  deepLinkScheme?: string;
} {
  const editorPath = join(project, "editor.json");
  const pocketPath = join(project, "pocket.json");
  const manifestPath = join(project, "manifest.json");
  const editor = existsSync(editorPath) ? readJson(editorPath) : undefined;
  const pocket = existsSync(pocketPath) ? readJson(pocketPath) : undefined;
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
  if (editor && editor.build !== undefined && (!Number.isSafeInteger(Number(editor.build)) || Number(editor.build) < 1)) {
    fail(`project build must be a positive safe integer in ${project}`);
  }
  if (pocket && pocket.build !== undefined && (!Number.isSafeInteger(Number(pocket.build)) || Number(pocket.build) < 1)) {
    fail(`project build must be a positive safe integer in ${project}`);
  }
  const appId = typeof editor?.appId === "string" ? editor.appId : (typeof pocket?.id === "string" ? pocket.id : undefined);
  // Keep the CLI project identity in lockstep with build_guest: select one
  // complete release object (editor > pocket > manifest) instead of mixing a
  // version from one config file with a build from another.
  const identity = resolveReleaseIdentity(project, manifest);
  const version = identity.version;
  const build = identity.build;
  const tickHz = typeof editor?.tickHz === "number" ? editor.tickHz : 60;
  const hardware = editor?.hardware === true;
  const dio = editor?.dio === true;
  const modules = parseHardwareModules(editor?.hardwareModules, "editor.hardwareModules");
  const permissionsValue = editor?.permissions;
  const permissions = permissionsValue === undefined
    ? []
    : (Array.isArray(permissionsValue) ? validatePermissionKeys(permissionsValue, "editor.permissions") : fail("editor.permissions must be an array of runtime policy keys"));
  const selection = hardwareSelection(hardware, modules, permissions);
  if (editor?.deepLinkScheme !== undefined && typeof editor.deepLinkScheme !== "string") fail("editor.deepLinkScheme must be a string");
  const platform = resolvePlatformExperience({ platformExperience: editor?.platformExperience === true, deepLinkScheme: editor?.deepLinkScheme as string | undefined });
  if (typeof appId !== "string" || !appIdPattern.test(appId)) fail(`unsafe appId in ${project}`);
  if (typeof version !== "string" || !versionPattern.test(version)) fail(`unsafe version in ${project}`);
  if (!Number.isSafeInteger(build) || build < 1) fail(`unsafe build in ${project}`);
  if (!Number.isInteger(tickHz) || tickHz < 1 || tickHz > 120) fail(`unsafe tickHz in ${project}`);
  return { appId, version, build, tickHz, hardware, dio, selection, deepLinkScheme: platform.deepLinkScheme };
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
  patchAndroidHardwareManifest(androidDirectory, config.hardware, config.dio, config.selection.modules, config.selection.runtimePermissions);
  patchAndroidMinimum(androidDirectory);
  if (options.platform) {
    prepareNative(sdk, options.platform);
    if (options.platform === "ios-sim" || options.platform === "ios") {
      const flutterDirectory = join(project, "flutter");
      const iosDirectory = join(flutterDirectory, "ios");
      patchIosMinimum(iosDirectory, config.hardware, config.selection.modules, config.selection.runtimePermissions);
      patchIosSceneLifecycle(iosDirectory);
    }
  }
  patchDeepLinkPlatforms(join(project, "flutter"), config.deepLinkScheme);
  const output = resolve(options.outDir ?? join(project, "build/pocket"));
  mkdirSync(output, { recursive: true });
  const flutterAssets = join(project, "flutter/assets");
  const staging = mkdtempSync(join(tmpdir(), "pocket-sdk-build-"));
  try {
    const built = await buildGuest({
      projectRoot: project,
      outDir: staging,
      tickHz: config.tickHz,
      copyAssetsTo: flutterAssets,
    });
    for (const name of ["app.js", "app.pak", "app.qjbc", "app.bytecode.json"] as const) {
      const source = join(staging, name);
      if (!existsSync(source)) fail(`compiler did not produce ${name}`);
      cpSync(source, join(output, name));
    }
    if (built.worker || existsSync(join(staging, "app.worker.qjbc"))) {
      for (const name of ["app.worker.qjbc", "app.worker.bytecode.json"] as const) {
        const source = join(staging, name);
        if (existsSync(source)) cpSync(source, join(output, name));
      }
    }
    // The source manifest declares the guest protocol and capabilities. Add
    // the resolved release identity only to the generated artifact so a
    // stale checked-in manifest can never pin the bytecode below editor.json.
    const manifestSource = existsSync(join(staging, "guest-manifest.json"))
      ? join(staging, "guest-manifest.json")
      : join(project, "manifest.json");
    const guestManifest = {
      ...readJson(manifestSource),
      version: config.version,
      build: config.build,
    };
    writeJson(join(output, "guest-manifest.json"), guestManifest);
    const metadata = readJson(join(output, "app.bytecode.json"));
    if (metadata.entryFormat !== "quickjs-bytecode" || typeof metadata.runtimeAbi !== "string" || !metadata.runtimeAbi) fail("bytecode metadata is not a real QuickJS artifact");
    mkdirSync(flutterAssets, { recursive: true });
    for (const name of ["app.qjbc", "app.pak", "app.bytecode.json", "guest-manifest.json"]) cpSync(join(output, name), join(flutterAssets, name));
    if (existsSync(flutterAssets) && (built.worker || existsSync(join(staging, "app.worker.qjbc")))) {
      for (const name of ["app.worker.qjbc", "app.worker.bytecode.json"] as const) {
        const source = join(output, name);
        if (existsSync(source)) cpSync(source, join(flutterAssets, name));
      }
    }
    const buildInfo = { appId: config.appId, version: config.version, build: config.build, tickHz: config.tickHz, entryFormat: "quickjs-bytecode", runtimeAbi: metadata.runtimeAbi, output };
    writeJson(join(output, "build.json"), buildInfo);
    console.log(JSON.stringify({ ok: true, project, output, qjbc: join(output, "app.qjbc"), pak: join(output, "app.pak"), metadata: join(output, "app.bytecode.json"), runtimeAbi: metadata.runtimeAbi }, null, 2));
    return { project, output, qjbc: join(output, "app.qjbc"), pak: join(output, "app.pak"), metadata: join(output, "app.bytecode.json") };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function runEditor(directory: string, options: { port?: number; workspace?: string; flutterRoot?: string }): Promise<void> {
  const project = resolve(directory);
  if (!existsSync(join(project, "pocket.json"))) fail(`not an initialized PocketJS project: ${project}`);
  const { startEditor } = await import("./editor/server.ts");
  const server = await startEditor({ projectRoot: project, flutterRoot: options.flutterRoot, workspace: options.workspace ?? join(project, ".pocket-editor"), port: options.port });
  console.log(`Pocket Studio listening at http://${server.hostname}:${server.port}`);
  console.log(`project: ${project}`);
  await new Promise<void>((resolveExit) => {
    const stop = () => { server.stop(true); resolveExit(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/** Generate data-only plugin contracts; never execute a consumer or install native code. */
export async function exportPluginTypes(inputPath: string, outputPath: string): Promise<void> {
  const source = resolve(inputPath);
  if (lstatSync(source).size > 256 * 1024) fail("plugin descriptor export exceeds 256 KiB");
  const { generatePluginTypesReport } = await import("./scripts/plugin_types.ts");
  const generated = generatePluginTypesReport(readJson(source));
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated.source);
  console.log(JSON.stringify({ output, capabilities: generated.includedCapabilities, unavailable: generated.unavailableCapabilities }, null, 2));
}

function usage(): never {
  console.error("usage: bun pocket.ts init <directory> [--sdk-root=DIR] [--app-id=ID] [--name=NAME] [--version=VERSION] [--hardware] [--camera] [--bluetooth] [--sensors] [--location] [--biometrics] [--weather] [--permissions=POLICY_KEYS] [--dio] [--platform-experience] [--deep-link-scheme=SCHEME]\n       bun pocket.ts build <directory> [--sdk-root=DIR] [--out=DIR] [--platform=ios-sim|ios|macos|android]\n       bun pocket.ts types <descriptor.json> --out=plugin-types.ts\n       bun pocket.ts editor <directory> [--port=N] [--workspace=DIR] [--flutter-root=DIR]");
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
      const hardwareModules = hardwareModuleNames.filter((module) => takeBooleanFlag(args, module));
      const permissions = parsePermissionKeys(takeFlag(args, "permissions"));
      const dio = takeBooleanFlag(args, "dio");
      const platformExperience = takeBooleanFlag(args, "platform-experience");
      const deepLinkScheme = takeFlag(args, "deep-link-scheme");
      ensureNoArgs(args);
      console.log(`pocket init: ${await initProject(directory, { sdkRoot: sdk, appId, name, version, hardware, hardwareModules, permissions, dio, platformExperience, deepLinkScheme })}`);
    } else if (command === "build") {
      const directory = takePosition(args, "project directory");
      const out = takeFlag(args, "out");
      const sdk = takeFlag(args, "sdk-root");
      const platformValue = takeFlag(args, "platform");
      const platform = platformValue as NativePlatform | undefined;
      if (platform !== undefined && platform !== "ios-sim" && platform !== "ios" && platform !== "macos" && platform !== "android") fail("--platform must be ios-sim, ios, macos, or android");
      ensureNoArgs(args);
      await buildProject(directory, { outDir: out, sdkRoot: sdk, platform });
    } else if (command === "types") {
      const input = takePosition(args, "plugin descriptor JSON");
      const output = takeFlag(args, "out");
      if (!output) fail("types requires --out=plugin-types.ts");
      ensureNoArgs(args);
      await exportPluginTypes(input, output);
    } else if (command === "editor") {
      const directory = takePosition(args, "project directory");
      const portValue = takeFlag(args, "port");
      const workspace = takeFlag(args, "workspace");
      const flutterRoot = takeFlag(args, "flutter-root");
      ensureNoArgs(args);
      const port = portValue === undefined ? undefined : Number(portValue);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) fail("--port must be an integer from 0 through 65535");
      await runEditor(directory, { port, workspace, flutterRoot });
    } else usage();
  } catch (error) {
    console.error(`pocket: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
