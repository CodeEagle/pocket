# Release LAN HTTP Policy Ablation

## Source and Retained Behavior

Inspected the retained parent repository (excluding `pocket_host/`):

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/ffi_bridge.dart`
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/real_hardware_bridge.dart`
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart`

The retained parent `lib/core` contains no HTTP host bootstrap or signed update transport policy implementation. In the current SDK, `PocketUpdateCoordinator` (`sdk/packages/pocket_services/lib/src/pocket_update.dart`) is a pure Dart coordinator without any Flutter `kDebugMode` build-mode dependency: it accepts an explicit `debugHttpHosts` allowlist and validates manifest and trust-policy URLs against HTTPS, loopback, or exact lowercased hosts in `debugHttpHosts`.

## Root Cause and Necessary Changes

Previously, three paths blocked explicitly allowed LAN HTTP endpoints in Release test packages:

1. `PocketHostConfig._allowHttp` (`sdk/lib/src/pocket_host_config.dart:1251`) gated explicit `allowInsecureHttpHosts` entries behind `kDebugMode`.
2. `PocketSession._initialize` (`sdk/lib/src/pocket_session.dart:337`) discarded `updateConfig.debugHttpHosts` when `kDebugMode` was false, passing `const <String>[]` to `PocketUpdateCoordinator`.
3. `PocketSystemHost.fromHostConfig` (`sdk/lib/src/pocket_system_host.dart:749`) invoked `PocketHostConfig.load(config.source, requiredRootPayloadSha256: rootPayloadSha256)` in its default catalog reload closure without forwarding the host-approved HTTP allowlist (`config.systemUI.updates?.debugHttpHosts`).

Minimal ablation applied without adding a second state machine, switch, or API parameter:

- `sdk/lib/src/pocket_host_config.dart`:
  - `_allowHttp(Uri uri, Set<String> allowed)` now permits `http` when `allowed.contains(uri.host)` in all build modes, while keeping automatic loopback (`127.0.0.1`, `localhost`, `::1`) and `PocketHostConfig.load`'s automatic source-host admission restricted to `kDebugMode`.
  - Updated the bootstrap scheme error message to state that HTTPS or an explicitly allowed HTTP host is required (removing the misleading debug-only phrasing).
- `sdk/lib/src/pocket_session.dart`:
  - `PocketSession` always forwards `...updateConfig.debugHttpHosts` to `PocketUpdateCoordinator`, and appends the built-in simulator/loopback defaults (`127.0.0.1`, `localhost`, `10.0.2.2`) only when `kDebugMode` is true.
- `sdk/lib/src/pocket_system_host.dart`:
  - `PocketSystemHost.fromHostConfig` captures `Set<String>.unmodifiable(config.systemUI.updates?.debugHttpHosts ?? const <String>[])` from the initial host-approved `config` and supplies it as `allowInsecureHttpHosts` to the default `PocketHostConfig.load` reload call, without trusting newly downloaded descriptors to expand HTTP permissions.

## Preserved Security Boundaries

- Unapproved LAN/public HTTP hosts remain rejected by default. Existing coordinator loopback exceptions are unchanged; bootstrap automatic source/loopback admission remains Debug-only.
- Remote descriptors cannot self-authorize new HTTP hosts: `_approvedDebugHosts` intersects remote `updates.debugHttpHosts` with the caller-supplied `allowInsecureHttpHosts`, and default catalog reloads reuse only the initial host-approved `config.systemUI.updates?.debugHttpHosts`.
- Descriptor and bootstrap asset URLs remain bound to the same origin (`scheme`, `host`, `port`) and must pass `_allowHttp`.
- Ed25519 manifest signature verification, SHA-256 content hashes, build anti-downgrade floors, and trust anchor pinning are unchanged.

## Validation

- Added `sdk/test/release_lan_http_test.dart` covering:
  - Default rejection of unapproved HTTP in `PocketHostConfig.fromJson`.
  - Explicit LAN host approval and propagation of `debugHttpHosts` to both `systemUI.updates` and child `applications[*].updates`, while stripping unapproved hosts declared by the remote descriptor.
  - `PocketHostConfig.load` admission of an explicitly approved LAN HTTP host and rejection of unapproved descriptor or bootstrap asset hosts.
  - `PocketSystemHost.fromHostConfig` default `catalogLoader` reloading a changed root payload hash over the approved LAN HTTP host, rejecting remote descriptor host escalation on reload, and preserving custom `reloadHostConfig` behavior.
  - `PocketSession` forwarding of configured `debugHttpHosts` to `PocketUpdateCoordinator` for root and child packages, and rejection of unapproved LAN HTTP hosts.
- Actual macOS Release probe verified: unapproved LAN HTTP rejection, explicit LAN HTTP approval, root + 2 child `debugHttpHosts` permission propagation, and signed package `prepare` admission all passed in real Flutter macOS Release execution.
- Formatted modified Dart files to 80 columns (`dart format --line-length 80`).
- Main regression run (Flutter 3.35.7): 56 tests passed across `release_lan_http_test.dart`, `pocket_host_config_test.dart`, and `session_download_on_open_test.dart`; the native input case was initially skipped, then separately passed using the existing pinned native library and `download-progress-20261109/on-demand-fixture` (1/1).
- Release Session probe reached bridge capability negotiation after remote preparation, proving the Session transport retained the explicit allowlist. The scratch host does not provide the Showcase hardware permission declarations; its `permission_not_declared` bridge limitation is not a game/UI acceptance result. iPhone end-to-end behavior remains to be verified after rebuilding the consuming app.
- Reproducible actual-Release acceptance source is retained at `sdk/scripts/fixtures/release_lan_http_probe.dart`, with setup/run instructions in the adjacent Markdown file. This deliberately exercises compiled Release code instead of adding test-only build-mode switches to public SDK APIs.
- Host allowlists now normalize DNS hostname casing at the existing bootstrap/parser boundaries, matching `Uri.host` and updater semantics; remote declarations still intersect the caller-approved set. Final host/config/catalog regressions: 25/25 passed after the reload and casing fixes.
