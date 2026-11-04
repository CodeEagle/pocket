# Hardware capability reuse

> 拆分更新：当前按需包、权限接入、原生源码映射及验证见 [HARDWARE_MODULES.md](HARDWARE_MODULES.md)。本文保留迁移时的来源记录；下文旧 `pocket_hardware/android`、`ios` 实现已分别移动到独立能力包。

当前可复用包位于 `../packages/pocket_hardware`，Demo 的真实能力页面和集成测试位于
`../demo/js`、`../demo/integration_test`。文中的旧 `host/` 路径是来源记录，不是第二套宿主实现。

`flutter.hardware` is a host-compiled provider.  The guest can request a
declared capability, but it cannot ship a Flutter plugin, load a native
library, or choose an arbitrary method channel.  `PocketSession` is responsible
for registering this provider and for intersecting the signed guest manifest
with its capability and permission allowlists.

## Source and boundary

The implementation was extracted from the old demo sources:

- `lib/core/real_hardware_bridge.dart` supplied the method names and weather
  query shape.  Its fixture/fallback responses were intentionally not carried
  over.
- `ios/Runner/AppDelegate.swift` supplied the AVFoundation, CoreBluetooth,
  CoreLocation, CoreMotion, LocalAuthentication and Photos paths.  The
  independent provider now lives in
  `packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift` and is
  registered by `PocketHardwarePlugin` through the standard Flutter plugin
  registry; it does not reference either old project by path or symlink.
- The retained Android demo supplied the Flutter host/permission baseline and
  Android 12 BLE declaration shape, but it did not contain a hardware provider
  for this MethodChannel.  The Android provider now lives in
  `packages/pocket_hardware/android`; it implements the same Dart method names
  and structured result/error contract instead of copying the old generic
  Android runtime.  `sdk/pocket.ts` owns the repeatable manifest/minSdk patch so
  an external `--hardware` host gets the same declarations as `demo/android`.

The reusable Dart adapter is
`packages/pocket_hardware/lib/src/hardware_plugin.dart`; the host no longer
keeps a second Dart shim. Its only native boundary is
`com.pocketnexus.host/hardware`; tests inject `HardwarePlatform` so the
permission and error protocol can be checked without pretending that a
simulator has sensors or a camera.

Any Flutter app that depends on `pocket_hardware` gets the platform provider
through `GeneratedPluginRegistrant`; the host AppDelegate/MainActivity does not
manually attach a second copy. The Dart adapter is platform-neutral and keeps
the same channel on iOS and Android. A platform build that has no compiled
provider, or a device without the requested hardware, reports structured
unsupported/denied errors rather than silently falling back to fixtures.

## Public capability contract

The descriptor id is `flutter.hardware`, version `1.0.0`.  The capability
constants are exported by `hardware_plugin.dart`:

| Capability | Native operation | Result notes |
| --- | --- | --- |
| `hardware.permissions` | `checkPermissions` | Per-permission `supported`, `status`, and `granted`. |
| `hardware.permissions.request` | `requestPermission` | Requests a real OS permission; it does not grant a denied one. |
| `hardware.camera.preview.start` | `startCameraPreview` | Returns `textureId`, `width`, `height`, `lens`. |
| `hardware.camera.preview.stop` | `stopCameraPreview` | Stops capture and unregisters the Flutter texture. |
| `hardware.camera.lens.switch` | `switchCameraLens` | Reconfigures the real front/back device. |
| `hardware.camera.flash.toggle` | `toggleCameraFlash` | Returns `on`, `off`, or `auto`; no-flash cameras fail. |
| `hardware.camera.capture` | `capturePhoto` | Writes a real JPEG under `Documents/pocket_photos`. |
| `hardware.photos.list/delete` | `listSavedPhotos` / `deleteSavedPhoto` | Delete is restricted to that host-owned directory. |
| `hardware.bluetooth.scan/connect` | `startBleScan` / `connectBleDevice` | Only discovered CoreBluetooth peripherals may be connected. |
| `hardware.sensors.read` | `readSensors` | Returns actual Core Motion/barometer fields. |
| `hardware.biometrics.authenticate` | `authenticateBiometrics` | `authenticated: false` is a real failed prompt, not success. |
| `hardware.location.current` | `getCurrentLocation` | Returns an actual iOS location fix. |
| `hardware.weather.current` | Open-Meteo HTTPS request | Uses a real location fix or explicit caller coordinates. |

The permission names are `hardware.camera`, `hardware.photos`,
`hardware.bluetooth`, `hardware.sensors`, `hardware.biometrics`,
`hardware.location`, `hardware.microphone`, and `hardware.network`.
`PocketPluginManager` requires every provider permission to be declared by the
guest and then intersects it with the host allowlist before activation.  A
guest that does not declare the provider permissions receives no active
hardware provider.

Every native failure is returned as `{ok:false,errorCode,error}` and becomes a
`PocketCapabilityException` in Dart.  Common codes include
`hardware_unsupported`, `hardware_permission_denied`, `hardware_not_ready`,
`hardware_not_found`, `hardware_timeout`, and `hardware_storage_error`.
There are no seeded GPS values, simulated BLE devices, generated photos, or
desktop success fallbacks.

## Camera texture lifecycle

`startCameraPreview` uses `AVCaptureVideoDataOutput` and a Flutter
`FlutterTextureRegistry` texture.  The response has the following minimum
shape:

