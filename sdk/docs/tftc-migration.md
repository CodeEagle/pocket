# TFTC JavaScript package migration

## Sources inspected first

- Retained parent `pocketjs_flutter_demo/lib/core/real_hardware_bridge.dart` and `mini_apps/syslib/pocket_syslib_hardware.js`: retain the low-level Bluetooth transport boundary. These contain no TFTC product protocol to reuse. The parent `pocket_host/` was excluded and unchanged.
- `funapp/common_lib/packages/tryfun_the_controller/lib/src/components/data_key.dart`, `battery_status.dart`, `device_compact_status.dart`: data key registry, little-endian two-byte liner counters, compact battery/status layout.
- `funapp/common_lib/packages/tryfun_the_controller/lib/src/configs/products/`: product resolver behavior and ranges.
- `funapp/common_lib/packages/tryfun_the_controller/lib/src/the_controller_action.dart`: generic attribute query command `0x06`, replies `0x07`.
- `funapp/common_lib/packages/tryfun_pocket/lib/src/pocket_bluetooth_adapter.dart` and `js/tftc.ts`: App channel aliases and public capabilities. Existing `tftc.*` host forwarding is not reused as the implementation: this migration executes the protocol in JS.
- `funapp/common_lib/packages/tryfun_ble_plus_kit/lib/src/components/tf_device/` and `src/security/tf_security.dart`: protocol/security boundaries.
- `SyncDo/src/renderer/dokidoki-web-bluetooth.js`: retained frame handling, manufacturer/PID checks, handshake ordering, business gates, fragments, correlated responses, write serialization, heartbeat, disconnect generations, YXL ACK/stop and motion logic.
- `SyncDo/src/main/ble-security.js` and `tests/fixtures/security_v1_vectors.json`: v1 key derivation and handshake vectors; AES execution adapted to Web Crypto.
- `SyncDo/tests/dokidoki-protocol.test.js` and `ble-connection-security.test.js`: retained executable regressions, adapted loaders to import the ESM package directly.

## Architecture and ablation

`@pocket/tftc` is an independently installable source package under `sdk/packages/pocket_tftc`. No imports from `demo/`, no production secrets, no Flutter business state machine, compiler fork or runtime fallback.

- Protocol helpers are shared rather than copied into transports. Message IDs belong to each client; removed SyncDo's process-global allocator/reset coupling.
- Removed `window.syncdo`, DOM event dispatch and Electron globals. Bluetooth, security, timers and clock are injected; event subscribers are local to a client.
- The Pocket adapter reuses the current HostBridge/PocketStream adapter. It translates GATT IO and contains no TFTC policies. The Web SDK now routes the same client through the local Noble transport; browser GATT injection is not shipped.
- Device attributes have one observed map. Snapshots derive from received checked payloads; writes do not optimistically create duplicate device facts.
- Generic queries correlate both message ID and expected command. Invalid checksums, timeouts and disconnects reject pending requests.
- v1 AES-ECB block encryption uses the first block of Web Crypto AES-CBC with zero IV. No independent AES implementation or Node runtime dependency was introduced.

## Support boundaries

The retained SyncDo profiles cover TRYFUN-ONE and the DK models listed in `DEVICE_PROFILES` (TF aliases normalize to DK). Unknown models reject explicitly. Product-specific PT3MAX/NAV app mappings and source regression cases are recorded in `products.js`. They share `DATA_KEY` with the core instead of defining another key registry. Their app IDs are known, but the inspected sources do not establish advertisement names/wire PIDs; these are not guessed or automatically registered. Callers may inject a verified device profile through `profileForDevice` and set its `productKey` to select the app mapping.

`executeCommands` only runs explicitly migrated app product rules; unsupported products reject. `writePairs` exposes deliberate raw attribute batches. Generic profile controls keep their retained SyncDo `set*` sequences. This avoids claiming that raw property writes implement every App resolver.

Raw DATA_KEY access is transport/protocol support, not evidence that every product accepts every property. Attribute writes and generic queries are standard TFTC only; YXL has its own wire protocol. Unobserved state is `null`. App product-selection UI, login/game eligibility, character/liner activation, OTA orchestration, Buttplug and phone simulation are not provided by this Bluetooth package.

The current host lacks a per-device disconnect request. The Pocket transport cancels guest-owned notifications and ends local GATT access; host scope disposal remains responsible for native physical release. Direct browser transport invokes physical disconnect.

Security requires caller-supplied secrets or an injected equivalent service. Web Crypto is required by the bundled provider; non-browser guests can inject a security service. No production secret configuration was copied.

## Validation

Run `bun test packages/pocket_tftc/test` from `sdk/`. Tests execute real JS protocol/lifecycle code with explicit test-only BLE IO. The browser probe imports a browser bundle in Playwright Chromium, verifies a security vector through real Web Crypto, clicks a control, checks exact outgoing bytes and observes a notification-driven state change. Pocket integration tests exercise real HostBridge/stream packets. The initial isolated tests used explicit test IO. Physical acceptance was subsequently performed on DK-META2 as recorded below.

Also run `bun build packages/pocket_tftc/src/index.js --target browser` and the `/pocket` entry build, plus `python3 scripts/check_architecture.py`. The pinned compiler/runtime are unchanged.

Initial verification: 68 package tests passed (8 files), including browser execution and client-to-Pocket transport integration. Both browser bundles built successfully, the architecture boundary check passed, and the packed tarball imported successfully from an isolated temporary directory without sibling SDK packages. The optional `/pocket` entry resolves its declared `@pocket/ui` peer through public exports. The final combined regression below supersedes these initial counts.


