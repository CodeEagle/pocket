# Pocket platform experience provider

`pocket_platform` is a thin, trusted Flutter plugin for the small amount of
platform UI and URL ingress that a PocketJS guest cannot implement itself. It
does not own a page stack, route pages, or create a second event loop. JS owns
page policy and routing; Dart validates requests, applies Flutter services, and
forwards native platform facts.

The implementation is derived from the retained demo's real paths:

- iOS cold and warm URL forwarding in
  `pocketjs_flutter_demo/ios/Runner/SceneDelegate.swift:4-24` and
  `ios/Runner/AppDelegate.swift:152-195,305-309`;
- Flutter system chrome in
  `lib/core/pocketjs_bundle_runner.dart:322-349`;
- Flutter haptics in `lib/render/pocket_ui_components.dart:779-792`.

The old demo's URL scheme was a custom `pocketapp` scheme. This package does
not claim Universal Links support and does not add a URL scheme to a consuming
application.

## Package and capability contract

```dart
import 'package:pocket_platform/pocket_platform.dart';

final platform = PocketPlatformPlugin(); // foreground UI + haptics only
final links = PocketDeepLinkPlugin(
  deepLinkScheme: 'pocketapp', // trusted consumer opt-in
);
```

The fixed capability names are:

| Capability | Kind | Request/result |
| --- | --- | --- |
| `platform.systemUi.set` | request | Applies a validated `SystemUiOverlayStyle` field set; `{reset:true}` releases the current owner. Result is `{applied:true}` or `{reset:true}`. |
| `platform.haptics.perform` | request | `{type: "selection" \| "light" \| "medium" \| "heavy" \| "vibrate"}`; result is `{performed:true,type}` or `{performed:false,reason:"rate_limited",type}`. |
| `platform.links.initial` | request, opt-in only | Returns `{uri:String?}` for the first accepted URL. |
| `platform.links.latest` | request, opt-in only | Returns `{uri:String?}` for the latest accepted URL. |
| `platform.links.events` | stream, opt-in only | Emits `{uri:String}` through the existing `PocketStreamBridge`. |

System UI fields use Flutter names (`statusBarColor`,
`statusBarIconBrightness`, `statusBarBrightness`,
`systemNavigationBarColor`, `systemNavigationBarIconBrightness`, divider and
contrast fields). Brightness is the enum string `light` or `dark`; colors are
integer ARGB values. No OS permission is needed for either system UI or
haptics. Haptics are enum-only and rate-limited (80ms by default); there is no
polling loop.

`PocketPlatformPlugin` can be registered with the existing
`PocketPluginManager` like any other compiled provider. Its descriptor only
contains system UI and haptics. URL ingress is a separate provider, so a
trusted consumer that needs it registers `PocketDeepLinkPlugin` with exactly
one custom scheme:

```dart
final platform = PocketPlatformPlugin();
final links = PocketDeepLinkPlugin(deepLinkScheme: 'pocketapp');
```

The links provider has its own `flutter.links` descriptor and is
`backgroundSafe`: a foreground-only manager transition revokes the UI/haptic
provider while retaining the native URL handler and links stream. A full
manager disposal still disables native capture and clears the bounded Dart
state. No public mixed provider or runtime links toggle is exposed.

`http`, `https`, `file`, `data`, `javascript`, `content`, and `intent` are
rejected. A scheme must be lowercase ASCII, 1–32 characters, beginning with a
letter. Guest parameters cannot enable links or change the scheme.

## Two opt-in layers for deep links

The trusted consumer's explicit `PocketDeepLinkPlugin` configuration and
static native metadata must agree before a guest can observe links. The
package's native plugin registration is static, but the default path (no
static metadata and no links provider) does not configure a scheme, install an
intent filter, subscribe to URL callbacks, or cache an incoming URL.
Installing the package alone therefore has no link startup side effect.

When the trusted consumer has supplied the static metadata, native may retain
one cold URL before the Dart isolate has activated the provider; this is what
makes `SceneDelegate` cold-start delivery possible. The links descriptor and
JS-visible requests/stream exist only when the trusted consumer registers
`PocketDeepLinkPlugin` with the same scheme. A consumer that removes either
opt-in layer receives no guest link capability.

iOS consumer metadata (only when the consumer chose `--deep-link-scheme`):

