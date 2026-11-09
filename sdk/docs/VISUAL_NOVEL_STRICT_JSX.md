# Strict JSX Typecheck for Visual Novel Views

The visual novel view and its supporting UI files now pass the dedicated strict TypeScript project with no diagnostics. The check caught type mismatches at existing component boundaries; it did not replace runtime or guest validation.

## Source review

The retained parent demo was reviewed outside `pocket_host/`. Relevant source paths are:

- `mini_apps/syslib/pocket_syslib_flutter_ui.js` for the retained JS UI vocabulary and widget-facing behavior.
- `lib/render/pocket_ui_components.dart` for retained Flutter-side component/render behavior.
- `lib/core/ffi_bridge.dart` for the retained native bridge boundary.

The parent keeps its UI in a JS-to-Flutter widget vocabulary and does not contain the current Solid `createMemo` generic, `NodeMirror` ref union, or the VN `Video` component typing that produced these diagnostics. Its retained scrolling, focus, text-input and video behaviors remain the behavioral references; the fixes below adapt the current SDK types without creating another renderer or changing those behaviors.

## Diagnostic fixes

The strict project reported 17 diagnostics before the patch and zero afterward. The fixes are limited to expressing the values already accepted by the runtime APIs:

- Glass, platform-texture and video payload memos now declare `createMemo<BridgeObject, undefined>`, matching the memo's undefined initial value.
- Glass and navigation refs now handle both supported ref forms: callback refs and `{ current }` object refs. Navigation reuses the existing `assignViewRef` helper rather than adding another ref utility.
- Scroll-contour measurements accept the `number | string` values exposed by `StyleObject`. Existing runtime checks still use explicit numbers only; strings retain their existing class-derived fallback behavior and are not parsed or coerced.
- Input-field visual geometry now guards the optional retained node before asking the active page scroller for its visual rectangle, then preserves the committed-layout and last-rectangle fallbacks.
- The title-screen `Show` renders its replay entries as ordinary JSX children with `For`. It no longer passes a function child to a boolean `Show` condition.

These changes repair the type contract at the call sites. They do not add a second layout, rendering or ref state system.

## Validation evidence

The strict check is:

```sh
cd sdk
node_modules/typescript/bin/tsc --noEmit --project .pocket-build/tsconfig-vn-view.json
```

It exited 0 with no diagnostics after the shared patch was applied.

Root also reported 9/9 isolated Lantern native regressions on the current guest. That broad story-route result complements these component tests but does not cover every UI ref form listed below.

Targeted JS checks used the pinned Bun 1.4.4 binary:

- `packages/pocket_ui/test/glass_surface.test.ts`: 1 test passed, including registration lifecycle and cleanup.
- `packages/pocket_ui/test/video.test.ts`: 1 test passed, including native surface registration/configuration and cleanup.
- `packages/pocket_ui/test/media.test.ts` run by itself: 16 tests passed, including snapshot correlation, seek bounds, lifecycle and platform listener behavior.
- `packages/pocket_ui/test/flutter_widgets.test.ts` exited 0 and ran its standalone checks for viewport measurement, input visual-rect fallback, focus preservation, IME ordering and observer cleanup. Bun reports zero registered tests for this script-style file.
- `packages/pocket_ui/test/semantics.test.ts`: 1 test passed.

A combined invocation of these files reported 16 pass / 3 fail because the platform cases in `media.test.ts` imported `@pocketjs/framework/clock` after other files' module mocks had replaced it without the `after` export. Running `media.test.ts` alone passed all 16 cases. This is test-module isolation behavior; production clock code was not changed to bypass it.

The guest-backed `packages/pocket_ui/test/safe_area_native.test.ts` was also run alone with the high-resolution native probe. It built and launched its fixture but stopped at the assertion that `MobileAppBar` has no 56px background rectangle: the actual frame contains a white 390×56 rectangle. I did not run the same fixture against the unpatched baseline, so this failure's relationship to the strict patch is unverified. A temporary diagnostic copy skipped only that assertion and passed the remaining 390px/320px cases, including the real guest `ScrollContourItem` callback/object-ref identity and press check (`RefPressed`). The diagnostic copy was removed; this is narrower evidence than the original suite passing.

## Remaining behavior verification

The strict compile verifies assignability, not guest behavior. A successful guest regression should still exercise GlassSurface object refs, NavigationBar track refs, ScrollContourItem callback/object refs, video surface registration and input-field visual geometry through the current pinned guest pipeline. The safe-area failure above must be reconciled with the current app-bar contract before its object-ref assertion can serve as that evidence.

## Footer text pixel investigation

A visual report that the `已读跳过` footer appeared clipped was checked against the actual rendered pixels before considering a layout or painter change. The strict-parallax Flutter captures were `layers-visible.png`, `camera-zoom.png`, and `layers-cleared.png` under the user's app-support `tmp/pocket-lantern-parallax-v1pObP/` directory. Their target `PocketTextOp` was identical in all three captures: text `已读跳过`, rect `[324,812,48,15]`, clip `[0,0,390,844]`, size 12, font slot 0, alignment 0, and color `0xfff5ecd9`. The painter and Flutter surface were both 390×844 logical pixels at scale 1.

The first diagnostic test rendered that exact op through `PocketCanvasPainter` at DPR 2 using the real LanternSerif font. Fresh, shared-cache, interleaved-text, and post-eviction pixels matched; all four 12-logical-pixel glyph cells contained nontransparent pixels. It passed with:

```sh
cd sdk/packages/pocket_flutter
/Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter test test/pocket_text_cache_pixel_test.dart
```

The test source was moved to the ignored cache at `sdk/.pocket-build/lantern-v4-strict-jsx-20261108/pocket_text_cache_pixel_test.dart` after the run. A separate screenshot pixel analysis checked physical ROI `[648,1624,744,1654]`: each capture had four glyph-cell ink counts `[102,156,189,135]`, with a zero-difference glyph mask against the baseline. A second raw top-down RGBA decoder independently found ink in all four cells (`[94,144,172,130]`). The thumbnail appearance was misleading; the target glyphs were complete and unchanged. This did not reproduce a text-cache or production rendering bug, so no SDK rendering change was warranted.
