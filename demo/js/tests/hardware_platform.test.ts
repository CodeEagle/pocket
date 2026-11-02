import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdkRoot = join(root, "../../sdk");
const pageSource = readFileSync(join(root, "mobile-pages.tsx"), "utf8");
const stateSource = readFileSync(join(root, "state.ts"), "utf8");
const pocketSource = readFileSync(join(sdkRoot, "pocket.ts"), "utf8");
const androidManifest = readFileSync(join(root, "../android/app/src/main/AndroidManifest.xml"), "utf8");
const androidBuild = readFileSync(join(root, "../android/app/build.gradle.kts"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
  capabilities?: { optional?: string[] };
  permissions?: { optional?: string[] };
};

const capabilities = manifest.capabilities?.optional ?? [];
const permissions = manifest.permissions?.optional ?? [];
for (const capability of [
  "hardware.permissions",
  "hardware.permissions.request",
  "hardware.camera.preview.start",
  "hardware.camera.preview.stop",
  "hardware.camera.capture",
  "hardware.photos.list",
  "hardware.photos.delete",
  "hardware.bluetooth.scan",
  "hardware.bluetooth.connect",
  "hardware.sensors.read",
  "hardware.biometrics.authenticate",
  "hardware.location.current",
  "hardware.weather.current",
]) {
  assert.ok(capabilities.includes(capability), `guest manifest must declare ${capability}`);
  assert.match(pageSource, new RegExp(capability.replaceAll(".", "\\.")));
}
for (const permission of [
  "hardware.camera",
  "hardware.photos",
  "hardware.bluetooth",
  "hardware.sensors",
  "hardware.biometrics",
  "hardware.location",
  "hardware.microphone",
  "hardware.network",
]) {
  assert.ok(permissions.includes(permission), `guest manifest must declare ${permission}`);
  assert.match(stateSource, new RegExp(permission.replaceAll(".", "\\.")));
}

// The JS guest talks only in capability names. It must not disable the
// hardware lane because the host happens to be Android instead of iOS.
assert.doesNotMatch(pageSource + stateSource, /Platform\.isIOS|TargetPlatform\.iOS|iOS-only|iOS only/);
assert.match(pocketSource, /patchAndroidHardwareManifest/);
assert.match(pocketSource, /patchAndroidMinimum/);
for (const permission of [
  "android.permission.INTERNET",
  "android.permission.CAMERA",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.USE_BIOMETRIC",
]) {
  assert.match(androidManifest, new RegExp(`android:name="${permission.replaceAll(".", "\\.")}"`));
}
for (const permission of [
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.BODY_SENSORS",
]) {
  assert.doesNotMatch(androidManifest, new RegExp(`android:name="${permission.replaceAll(".", "\\.")}"`));
}
assert.match(androidBuild, /minSdk = maxOf\(flutter\.minSdkVersion, 24\)/);

console.log("hardware_platform.test: JS capability declarations are platform-neutral and Android permission ablation is present");
