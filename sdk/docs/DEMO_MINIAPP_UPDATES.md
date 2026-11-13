# Demo MiniApp Package Updates

The Demo exposes installed child-app versions from its SystemUI package page in JavaScript. The page reads the current `PocketSystemKernel` catalog for installed app IDs and titles, then asks the existing platform client for local package facts. It does not create a second update client or persist a second copy of version state.

## Retained source and adaptation

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected with `pocket_host/` excluded:

- `mini_apps/syslib/pocket_syslib_pages.js` contains the old YooAsset/AOT version console with version, compatibility, hot-update, and rollback information.
- `mini_apps/syslib/pocket_syslib_ota.js` and `lib/core/pocketjs_bundle_runner.dart` implement or simulate updates for the JavaScript system-library bundle. They do not manage installed child MiniApp packages.
- `tests/verify_architecture.py` verifies the syslib SemVer gate, AOT module update, and rollback. It does not cover a per-MiniApp package list or update action.

The new page retains the useful version/status presentation but uses the current SystemUI catalog and the SDK platform update APIs. The per-app status response is the source of installed, active, latest, and staged version/build values. Host-supplied signed update configuration is required for latest versions; an unconfigured host is reported as such instead of displaying invented update data.

## Activation behavior

On page entry the Demo reads local package status with `getAppUpdateStatus(appId)` and renders each row as its response arrives. It does not scan signed update sources for all 33 installed MiniApps during mount. “Check all updates” requests latest metadata for configured packages with at most three requests in flight; “Check latest” provides the same operation for one row. Missing latest facts are shown as “Not checked”.

`getAppUpdateStatus(appId, { checkLatest: true })` performs a signed metadata check. `prepareAppUpdate(appId)` downloads, verifies, and stages one selected package. A staged package is not shown as active: the existing `platform.apps.open` path and first-frame health check perform activation. Every normal open now uses one preparation gate: it joins a pending signed check or starts a fresh one, then mounts a verified staged package before presenting the child. This also applies to resident instances and same-version releases with a higher build number. A failed network check retains the healthy cache. The package page uses the same coordinator and does not add a second activation path.

## Regression coverage

The Demo Guest input regression drives the Home package-management entry and the per-app controls. It checks that all 33 installed packages are read locally without remote checks on mount, that single-app checks work, and that “Check all updates” stays within three concurrent requests. It also checks same-version/higher-build updates, per-app failure isolation, an unconfigured package alongside configured packages, the staged-versus-active labels, Lantern's automatic update notice, and the secondary-route back transition. The Demo's existing system-configuration test also checks that app titles from `pocket.json` are available in the SystemUI catalog.

The real Flutter/native FFI regression additionally drives signed metadata inspection and package preparation through the SystemUI Guest. It verifies that inspection fetches no blobs, preparation stages build 2 while build 1 stays active, and the next open activates build 2. The resident-instance regression separately verifies changed frame output and input-driven frame changes after a same-version build update.

## Cancellation on platform request timeout

The retained parent update sources above cover the older syslib/AOT update path, not native cancellation of a MiniApp package request. SystemUI now forwards the originating `platformRequestId` for update status and prepare calls. The Flutter boundary associates a cancellation token only with that still-pending request after checking its capability, target app and SystemUI generation; timeout, response completion and owner invalidation cancel that token, which reaches the existing update coordinator and HTTP body stream. A legacy SystemUI guest without the ID keeps its previous request lifetime for compatibility; rebuild and republish SystemUI bytecode to enable timeout-bound cancellation. The resident `prepareOpen` operation is not covered by this request-ID change.

The FFI regression runs a real SystemUI QJBC and healthy resident child against a real slow HTTP response. It advances response chunks every 100ms, confirms the 8-second native request timeout in wall time, then verifies the same session leaves its update-error state and `inspectUpdate(checkLatest: false)` succeeds with build 1 still active and no staged package. A local ablation that omitted `platformRequestId` reproduced the stuck `checking` state and failed that assertion. The timeout duration is exposed only as a `@visibleForTesting` host parameter; the test otherwise uses the production cancellation token, transport and coordinator.

## Open deadline and cleanup

The existing HostBridge tick clock provides one 180-second frame budget starting when an open request enters the serial queue. Runtime creation, preparation, first-frame admission and the open transaction's lifecycle transports use the smaller of their existing request limit and the remaining budget. The outer platform request keeps its 210-second limit to allow failure cleanup. This does not introduce a parallel updater or another wall-clock timer in the normal bridge path.

A newly created child is destroyed if preparation fails or the budget expires before presentation. A resident child remains reusable and its temporary presentation override is restored. Queue-promise finalization releases the tick subscription even when kernel disposal skips admission. Kernel regressions drive clock ticks to cover cold, resident, queued and disposed requests without waiting three minutes.
