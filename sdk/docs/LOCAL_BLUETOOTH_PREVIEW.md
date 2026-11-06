# Local Bluetooth in Chrome preview

On macOS the optional preview Bluetooth plugin defaults to **Native macOS · nearby scan**. Enable it in preview options. In the App, request `hardware.bluetooth` permission, then scan and select a device from the App list. macOS owns the system permission prompt; Chrome does not show a device chooser in this mode. Scans return a bounded snapshot of nearby BLE peripherals, including their actual RSSI. Connect/read/write/notification operations use CoreBluetooth.

The alternative **Web Bluetooth · device chooser** remains available. Its browser permission flow selects a device; subsequent scans enumerate authorized devices, not all nearby peripherals. HTTPS does not remove that browser API restriction.

## Architecture and ablation

The editor lazily compiles a signed local helper app with Swift/CoreBluetooth. Generated helper binaries live in the build cache, not source. Xcode command line tools are required for the first build. No additional network service or exposed hardware endpoint is created: the existing loopback editor preview transport routes requests to the helper's JSON-line stdin/stdout protocol.

The native core is shared with the iOS plugin in `sdk/packages/pocket_bluetooth/ios/pocket_bluetooth/Sources/pocket_bluetooth/PocketBluetoothCore.swift`. `PocketBluetoothPlugin.swift` is only the Flutter channel adapter; `sdk/editor/native/macos-bluetooth/main.swift` is only the process adapter. The implementation does not introduce a second scanning/GATT state machine, simulated peripherals, or fabricated signal strength. Business UI and device selection remain in JS.

Preview leases and runtime generations isolate native scopes. Turning the plugin off, closing the preview, changing runtimes, or stopping the server disposes owned native work. Native stream identifiers are mapped independently from guest identifiers. A scope can only connect to devices returned by its own scan.

## Retained source

Before implementing this capability, the retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected outside `pocket_host/`. Its `lib/core/real_hardware_bridge.dart` is a platform-channel wrapper with simulated fallback, not a usable production macOS scanner. That fallback was not retained. The SDK's existing `pocket_bluetooth` iOS CoreBluetooth implementation supplied real scanning, connection, characteristic discovery, read/write and notification behavior. Those implementations were extracted into the shared core; the necessary adaptations are conditional platform imports/authorization handling, a permission entry point, scope cleanup and the JSON-line process boundary. The existing JS hardware capabilities and Showcase device list are reused.

For comparison, SyncDo's Electron host intercepts Chromium's `select-bluetooth-device` event and forwards candidate lists over IPC. Ordinary Chrome has no equivalent host hook; CoreBluetooth supplies the missing local capability here.

## Validation boundaries

`local_bluetooth.test.ts` verifies helper protocol, errors, lifecycle and scope isolation using explicit test processes. The browser acceptance fixture runs pinned PocketJS bytecode in the actual native guest and sends pointer input through Playwright Chromium; its local-native provider is explicitly a test fixture. It verifies App permission/scan updates, RSSI rendering, no browser chooser and disabling cleanup. The separate Web Bluetooth path tests Chromium's real chooser with CDP test devices, followed by a test GATT provider.

Swift helper compilation and JSON-line smoke checks validate the real native boundary. Physical peripheral discovery, connection and GATT traffic require a powered-on adapter, macOS permission and a suitable peripheral; test fixture results are not evidence of physical radio traffic. The bridge currently supports macOS preview hosts only.

Verified in this change: Swift compilation with warnings as errors and type checking; JSONL unknown-method/dispose responses and EOF/SIGTERM exit; six browser-plugin/preview transport regressions; the preview settings browser regression; and pinned native Guest plus Chromium acceptance for both provider modes. The Showcase was rebuilt through the editor build endpoint. No physical GATT read/write has been claimed.

The production factory also successfully compiled and launched its cached helper app. `codesign --verify --deep --strict` passed. A real short scan request returned structured `hardware_permission_denied` before macOS authorization, and scope/provider disposal exited normally. Nearby discovery on this machine therefore still requires the user to grant Bluetooth access through the App Request action.