```json
{
  "ok": true,
  "previewActive": true,
  "textureId": 17,
  "width": 1920,
  "height": 1080,
  "lens": "back"
}
```

`HardwarePlugin` invokes the optional `onTextureRegistered` and
`onTextureReleased` callbacks. `PocketSession`/PocketViewController should use
the registered id in the JS-owned compositor surface:

```js
pocket.registerSurface(id, 'platformTexture', JSON.stringify({
  textureId,
  sourceWidth: width,
  sourceHeight: height,
  fit: 'cover'
}));
```

The renderer owns only the surface rectangle and fit policy.  On stop,
deactivation, plugin disposal, or guest cutover the callback must remove the
surface before the next guest is mounted.  The native provider stops the
capture session and unregisters the texture in the same operation.

## Platform and permission limits

The compiled provider currently covers iOS and Android.  On macOS, an iOS
simulator without the requested hardware, or a device without the requested
sensor/peripheral, the method channel returns a structured
unsupported/denied/timeout error.  A provider for another platform must be
compiled into that host; a signed update cannot add one.

The consuming iOS target must declare the camera, Photos, Bluetooth,
microphone, location, Face ID, motion, and local-network usage strings in its
`Info.plist` (the sample host keeps them in
`../demo/ios/Runner/Info.plist`). The user still controls the OS prompt. Weather
uses the Open-Meteo network endpoint and reports HTTP, malformed-response,
timeout, and transport errors.

The consuming Android target must use the manifest declarations generated by
`patchAndroidHardwareManifest` (or equivalent explicit declarations): camera,
Android 12 BLE, legacy Bluetooth compatibility, location, and biometric
compatibility permissions. Motion/barometer sensors are read through
`SensorManager` and do not require `BODY_SENSORS`; captured photos stay in the
app-private directory and do not require media/storage permissions; the current
provider has no microphone capture API and therefore does not declare
`RECORD_AUDIO`. The generated host also raises `minSdk` to API 24 to match the
Pocket Flutter Android renderer. Runtime permission requests remain explicit
capability calls; the manifest does not grant access, and Android's system may
still report denied or unavailable.

## Verification

The host-side contract tests are in
`../demo/test/hardware_plugin_test.dart` and cover:

- descriptor capability/permission inventory;
- propagation of a native unsupported response as a structured failure;
- texture registration and release during provider deactivation;
- real-coordinate weather URL construction with an injected response; and
- invalid argument rejection before any native call.

Run them with:

```sh
cd demo
flutter test test/hardware_plugin_test.dart
```

`../demo/integration_test/hardware_native_test.dart` is the App-level device contract:
it calls the production MethodChannel after pumping `PocketHostApp`, checks the
permission status map, requires an explicit unsupported/denied error (and no
texture) for an unavailable camera, accepts sensor failure only as a
structured error, and checks that repeated `disposeSession` calls leave the
provider queryable.  It contains no mock channel handler and is intended to be
run by the host owner on an iOS or Android simulator/device:

```sh
flutter test integration_test/hardware_native_test.dart -d <device-id>
```

Validation record (2026-11-02): the host owner ran this test successfully on
the configured iOS “iPhone Duo” target (`Xcode build done`, one test passed).
That run verifies the production channel's availability/error and cleanup
contract; it does not claim physical-device BLE discovery, GPS fixes, or
other hardware behavior that the target did not exercise.  Android's Dart
contract and generated manifest are covered by source/unit tests; a physical
Android run is still required for camera frames, Photos writes, BLE discovery,
sensors, biometrics, and GPS.

## Glass optics ablation

`../demo/integration_test/glass_optics_test.dart` is a separate renderer/native
surface regression, not the production guest boot path.  It opens the real
`FfiPocketRuntime`, evaluates a tiny raw `ui.createNode`/`pocket.registerSurface`
guest at a 390x600 viewport, and then mounts that frame through `PocketView`.
The test requires the Impeller shader-backed `BackdropFilter`, changes the
registered `glassshape` from rounded to pill, releases the node and native
surface, and compares raw RGBA pixels inside and outside the surface bounds.
This keeps the `SURFACE_QUAD -> Flutter BackdropFilter` path independently
observable while the normal host continues to require signed QuickJS bytecode.

The successful frame is written to the app support `showcase-qa/glass-optics.png`
directory and also reported through `test_driver/showcase.dart`; no device run
is claimed here until the host owner records it.

## Android camera transforms and lifecycle follow-up (2026-11-02)

Camera2 emits `previewRotationDegrees` and `previewMirrorX`. The shared JS
`PlatformTextureSurface` passes these to the existing Flutter texture surface,
which applies quarter-turn layout and horizontal mirroring before fitting.
The producer requests `SCALER_ROTATE_AND_CROP_NONE` where supported; there is
no separate AUTO/fallback rotation pipeline. Defaults remain zero/false for
other texture producers. The surface widget regression verifies 90-degree
rotation and front mirroring. Live display rotation during a camera session
still needs device validation.

Camera failures use the same `{ok:false,errorCode,error}` response as the other
providers. BLE scan completion is single-shot; timeout/detach closes GATT and
ignores late connection callbacks. Activity detach cancels pending permission,
BLE, sensor, biometric and location work. Android photos remain app-private,
not a system gallery browser. The Android provider has no audio capture API;
its microphone status is explicitly unsupported.