```xml
<key>PocketDeepLinksEnabled</key>
<true/>
<key>PocketDeepLinkSchemes</key>
<array>
  <string>pocketapp</string>
</array>
```

The consumer must also add its ordinary `CFBundleURLTypes` entry and forward
SceneDelegate callbacks to the public plugin hook. The package does not edit
those entries:

```swift
import pocket_platform

PocketPlatformPlugin.handleIncomingURL(urlContext.url)
// and in scene(_:openURLContexts:)
```

The package intentionally does not ship a `SceneDelegate` subclass. A
consumer that uses Flutter's default `FlutterSceneDelegate` can call the
static hook from its existing lifecycle patch; an AppDelegate
`application(_:open:options:)` fallback may call the same hook. If the host
uses Flutter's built-in deep-link router, set its consumer flag
`FlutterDeepLinkingEnabled=false` so this provider remains the sole URL
consumer.

An AppDelegate `application(_:open:options:)` fallback may call the same hook
for hosts that do not use scenes. Cold URLs may be cached by the statically
opted-in native hook before Dart activation; they become readable only after
`PocketDeepLinkPlugin` activates with the same scheme. Warm URLs are delivered
after both gates are active.

The SDK CLI applies these consumer patches idempotently only for
`init ... --deep-link-scheme=pocketapp`. `--platform-experience` alone enables
system UI/haptics without URL declarations. An existing custom SceneDelegate
is preserved and requires an explicit consumer forwarding hook; the tool
refuses to overwrite it.

Android consumer metadata:

```xml
<meta-data
    android:name="dev.pocketjs.platform.DEEP_LINKS_ENABLED"
    android:value="true" />
<meta-data
    android:name="dev.pocketjs.platform.DEEP_LINK_SCHEMES"
    android:value="pocketapp" />
```

The consuming application owns its URL `intent-filter`; the package adds no
filter. The plugin observes the standard Flutter Activity `onNewIntent` path
and reads the launch intent after static opt-in, then exposes it after Dart
activation. A host with a custom activity can explicitly forward
`PocketPlatformPlugin.handleIncomingUri(uri)`.

For a host that uses Flutter's built-in deep-link router, set the consumer
flag `flutter_deeplinking_enabled=false` as well. This flag is not read by
the provider; it only prevents a second consumer from racing the explicit
platform hook.

The statically opted-in native side retains only bounded `initial`/`latest`
values and closes its preconfiguration capture window on disable. With no
static metadata it drops URLs. Native and Dart coalesce duplicate callbacks
only within a 250ms monotonic-clock window and keep at most 32 recent entries.
Opening the same URI again later emits another event. Initial/latest snapshot
priming does not emit a stream event. Deactivation, engine detach, and
disposal remove the method-channel handler and clear both native and Dart link
state. A late native callback cannot reach a revoked JS stream. This full
revocation differs from an App's temporary background transition: the
explicit links provider remains background-safe, and the existing controller
queue delivers its facts when the guest resumes.

In a multi-app host, register the links provider once with SystemUI. JS can
then use the existing app manager to choose an application/route; child apps
should not contend for a second native URL owner.

## System UI ownership

`SystemChrome.latestStyle` is captured once at the first active claim. Ordered
owner records retain the currently claimed styles. Removing a non-top owner
does not overwrite the visible style; removing the top restores the newest
remaining owner, or the original host base when none remain. A disposed
owner's style is never restored by a later disposal. Page transitions and
route policy remain in JS.

The links MethodChannel has one owner per Dart process/isolate. A second
links-enabled instance is rejected with `links_owner_busy`; its teardown
cannot disable or replace the current owner's handler. Separate Flutter
engines are not an accepted multi-engine URL-routing configuration.

## Verification

The package was checked with:

```text
flutter analyze   # No issues found
flutter test      # 8 tests passed
```

The tests cover default-off admission, no disabled native calls, explicit
links configuration and deduplication, bounded haptic enum/rate limiting, and
system UI owner recovery, repeated URI opening, competing links owners and
late activation cleanup. Native build and consumer smoke evidence is recorded
in [the integration log](LEGACY_REUSE_IMPLEMENTATION_20261104.md). These Dart
tests alone do not establish device URL delivery or Universal Links support.
