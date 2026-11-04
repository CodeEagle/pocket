For App-owned nearby scanning in the current Chrome preview on macOS, see [Local Bluetooth preview](LOCAL_BLUETOOTH_PREVIEW.md). The browser-only mode documented below remains optional.

# Optional Web Bluetooth preview plugin

The editor's **More → Web plugins · Flutter → Web Bluetooth** switch is off by
default. It uses the browser's real `navigator.bluetooth` implementation for the
native Canvas guest preview. The preference is saved locally; copied/opened
Flutter preview links preserve `?webBluetooth=1`. Standalone preview pages can
also opt in with that query parameter. The WeChat runner has a separate bridge
and is not silently given this adapter.

The browser must expose Web Bluetooth in a secure context (localhost or HTTPS).
The editor disables the switch when this API is unavailable. The browser and
operating system still control device permission; enabling the plugin does not
grant permission or start scanning on its own.

## Source-first adaptation

Reviewed the retained parent, excluding `pocket_host/`:

- `pocketjs_flutter_demo/lib/core/real_hardware_bridge.dart`: real permission,
  BLE scan and GATT connection boundaries (around lines 290–324).
- `pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_hardware.js`: hardware
  demonstration entry points, including Bluetooth scan.

There is no retained Web Bluetooth adapter to copy. Reuse the migrated contract
from `sdk/packages/pocket_hardware_core/lib/src/hardware_plugin.dart`,
`sdk/packages/pocket_bluetooth/android/src/main/kotlin/dev/pocketjs/pocket_bluetooth/`
and the existing JS host/stream adapters. Browser-specific adaptation is needed
because Guest JavaScript executes in the pinned native PocketJS runtime, and
browser Bluetooth objects cannot cross its JSON transport.

The plugin is isolated in `sdk/editor/client/plugins/web-bluetooth.js`. It
performs Bluetooth IO in the browser; `preview.ts` routes existing Guest
requests/results over SSE and the ordinary preview input lane. No Dart logic,
layout engine, mock runtime, or separate Guest Bluetooth API is added.

## Existing capability mapping

| Capability | Browser operation |
| --- | --- |
| `hardware.permissions.request` with `permission: "hardware.bluetooth"` | Explicit device chooser; grants access only after browser selection |
| `hardware.bluetooth.scan` | Return this Guest scope’s authorized devices; if none, request a device through the browser chooser |
| `hardware.bluetooth.connect` | `device.gatt.connect`, accessible service/characteristic discovery |
| `hardware.bluetooth.read` | Characteristic `readValue` |
| `hardware.bluetooth.write` | Write with/without response, maximum 512 bytes |
| stream `hardware.bluetooth.notifications` | `startNotifications` and characteristic change events |

Selectors retain `deviceId`, `serviceUuid`, `characteristicUuid`; write retains
`value` and `withResponse`. Results retain the native inventory and byte-array
shapes, with `source: "web-bluetooth"` identifying the actual provider.

`requestDevice` is a browser chooser, not a passive scan. The plugin presents a
**Choose device** button when the Guest requests a scan or Bluetooth permission.
In the editor it floats above the outer page so phone scaling, clipping and
notches cannot hide the action. This direct click is
necessary because a Guest input event has already crossed HTTP/native execution
and cannot reliably preserve transient user activation. Canceling the chooser
rejects the original request instead of returning an invented device list.
Device IDs are browser-scoped opaque identifiers; RSSI/MTU are not fabricated.

The flow is **Request → browser device authorization → App Scan → Connect**.
After Request succeeds, Scan returns the real devices selected in this Guest
scope with `scanMode: "authorized-devices"`; it does not reopen the chooser.
This list is not a new nearby-device discovery and does not prove those devices
are currently in range. The browser provides no general Bluetooth permission
that unlocks native-style scanning of all nearby devices through requestDevice.
A first Scan without prior authorization remains a convenience entry into the
browser chooser. Request again to authorize another device. No other Guest’s
selected device or global `getDevices()` result is silently imported.


For GATT discovery, supply known service UUIDs in `services`/`optionalServices`,
or enter them in the chooser's optional-services field before choosing. The
browser grants access only to the requested services. Standard browser service
names such as `battery_service` are accepted as well as service UUIDs. Existing
Guest code can keep its capability calls; generic scans that do not name a
service may select a device but cannot assume all GATT services are accessible.

## Limits and lifecycle

Only one browser subscriber owns Bluetooth for a running preview session.
Request/stream correlation stays bound to its originating Guest runtime; root
and child request IDs are not interchangeable. Disable, disconnect and runtime
teardown clean up pending work, notification listeners and connections. Each
request and initial subscription has a bounded timeout; an established
notification subscription remains active until canceled, disconnected or disposed. Other
native hardware capabilities retain their explicit unsupported behavior.

This adapter covers Bluetooth LE GATT supported by Web Bluetooth. It does not
provide classic Bluetooth, unrestricted advertisement scanning, arbitrary
service access, or a Bluetooth implementation in browsers that lack the API.

## Verification

Tests are kept separate from production IO. Adapter tests use explicit test
Bluetooth objects for read/write, notification events, cancellation, failed
subscription cleanup and disposal. Transport tests cover owner routing,
malformed payloads and stale responses after disable.

`web_bluetooth_browser.test.ts` compiles the fixture with the pinned PocketJS
bytecode pipeline and executes the native Guest. It verifies default-off
rejection and Chromium's real `requestDevice` chooser using a CDP preconnected
test device. Both scan and Bluetooth permission requests are verified in an
embedded preview, including real browser transient activation from the outer
page button. It then injects an explicit test-only GATT provider to verify native
connect/read/write request routing, input-driven frame changes, and immediate
disable/connection cleanup. Chromium 156's CDP adapter stopped responding to
GATT operations in this environment; this test does **not** claim real-radio GATT
or physical-device verification. Production never installs that test provider.

Validation passed: 11 tests across the Bluetooth adapter, transport, native browser
acceptance, editor/WeChat controls, existing native preview acceptance and native
route transitions. No physical peripheral was available for verification.

To verify a physical peripheral, enable the switch, open the Showcase Bluetooth
panel, request a scan, enter the peripheral's services, choose it through the
browser, then connect/read/write or subscribe to a notifiable characteristic.
Close the subscription and disable the plugin to release its connection.

Browser requirements and API behavior:
[Chrome Web Bluetooth guide](https://developer.chrome.com/docs/capabilities/bluetooth),
[Web Bluetooth specification](https://webbluetoothcg.github.io/web-bluetooth/).

## Local HTTP diagnosis

`http://127.0.0.1` and `http://localhost` are treated as trustworthy local
origins; HTTPS is not required for this editor on loopback. A LAN HTTP address
is different and requires trusted HTTPS. On 2026-11-04 the reported page was
`http://127.0.0.1:8793`, with Web Bluetooth enabled. The missing permission
request mapping and the easily missed confirmation inside the phone were
corrected; no CA/private key was loaded or browser security bypass added.
A timed-out selection now reports a timeout with a Choose device instruction,
rather than incorrectly saying the user canceled.

2026-11-04 authorization-flow correction: native browser acceptance now performs
Request in the embedded app, selects a CDP device through the real browser
chooser, then performs App Scan and verifies that no second chooser or permission
prompt appears. Adapter tests verify scope isolation and first-scan fallback.
The Showcase labels cached authorization results as authorized devices rather
than nearby devices found. The configured 8793 Showcase rebuild completed.
The broader demo mobile UI source-assertion script currently fails at its
pre-existing `display.ts` callback-pattern assertion (`previous?.(line)`); that
unrelated implementation and assertion were left unchanged.
