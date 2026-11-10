# Actual Release LAN HTTP acceptance

`release_lan_http_probe.dart` is an opt-in macOS executable, not a `flutter test` test. It requires `kReleaseMode == true`; the Debug test runner cannot exercise the removed Release gates. Run it against an Editor-published fixed host package index using the legacy public-key update configuration. The index, immutable descriptors and signed artifacts must be reachable on the explicitly selected LAN HTTP host.

Use a temporary Flutter macOS project with path dependencies on this checkout's `sdk`, `sdk/packages/pocket_services`, and `sdk/packages/pocket_archive`, and copy the fixture into its `lib/main.dart`. Do not copy generated projects or binaries into source control. The SDK native toolchain must already be bootstrapped as for a normal consumer.

On Apple Silicon, the acceptance run used Flutter 3.35.7, macOS deployment target 12.0, and the following commands from the temporary project (substitute the real checkout path and LAN URL):

```sh
cp /path/to/pocket/sdk/scripts/fixtures/release_lan_http_probe.dart lib/main.dart
flutter pub get
flutter build macos --release --config-only
(cd macos && pod install)
xcodebuild -workspace macos/Runner.xcworkspace -scheme Runner \
  -configuration Release -derivedDataPath build/macos \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES MACOSX_DEPLOYMENT_TARGET=12.0
POCKET_LAN_HTTP_URL=http://192.168.50.230:8791/test/pocket/editor/pocket.host.demo/latest.json \
POCKET_RELEASE_PROBE_RESULT=/tmp/pocket-release-http-result.json \
  build/macos/Build/Products/Release/pocket_archive_probe.app/Contents/MacOS/pocket_archive_probe
```

The sample binary name assumes the temporary project is named `pocket_archive_probe`. Set that project's Podfile deployment target to 12.0 before installing pods. The temporary probe needs network and filesystem access: the observed run disabled its generated app sandbox entitlement, only in that disposable project. Do not change a consumer app's production entitlements for this probe. Explicit `ARCHS=arm64` avoids Flutter 3.35.7's universal-framework architecture comparison issue on this machine.

Success exits zero and emits JSON confirming:

- actual Release mode and rejection of the same HTTP bootstrap without permission;
- approved bootstrap loading and root/child update permission propagation;
- default `PocketSystemHost.fromHostConfig` catalog reload retaining the permission;
- signed package preparation and the Release Session transport reaching bridge negotiation.

The fixture permits the known `permission_not_declared` error at bridge negotiation because the disposable host does not attach the Showcase hardware policy. It records this as `bridgeLimitation`, never as game or UI acceptance. Any other error fails the run. Device end-to-end testing is separate. Session package data lives in the temporary app's application-support directory; remove that disposable app data after testing.
