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

`getAppUpdateStatus(appId, { checkLatest: true })` performs a signed metadata check. `prepareAppUpdate(appId)` downloads, verifies, and stages one selected package. A staged package is not shown as active: the existing `platform.apps.open` path and first-frame health check perform activation. The package page does not change or disable Lantern's existing automatic update-on-open behavior.

## Regression coverage

The Demo Guest input regression drives the Home package-management entry and the per-app controls. It checks that all 33 installed packages are read locally without remote checks on mount, that single-app checks work, and that “Check all updates” stays within three concurrent requests. It also checks same-version/higher-build updates, per-app failure isolation, an unconfigured package alongside configured packages, the staged-versus-active labels, Lantern's automatic update notice, and the secondary-route back transition. The Demo's existing system-configuration test also checks that app titles from `pocket.json` are available in the SystemUI catalog.
