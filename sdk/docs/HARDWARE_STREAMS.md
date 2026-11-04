# Hardware streams

This document records the retained-demo provenance and the streaming boundary
for `pocket_hardware`. The provider remains a thin Dart/native adapter: guest
UI, routing, policy, and subscription state stay in JS.

## Retained source review

Before implementing the stream boundary, the retained parent demo was checked
outside its `pocket_host/` directory:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/real_hardware_bridge.dart`
  records the original `com.pocketnexus.host/hardware` method names and the
  one-shot BLE/sensor request shapes. Its fixture and fallback responses are
  deliberately not reused.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/ios/Runner/AppDelegate.swift`
  contains the real `CBCentralManager`/`CBPeripheralDelegate` discovery path
  and the `CMMotionManager`/`CMAltimeter` producer path. The reusable provider
  adapts those paths into `PocketHardwareManager.swift`.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/mini_apps/syslib/pocket_syslib_hardware.js`
  documents JS-side BLE packet parsing and barometer interpretation. Parsing
  remains JS-owned; native forwards real bytes and sensor values only.

The old `pocket_host/` tree was excluded as required. The old bridge's seeded
sensor/BLE/photo fallbacks were not carried over; unavailable hardware returns
structured errors.

## Capabilities

The descriptor exposes method-level permissions for:

| Capability | Kind | Permission | Native operation |
| --- | --- | --- | --- |
| `hardware.sensors.watch` | stream | `hardware.sensors` | `startHardwareStream(kind: sensors)` |
| `hardware.bluetooth.read` | request | `hardware.bluetooth` | `readBleCharacteristic` |
| `hardware.bluetooth.write` | request | `hardware.bluetooth` | `writeBleCharacteristic` |
| `hardware.bluetooth.notifications` | stream | `hardware.bluetooth` | `startHardwareStream(kind: ble.notifications)` |

Sensor `samplingHz` is an integer in `[1, 60]`, default `10`. BLE read,
write, and notification parameters all use:

```json
{
  "deviceId": "<discovered peripheral UUID>",
  "serviceUuid": "<discovered service UUID>",
  "characteristicUuid": "<discovered characteristic UUID>"
}
```

Write adds `value`, an array of integer bytes in `[0, 255]`, and optional
`withResponse` (default `true`). Native connect discovery returns nested
`services` with characteristic UUIDs and property names, plus `serviceUuids`
for clients that only need the legacy service inventory.

## Dart/native event protocol

`HardwareStreamingPlatform` is an optional extension to the existing
`HardwarePlatform`; old test fakes implementing only `HardwarePlatform` remain
valid. `MethodChannelHardwarePlatform` lazily exposes one cached broadcast
`EventChannel` source:

`com.pocketnexus.host/hardware/sensors/events` and
`com.pocketnexus.host/hardware/bluetooth/events`

The default adapter merges only the selected providers. Camera, location and
biometrics do not expose event channels.

The source is subscribed before `startHardwareStream` is invoked. Dart derives
the native id as `flutter.hardware:<trusted-app-id>:<trusted-session-id>:<guest-stream-id>`;
the guest id is never sent to native by itself. Native events are routed by
that provider/session-unique `streamId`:

```json
{"streamId":"...", "data": {"...":"..."}}
{"streamId":"...", "error":{"code":"...", "message":"..."}}
{"streamId":"...", "done":true}
```

Both platform boundaries use real producers: iOS uses Core Motion/barometer
and CoreBluetooth, while Android uses SensorManager and BluetoothGatt. Each
platform bounds packets retained before the EventChannel sink is ready. Each
subscription starts/stops only its own native producer. Sensor samples come
from OS sensor callbacks; BLE notifications come from the discovered connected
characteristic and forward the real byte array.

`startHardwareStream` receives `{kind, streamId, sessionId, ...params}` and
`stopHardwareStream` receives `{kind, streamId, sessionId}`. The retained
`kind` is required for both calls (`sensors` or `ble.notifications`); missing
or unknown kinds are rejected before native dispatch. Dart derives the trusted
session value from `PocketPluginContext.appId` and `.sessionId`; guest stream
parameters cannot replace it. One-shot BLE read/write, BLE scan, and sensor
reads use the same trusted session value. OS permission requests use the
separate permission_handler provider. Native owner checks
reject cross-session characteristic access, late callbacks, disconnected
peripherals, permission loss, duplicate stream IDs, and cancelled/disposed
streams. GATT queues are serial per peripheral: a timeout or disconnect fences
the current and queued operations, cancels the connection, fails pending
results, and does not start the next operation. CCCD enable/disable is in that
same queue; a failed disable aborts the peripheral so notification producers
cannot leak.

Deactivation and disposal stop the provider's streams before releasing the
session. A session only releases its own GATT owner, scan, sensor operation,
and stream registrations; the method-channel and event-channel operations are
idempotent on late stop or disconnect.

The hardware descriptor does not impose a short provider-side event count:
continuous watches use the existing `PocketPluginManager` host budget (default
`maxStreamEvents: 10000`). The host still enforces the cumulative event quota
and per-event byte quota for every provider stream; removing the old provider
limit does not remove or raise those security limits.

The native manager and EventChannel sink are process-wide and currently support
one FlutterEngine per process. Multiple `HardwarePlugin` instances in that
engine are isolated by trusted session/native stream ids, but a second engine
cannot register an independent native sink. Same-process engine replacement
has not been implemented; multiple engines require separate processes.

## Verification and limits

- `swiftc -parse sdk/packages/pocket_hardware/ios/Classes/PocketHardwareManager.swift`
  checks Swift syntax only; it is not an Xcode framework typecheck.
- `dart analyze sdk/packages/pocket_hardware` checks the Dart adapter.
- Physical BLE/sensor behavior still requires an iOS or Android device with
  the proper usage declarations and OS permissions. A simulator or denied
  permission produces an explicit error; it is not reported as success.
- Xcode/Kotlin compilation and device/simulator integration remain host-level
  verification steps; this package change does not claim those builds passed.
