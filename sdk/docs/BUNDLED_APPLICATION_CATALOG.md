# Bundled application catalog

## Source-first findings

The retained parent Flutter project keeps its multi-tab guest viewport in
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart`
and its app identities in
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart`.
Those files provide the behavior retained here: stable app identities, multiple
resident guests, explicit child opening, and a separate FPS overlay. They do
not provide a reusable Flutter asset catalog or signed package admission model.
The current Pocket implementation already has those separate runtime
boundaries in `PocketSystemHost`, `PocketHostConfig`, and
`PocketSystemHostCatalog`; this change leaves their contracts separate.

Before this change, `demo/lib/official_demo_catalog.dart` parsed one Showcase
catalog. It also duplicated the generator's launchability policy, assigned
handles, resolved four asset paths per app, retained two worker artifact paths
already represented by the worker descriptor, and granted one demo's HTTP
origin by ID. The demo also kept separate asset paths for `profile`, `lobby`,
and `lantern` in `main.dart` even though their package manifests are already
listed in `demo/js/pocket.system.json`.

## Reusable boundary

`PocketBundledApplicationCatalog` in
`sdk/lib/src/pocket_bundled_application_catalog.dart` now reads a versioned,
embedded `applications` array. Its asset prefix, reserved IDs, and dynamic
compositor range are supplied by the consumer. Fixed handles are plain catalog
data and are validated against the dynamic range. Dynamic handles are allocated
in catalog order, including nonlaunchable entries, so compatibility changes do
not shift later apps. The parser resolves bytecode, PAK, metadata, manifest,
and worker bytecode paths once; it rejects traversal, duplicate IDs, unsafe
paths, invalid handles, and malformed launchability values.

The catalog's `launchable` value is an explicit boolean generated from
`sdk/scripts/official_demos.ts` host capability facts. Pointer fallback remains
a presentation/input adaptation; it does not grant `input.buttons` to a native
guest. `demo/js/scripts/build_mini_apps.ts` carries that fact into the compact
asset catalog, and `demo/js/official_demos.ts` consumes it directly instead of
repeating the status/enum decision. The same build output now includes compiled
local apps by reading their manifest directories from `pocket.system.json`, so
the Flutter host no longer repeats their four asset paths.

The SDK parser never grants a capability. Worker descriptors expose only the
validated relative bytecode path and whether an HTTP node is declared. A host
may attach native policy only to a launchable matching app, and a worker HTTP
origin is rejected unless the descriptor declares an HTTP node. The Showcase
keeps `https://example.com`, Lantern's audio plugin, and app memory budgets in
its own host policy map. No Showcase IDs, asset paths, or origins are embedded
in SDK code.

`PocketSystemHostApplication` is the reusable application shell added beside
`PocketSystemHost`. It owns asynchronous bootstrap, the error surface, and the
choice between local embedded apps and a verified remote host config. It takes
consumer catalog/config builders and a wrapper builder; the Showcase injects
`FlutterFrameMonitor` there. It owns no app registry or capability policy.

## Ablation and validation

The migration removes the second launchability decision, the second JS handle
calculation, the duplicate `packageId` field, and the separate worker QJBC and
metadata path fields. Asset identity for official and local child apps now
comes from one compiled catalog. `PocketHostConfig` remains responsible for
signed remote package configuration, while `PocketSystemHostCatalog` remains
bound to a verified root payload generation; neither is reused for embedded
assets.

Validation covers malformed catalogs and paths, stable/fixed handles, explicit
worker grants, staged root-bundle files, generated JS launchability, and the
existing multi-app integration scenarios. The integration test retains its
actual guest open/input, A/B identity, lifecycle, prewarm reuse, return/result,
message, failure cleanup, and official Hero pointer interaction assertions.
The added `bundled shell composes host policy and reuses catalog bootstrap on
rebuild` widget test pumps the public `PocketSystemHostApplication.fromBundledAssets`
factory twice and verifies its catalog asset loads only once.

The catalog/admission Flutter tests passed 6/6, Demo analysis passed, and the
architecture guard passed with `demo/lib/main.dart` at 97 lines. A first macOS
integration attempt with `POCKET_NATIVE_LIBRARY` pointing outside the app
bundle failed before guest startup because the Runner sandbox denied `dlopen`;
that result does not exercise or implicate the catalog. A subsequent
static-linked run reached real guests but did not complete the multi-app
integration: its first case failed the hidden-view ticker assertion, and the
prewarm case later failed to reopen the scrolled lobby card. The interaction
helper was adjusted to scroll back toward the button, but that partial run is
not a pass. The app catalog and bootstrap behavior are covered by the passing
focused tests; full multi-app platform integration remains unverified.
