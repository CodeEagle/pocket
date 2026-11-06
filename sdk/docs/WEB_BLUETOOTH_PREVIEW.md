# Web SDK Bluetooth: Noble only

The Pocket Web SDK and Editor do **not** use the browser Web Bluetooth API.
`navigator.bluetooth`, browser device choosers and browser GATT objects are
intentionally unsupported. This keeps one real Bluetooth boundary and avoids
maintaining a second permission, device-identity and notification state
machine in the browser.

The Editor preview routes `hardware.bluetooth.*` and
`hardware.bluetooth.notifications` to the local
[`noble-bluetooth.mjs`](../editor/native/noble-bluetooth.mjs) helper. The helper
loads `@abandonware/noble` from the consuming host; the SDK does not bundle
Noble or install it for the application.

```sh
npm install @abandonware/noble@1.9.2-26
# or: bun add @abandonware/noble@1.9.2-26
```

Run the Editor on macOS or Windows, enable **Noble Bluetooth** in Preview, and
use the normal JS TFTC/host capability calls. The OS owns Bluetooth permission
at the real scan/GATT boundary. A permission request is therefore reported as
unsupported when Noble has no explicit permission API; the host must not
fabricate a `granted` result.

For the capability contract, scope lifecycle, notification rules and physical
acceptance limits, see [Local Bluetooth preview](LOCAL_BLUETOOTH_PREVIEW.md)
and [TFTC transport contract](TFTC_TRANSPORT_CONTRACT.md).

The browser Canvas projection remains a rendering/input surface only. It never
contains a Bluetooth implementation, and pages without a local Noble host
receive an explicit `hardware_unsupported`/`unsupported_capability` error.
