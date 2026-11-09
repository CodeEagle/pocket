# Demo native acceptance baseline

## Source-first review

The retained parent project was reviewed outside `pocket_host/` before touching the probe and Settings acceptance scenarios:

- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/pocketjs_bundle_runner.dart` and `lib/core/ffi_bridge.dart` retain the older native JS bundle/render/event boundary.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/lib/core/perf_monitor.dart`, `lib/main.dart`, and `lib/ui/mini_app_host_page.dart` retain the older global ThemeMode toggle. Theme state and its Flutter rebuild are owned by `PocketPerfMonitor`.
- `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/docs/02_ARCHITECTURE_AND_MEMORY_DESIGN.md` and `docs/04_DEVELOPER_GUIDE_AND_VERIFICATION.md` describe that host architecture. There is no equivalent JS-owned Showcase `updates.status` screen or modal-driven Settings flow outside the excluded directory.

The current Demo keeps both policies in JS. `demo/js/system.ts` creates the update client with automatic health refresh; `demo/js/app.tsx` separately requests status for the visible capability card; `demo/js/settings.tsx` owns the Settings interaction and persisted appearance. `sdk/packages/pocket_ui/src/mobile.tsx` supplies the existing dialog behavior. These consumers have distinct lifecycles, so this repair does not merge their application state or add host state.

## Native `updates.status` failure

The original fresh validation log, `/tmp/pocket-host-guest-validation-fresh.log`, failed because no rendered frame contained `configured=false`.

An actual first frame from the pinned QuickJS bytecode and native `pocket_probe` showed two `updates.status` requests: `guest-1` from the update client's initial auto-refresh and `guest-7` from the Showcase status view. The test selected the first ID with `bootRequestId("updates.status")`, so its genuine `configured=false` result reached the update client while the page's separately correlated request remained pending.

`demo/js/tests/native_guest_probe.ts` now collects both request IDs from the executed guest frame, asserts that both are present and unique, and responds to each with the same host fixture. The exact rendered `configured=false`, stage, active version, and error-state assertions remain. Its initial capability multiset assertion records two status requests; it does not collapse them into one synthetic call.

## Settings reset timing failure

The native Settings test clicked `Reset`, waited 12 frames (192 ms), then began a scroll gesture while the confirmation dialog was still mounted. The existing exit animation in `sdk/packages/pocket_ui/src/motion.ts` is 220 ms. A native trace confirmed that Reset changed the JS theme state, but the gesture started during the remaining modal frames and did not reach the underlying `ScrollablePage`; the saved scroll offset therefore kept the `Light` control outside the painted viewport.

`demo/js/tests/settings_native.test.ts` now waits for the real dialog title to disappear, with a bounded frame limit, before scrolling back to the theme control. The test still checks the reset root color, `Light` control, persisted defaults, and all subsequent native interactions. Product UI, motion duration, and state ownership are unchanged.

## Validation

- `POCKET_NATIVE_PROBE=../../sdk/native/target/debug/pocket_probe bun tests/native_guest_probe.ts --required` passed; the probe reported 509 ops at 100 nodes and 1409 ops at 500 nodes.
- `POCKET_NATIVE_PROBE=../../sdk/native/target/debug/pocket_probe bun tests/settings_native.test.ts` passed with the reset theme, palette, density, dialog, route, and storage assertions.
- `bash scripts/test_guest.sh` from `demo/js` passed end to end: reducer, hardware, video (4 pass), pinned `build_guest`, bytecode ablation, native guest probe, native Settings, and navigation (2 pass, 0 fail).
- The full script's output changed `demo/assets/app.bytecode.json` and `app.qjbc`; both were restored byte-for-byte to the pre-run snapshot. Parallel `demo/assets/apps/official/` outputs were not touched.

No product, Dart, native runtime, or resource behavior was changed in this acceptance repair.
