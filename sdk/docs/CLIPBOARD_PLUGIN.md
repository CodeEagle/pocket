# Clipboard plugin (`pocket_clipboard`)

Optional, general-purpose, text-only system clipboard capability. It is not tied
to any one product. `pocket_sdk` does not depend on it; a consumer opts in by
adding a path dependency on `sdk/packages/pocket_clipboard` and registering the
plugin. It uses Flutter's `Clipboard` (`package:flutter/services.dart`) and adds
no third-party dependency. `scripts/check_architecture.py` lists
`pocket_clipboard` among the optional packages the core SDK must not depend on.

## Capabilities

Plugin id `flutter.clipboard`; all are `request` capabilities.

| Capability | Params | Result | Permission |
| --- | --- | --- | --- |
| `clipboard.readText` | `{}` | `{ text: string \| null }` (`null` when no text) | `clipboard.read` |
| `clipboard.hasText` | `{}` | `{ hasText: boolean }` | `clipboard.read` |
| `clipboard.writeText` | `{ text: string }` | `{ ok: true }` | `clipboard.write` |

Descriptors carry JSON schemas, so `bun pocket.ts types` / `scripts/plugin_types.ts`
generate typed clients as for any other plugin. `hasText` needs the read
permission because clipboard presence is itself observable data.

## Limits

- Text payloads are at most 192 KiB of UTF-8 (`pocketClipboardMaxTextBytes`),
  which leaves room for JSON escaping under the 256 KiB control message. A host
  may lower it with `PocketClipboardPlugin(maxTextBytes: ...)` but not raise it.
- `writeText` with a larger string fails with `too_large`; the clipboard is left
  unchanged. A non-string `text` fails with `invalid_params`.
- `readText` never truncates: if the clipboard text exceeds the limit (or its
  JSON-escaped form exceeds 240 KiB) it fails with `too_large`.
- At most four concurrent requests (descriptor limit). No images, files, HTML or
  rich content, and no clipboard-change stream.

## Permission layers

Reading the clipboard is sensitive, so three independent layers must all allow it:

1. Host scope: the trusted Flutter host lists the permission in
   `PocketAppConfig.allowedPermissions` (`clipboard.read`, `clipboard.write`).
   Grant only what the app needs; write-only apps should not get `clipboard.read`.
2. Guest manifest: the guest declares the capability under `capabilities` and the
   permission under `permissions`. An undeclared capability is never granted; a
   declared capability whose permission was not declared is revoked at admission
   (`permission_not_declared` if required). Child guests do not inherit a parent's
   grant; each guest's own manifest is negotiated against the host scope.
3. Operating system: iOS 14+ may show a paste notice and Android 12+ a toast on
   read; Android 10+ only lets the foreground app read. The OS may return no text
   (reads then resolve `null`). The plugin neither requests nor bypasses these.

Calls without the grant fail with `capability_denied` / `plugin_permission_denied`
before the platform clipboard is touched.

## Host registration

```dart
import 'package:pocket_clipboard/pocket_clipboard.dart';
import 'package:pocket_sdk/pocket_sdk.dart';

PocketPlugin createClipboardPlugin(PocketViewController controller) =>
    PocketClipboardPlugin();

final config = PocketAppConfig(
  appId: 'dev.example.app',
  allowedPermissions: {'clipboard.read', 'clipboard.write'},
  pluginFactories: [createClipboardPlugin],
);
```

Guest `manifest.json`:

```json
{
  "protocolVersion": 1,
  "capabilities": { "requires": [], "optional": ["clipboard.readText", "clipboard.writeText"] },
  "permissions": { "optional": ["clipboard.read", "clipboard.write"] }
}
```

## JS usage

```ts
import { createHostBridge } from '@pocket/ui/host';
import { readClipboardText, writeClipboardText } from '@pocket/ui/clipboard';

const host = createHostBridge();
await writeClipboardText(host, 'copied');
const text = await readClipboardText(host); // string | null
```

`createPocketClipboardClient(host)` also exposes `hasText()`. The module reuses
`HostBridge.request` (same correlation as `dio.ts`); errors reject with the host
error codes above. Read from an explicit user action. The Editor preview does not
fake a clipboard: an unregistered plugin is `capability_unavailable`.

## Source-first note

The retained parent `pocketjs_flutter_demo` is not available in this
environment. The package is modelled on existing SDK plugins:
`pocket_dio` (descriptor, schemas, limits, `registerRequest`, `ui/src/dio.ts`
client, per-capability error codes) and `pocket_permissions` (per-capability
`permissions`, host `allowedPermissions` plus guest-manifest negotiation through
`PocketPluginManager`). No new state machine or Dart-side policy was added.

## Validation

- `flutter test` in `packages/pocket_clipboard`: mocked `SystemChannels.platform`
  clipboard through `PocketPluginManager` admission: round trip, null clipboard,
  host scope without read, undeclared capability/permission, undeclared name,
  oversized write/read, multi-byte limit, invalid params.
- `bun test packages/pocket_ui/test/clipboard.test.ts`: request correlation and
  error mapping.
- `packages/pocket_ui/test/clipboard_native.test.ts` (modelled on
  `dio_native.test.ts`) drives a compiled guest through `pocket_probe`; it needs
  the prebuilt `@pocket/tools-*` guest toolchain.
- `python3 scripts/check_architecture.py`.

Not covered: real iOS/Android clipboard behaviour on device; `pocket init
--clipboard` scaffolding (add the path dependency and factory by hand).
