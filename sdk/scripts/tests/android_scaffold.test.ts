import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchAndroidHardwareManifest, patchAndroidMinimum } from "../../pocket.ts";

const root = mkdtempSync(join(tmpdir(), "pocket-android-scaffold-test-"));
try {
  const android = join(root, "android");
  const manifestDirectory = join(android, "app/src/main");
  mkdirSync(manifestDirectory, { recursive: true });
  const manifest = join(manifestDirectory, "AndroidManifest.xml");
  writeFileSync(manifest, `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="fixture" />
</manifest>
`);

  // A non-hardware project must not acquire permissions just because an
  // Android project happens to be present.
  const before = readFileSync(manifest, "utf8");
  patchAndroidHardwareManifest(android, false);
  assert.equal(readFileSync(manifest, "utf8"), before);

  patchAndroidHardwareManifest(android, true);
  const once = readFileSync(manifest, "utf8");
  for (const permission of [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.USE_BIOMETRIC",
    "android.permission.USE_FINGERPRINT",
  ]) {
    const escaped = permission.replaceAll(".", "\\.");
    assert.match(once, new RegExp(`android:name="${escaped}"`));
    assert.equal((once.match(new RegExp(`android:name="${escaped}"`, "g")) ?? []).length, 1);
  }
  assert.match(once, /BLUETOOTH_SCAN[^>]*usesPermissionFlags="neverForLocation"/);
  assert.match(once, /BLUETOOTH[^>]*maxSdkVersion="30"/);
  assert.match(once, /USE_FINGERPRINT[^>]*maxSdkVersion="27"/);
  for (const removed of [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VISUAL_USER_SELECTED",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.BLUETOOTH_ADVERTISE",
    "android.permission.BODY_SENSORS",
  ]) {
    assert.doesNotMatch(once, new RegExp(`android:name="${removed.replaceAll(".", "\\.")}"`));
  }

  // Generated and existing hosts can both run this patch during init/build;
  // the manifest must stay byte-for-byte stable after the first application.
  patchAndroidHardwareManifest(android, true);
  assert.equal(readFileSync(manifest, "utf8"), once);

  const buildGradle = join(android, "app/build.gradle.kts");
  writeFileSync(buildGradle, `android {
    defaultConfig {
        minSdk = flutter.minSdkVersion
    }
}
`);
  patchAndroidMinimum(android);
  const patchedGradle = readFileSync(buildGradle, "utf8");
  assert.match(patchedGradle, /minSdk = maxOf\(flutter\.minSdkVersion, 24\)/);
  patchAndroidMinimum(android);
  assert.equal(readFileSync(buildGradle, "utf8"), patchedGradle);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("android_scaffold.test: hardware manifest declarations and idempotence passed");