## Physical Preview acceptance — 2026-11-06

The actual consumer is `demo/js/acceptance/tftc.tsx`, compiled through the pinned `sdk/scripts/build_guest.ts`; `sdk/scripts/tftc_preview.ts` delegates real IO to the existing local Preview provider and native probe. The headed Playwright Chromium browser clicked the rendered guest buttons. No mock runtime or generated success state was used. The live page is `http://127.0.0.1:8797/` while that developer process is running.

Actual DK-META2 advertised CID `0x5FC5`, version 3/subtype B, canonical PID `0x00011401`, FMSK plain mode. Its service inventory exposed FFAC / FFB4 read / FFB5 write / FFB7 write without response / FFB8 read+notify. No secure-device hardware handshake is claimed.

Physical acceptance exposed and fixed necessary gaps:

1. The retained native scan discarded manufacturer advertisement bytes. `PocketBluetoothCore.swift` now passes the existing CoreBluetooth fact through unchanged; the Pocket JS adapter retains it on the device. No product policy entered Swift. `parseManufacturerAdvertisement` strictly normalizes CID+manufacturer bytes into the existing parser. App source `tf_device.dart` already initializes metadata from advertisement, so the client now retains that path.
2. App `manufacturer_specifc_data/sub_type.dart` and `manufacturer_pid_endian_compatibility_test.dart` establish v3+ big-endian numeric wire PID versus v1/v2 historical little-endian compatibility. The parser and regression fixtures now match the App and actual advertisement; arbitrary reversed v3 identifiers remain rejected.
3. Message events previously omitted matched business replies. All valid assembled business notifications now expose `message`; checked attribute packets update one observed map, and the pure `describeAttributeChanges` adds only changed fields. Compact fields expand into semantic changes without a second stored state model. Bad checksums and incomplete fragments cannot change observed facts.
4. Source `tf_device_security.dart` permits a modern discovery timeout/associated unsupported reply to fall back to `0x0A` / `0x0B` when no security requirement is known. That source behavior is now retained, with strict 15-byte parsing, active-query correlation and secure gating. This particular physical firmware replies to neither discovery query. Receiving unsolicited plain status does not bypass identification or authentication.

Observed device-generated FFB8 results:

| Button input | Report during pulse | Report after automatic stop |
| --- | --- | --- |
| Vibration 10, one second | vibrationLevel 10, isWorking true | vibrationLevel 0, isWorking false |
| Linear 10, one second | telescopicLevel 10, isWorking true | telescopicLevel 0, isWorking false |
| Rotation 10, one second | rotationLevel 10, isWorking true | rotationLevel 0, isWorking false |

One actual vibration notification was `[0,1,0,15,11,0,14,0,8,10,32,132,33,3,34,35,255,17,184]`: command 1 upload, vibration key 8 = 10, compact work key 33 = 3. The live UI showed `vibrationLevel: 0 -> 10 -> 0` and `isWorking: false -> true -> false`. A spontaneous battery change `33 -> 32` was also received; these are App 0–50 units, not percentages. Controls were stopped after pulses. Final screenshot was captured locally at `/tmp/tftc-notify-acceptance.png` (an ephemeral acceptance artifact, not SDK source).

Ablation: removed the redundant `queryBattery` / `queryWorkState` methods and buttons at the user's request. Their actual requests timed out despite usable unsolicited notify state. Low-level `queryKeys` remains explicit protocol access, not a claimed supported refresh workflow on this firmware. Preview uses only notify-driven snapshots and changes.

Desktop IO is now reused from `dokidoki/package.json`, `src/ble/client.js`, `build.config.js`, and its locked `@abandonware/noble@1.9.2-26`. Its installed `lib/resolve-bindings.js` confirms macOS CoreBluetooth and Windows >=10.0.15063 WinRT support; native manufacturer, write and notify implementations remain library-owned. `editor/native/noble-bluetooth.mjs` maps the existing Preview JSONL transport only. The custom Windows PowerShell draft was removed, and Preview no longer builds its own Swift BLE helper. Noble remains an external optional desktop dependency, never imported by the public TFTC/browser entry.

After switching to npm transport, the final macOS Preview run using `@abandonware/noble@1.9.2-26` rediscovered DK-META2 and completed the same live control flow. The pinned guest clicked Vibration, Linear, and Rotation 10 for one second; each Noble notify stream reported `0 → 10 → 0`, with `isWorking: false → true → false`, and a spontaneous battery update `32 → 31`. Stop all finished at Vibration/Linear/Rotation `0/0/0` and `working=false`. The Noble screenshot is `/tmp/tftc-noble-notify-acceptance.png` (temporary acceptance output). Windows native execution is still unverified; simulated routing is not claimed as Windows hardware acceptance.

Future Flutter integration uses `flutter_blue_plus` as IO only. The Pocket JS facade accepts its JSON manufacturer Map and the same GATT/stream facts, with a client-to-HostBridge compatibility regression. No Flutter Blue Plus installation, plugin replacement or phone hardware acceptance is claimed in this change. See [TFTC_TRANSPORT_CONTRACT.md](TFTC_TRANSPORT_CONTRACT.md).

Final combined regression: 103 tests passed across the TFTC package, Local Bluetooth/Noble transport, native probe-path and export checks; architecture check passed. The pinned guest build and browser bundle build also passed. The suite includes Noble timeout late-connect cleanup and verifies that its permission request does not fabricate an OS grant. There are no Windows helper tests or custom Windows BLE implementation in the change.
