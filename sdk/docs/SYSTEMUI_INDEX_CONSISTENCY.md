# Package index SystemUI identity

## Source and retained behavior

The retained parent `pocketjs_flutter_demo/lib/ui/mini_app_host_page.dart` hosts the JS-selected SystemUI; it has no editor package index implementation. The reusable implementation remains `sdk/editor/server.ts`, with Flutter's existing identity and payload checks in `sdk/lib/src/pocket_host_config.dart` unchanged.

## Reproduction and correction

The live `/test/pocket/editor/pocket.host.demo/latest.json` index returned `pocket.app.game2` as SystemUI while its selected host descriptor returned `pocket.host.demo`. The pre-journal scan read a shared update directory under an unrelated project's config. That scan now requires ownership through the configured root or published package list. Both index paths derive SystemUI from the selected descriptor, rather than a mutable project config or the first journal package.

Journal root routing also identifies the package by the already-recorded root signed-payload digest. Missing artifacts do not justify guessing the first package. Mini-app templates intentionally have no SystemUI field; their index retains the parent established by the owning release. No new persistent identity state or Flutter fallback was added.

`aggregateHostConfig` in `sdk/editor/server.ts` is the sole boundary emitting aggregate host descriptors for both published journal entries and `readLegacyAggregate`. It now filters `compositorSurfaces` to retain only child package IDs actually present in `input.packages` (excluding `rootAppId`) while preserving their existing surface handle integers without renumbering. This prevents newer build-snapshot surface declarations (such as unpublished catalog entries like `pocket.demo.lantern`) from leaking into a legacy aggregate descriptor and failing `PocketSystemHost` trust checks.

## Validation

- The final combined editor/toolchain suite passed 13/13 tests with 313 assertions. Editor cases cover reordered journal packages with an unavailable child, unrelated project before a legacy owner, descriptor agreement, mini-app index compatibility, unpublished surfaces, empty child registries, compatibility branches, restart and host-version aliases.
- Actual LAN HTTP requests now return project `pocket-host-showcase` and SystemUI `pocket.host.demo`, matching the selected descriptor.
- A real Flutter 3.35.7 `PocketHostConfig.load` probe against that LAN URL reproduced the exact FormatException before the fix and passed after the service loaded the fix. The final probe also checks that every compositor registry key is a trusted child and that profile=2 / lobby=3 are preserved.
- Refreshing the stale precompiled tool installation also repaired default builds that could not resolve `@pocketjs/framework/inline-fonts`. See `BUILD_TOOLCHAIN_INLINE_FONTS.md` for the installation repair.

Evidence is under `.pocket-build/systemui-index-20261109/`. The running local server has loaded this change; no game republish or App rebuild is required for this index correction.
