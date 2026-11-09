# Visual novel feature tour

## Source-first findings

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` has no visual-novel story, narrative replay, or `NovelView` source in its `lib/`, `mini_apps/`, `test/`, or `tests/` trees (excluding `pocket_host/`). Its `lib/render/pocket_ui_components.dart` has a generic horizontal `Gallery` component around line 1774, and `mini_apps/app_ui_showcase/main.js` demonstrates generic action buttons and a modal. Neither contains a story-aware tour or isolated replay behavior to reuse.

The current Pocket VN already has the matching primitives: `NovelView` lists replay entries in its gallery and supported one optional title shortcut through `featuredReplayId`; Lantern's `startReplay` and `exitReplay` in `demo/js/apps/lantern/app.tsx` pause the main engine, create an isolated replay engine, and restore the main engine on exit. The missing piece was a direct title-screen route for a second replay.

## Entry and compatibility

Lantern declares `feature_tour` as a replay at `script.feature_tour[0]` with no ending unlock. The title button is the localized replay title `5分钟能力巡演` / `5-Minute Feature Tour`. Selecting it calls the existing replay callback. The existing `featuredReplayId="model_showcase"` remains supported and continues to render the `立绘试映` / `Model theater` shortcut beside the tour. Additional shortcuts use the optional `featuredReplayIds` list and render before the legacy single shortcut, using the same title action component.

From the initial title screen, the tour is one tap away. The view adds no tour state, modal, engine, or unlock override. Missing or locked replay entries do not appear as title shortcuts; the gallery's existing ending gate is unchanged.

## Isolation boundary

`createNovelReplayEngine` copies variables, metadata, and reading preferences from the main engine. The `feature_tour` entry therefore needs to establish its own starting scene and initialize every tour variable it reads; it must not rely on the player's main-story clue or ending state. Lantern's existing persistence subscription writes autosave only for the main engine, so tour state remains in the replay instance and is disposed when the player exits.

The title-screen native acceptance test checks that both shortcuts are visible, the feature button reaches the `tour_01` opening, the replay exit returns to the title, and the `lantern.slot.auto` value is unchanged across entry and exit.

## Current v3 validation — 2026-11-08

`demo/js/tests/novel_feature_tour_native.test.ts` passes all 4 tests against
final QJBC `57ba6efd…` / PAK `bcbe0d4c…` (exact hashes in
`sdk/.pocket-build/lantern-v3-causal-20261108/release-artifacts.json`).
The source and two original phone/wide interaction tests remain in the same
file; the additional route uses actual pointer and host input events.

```sh
POCKET_NATIVE_PROBE="$PWD/sdk/.pocket-build/highres-native-tools-20261107/bin/pocket_probe" \
  sdk/.pocket-build/browser-test-bun-1.4.4/node_modules/@oven/bun-darwin-aarch64/bin/bun test \
  demo/js/tests/novel_feature_tour_native.test.ts
```

| Guest interaction category | Actual evidence |
| --- | --- |
| Model action | Spine meshes change pose after selecting the reel hotspot; model pixels are not substituted with a static portrait |
| Camera/weather | Background geometry/UV changes with a fixed operation count; color and opacity are excluded, settled geometry remains fixed for 8 frames; mist/rain geometry changes |
| Hotspot | Painted hotspot center selects its actual story branch |
| Dial | Painted 7 target selects the real registered dial and its authored feedback |
| Player input | Host edit produces the draft; an actual submit-button click produces the authored text echo (IME Done alone does not submit the story) |
| Video boundary | Actual Guest produces video surface and HostBridge requests/status transitions; NativeSession does not decode media |
| Save/load/rollback | Exit tour with original nonempty main autosave byte-identical; explicitly start a main journey, save/restore through real slots and rollback |
| Gallery content | Naturally reach `last_train`, unlock its CG, drag inside the actual gallery scroll clip until `art/dawn-departure.png` is drawn; no ending/CG metadata injection |

Log: `/tmp/pocket-lantern-v3-tour.log`. Title→tour requires one button action.
The complete automated route took about 2.65 seconds of driver wall time;
frames advance the Guest clock and text is advanced by input, so this is
**not evidence that a first-time human reads and discovers everything in five
minutes**. Real macOS video/audio playback, Live2D Core, physical devices,
and human discovery timing remain separate acceptance gates. The earlier
old-probe failure is retained in
`/tmp/pocket-lantern-v3-tour-old-probe.log`: that loader does not accept the
2048 PAK; the passing test uses the pinned high-resolution compiler/Core pair.

The gallery's unlocked image required scrolling past replay and music lists.
The test proves reachability, not ideal discoverability; the panel's content
priority still needs a visual review.
