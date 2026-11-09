# Current Lantern static-topology transport ablation

Date: 2026-11-08. This is a measured incremental optimization, not whole-goal or 60 Hz acceptance.

## Source and scope

The retained parent `pocketjs_flutter_demo/lib/core/perf_monitor.dart` supplies the passive Flutter timing boundary; its renderer has no Live2D topology transport. The SDK already implements the versioned full-first / cached-v1 protocol in `pocket_live2d/src/transport.ts` and the native Core provider. This experiment reuses that implementation. Only `demo/js/apps/lantern/app.tsx` changes its existing `createBundledNovelLive2dFactory` call to explicitly request `cacheStaticTopology: true`. The public SDK default remains off for older native providers. No second renderer, layout engine, animation clock or cache implementation was added.

The painter fusion candidate was separately rejected and restored byte-for-byte to SHA-256 `8e2227bf0c6b1fbab9d35d5405a5f194bbe6ee0e64effbce1344763f3f07598e`; see [the negative ablation](VISUAL_NOVEL_LOD_FUSION_ABLATION.md).

## Frozen artifacts

| Variant | QJBC SHA-256 | Bytes |
| --- | --- | ---: |
| OFF | `e0a4a109ec0836ca547bcfab6723e0f2218b0f25e453ab9368d11fa4063a3097` | 1,076,012 |
| ON | `a364702558f5c091b77a8ea679285bfb3ebb1e3affd45e2a48d5b233d9e502ff` | 1,076,019 |

Both PAKs are byte-identical, SHA-256 `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`, 69,193,360 bytes. Story, UI skins, original 2048² pages, bounded LOD and Root UI `c91f989a…` are unchanged. The ON metadata hash is `af7290ac184b7a0baf1fb1e0961269f31e27c1ebeef1edc1ec4d4217702ea707`. Build/provenance, complete OFF tuple and reports are retained in `sdk/.pocket-build/lantern-current-topology-ablation-20261108/`. The canonical pinned buildGuest used Bun 1.4.4 and `highres-native-tools-20261107`; payload size/hash were checked before staging complete tuples.

## Primary same-harness comparison

macOS arm64, Flutter 3.47.9 Profile, 60 Hz, the existing 329×600 desktop content window. Both runs use exact soak-harness SHA-256 `9c918e0a5ae018be63198f872502d9e2e78a06431f44165a406c7bdce3b211be`. Each observes five real 10-second model windows, changed actual Core geometry, both decoded 2048² pages and two enter/exit cycles. Both driver responses complete `model-soak-ablation`.

| Window | OFF build P95 (ms) | ON build P95 (ms) | OFF over 16.67 ms | ON over 16.67 ms |
| --- | ---: | ---: | ---: | ---: |
| Idle 0 | 19.896 | 14.930 | 125 / 433 | 6 / 400 |
| Idle 1 | 19.966 | 14.627 | 146 / 426 | 8 / 420 |
| Idle 1 close-up | 19.516 | 12.908 | 152 / 411 | 3 / 425 |
| Idle 0 repeat | 20.009 | 14.785 | 116 / 428 | 4 / 396 |
| Idle 1 repeat | 19.875 | 14.148 | 143 / 415 | 3 / 412 |

Across these windows OFF has 682/2,113 over-budget frame entries (32.28%); ON has 24/2,053 (1.17%). The observed build P95 reductions are approximately 25–34%, specific to this workload. The ON result still fails build P95 ≤12 ms and aggregate over-budget ≤1%; it must not be reported as the completed performance gate. The denominator is actual Flutter FrameTiming entries, not an assertion that every display refresh produced a unique guest frame. Raster times, native-call measurements and source identities are retained in the JSON reports.

The primary order was ON then reverse OFF. An earlier OFF run also measured 19.61–20.04 ms, but its full test source was not archived before passive measurement-field updates; it is supporting history, not used to claim same-harness equality. The later primary pair removes that test-source ambiguity. These are sequential separate processes, not randomized repeated device trials. Heavy parallel builds were paused during the timing windows; the ordinary cached Demo and unrelated daemon were preserved.

Commands from `demo/`:

```sh
env -u POCKET_NATIVE_LIBRARY /Volumes/ORICO/dev-tools/fvm/versions/3.47.9/bin/flutter drive --profile --driver=test_driver/integration_test.dart --target=integration_test/novel_model_soak_test.dart -d macos --no-pub --dart-define=POCKET_NOVEL_PROFILE_ABLATION=true
```

For each variant the complete prevalidated QJBC/PAK/metadata tuple is staged. The final ON tuple was restored after the reverse OFF run. `comparison.json`, `{on,off-reverse}-windows.json`, responses and logs are in the evidence directory above.

## Functional evidence and remaining gates

- JS Live2D transport, VN adapter and clock tests: 18 passed / 99 assertions, `/tmp/pocket-current-topology-sdk-tests.log`.
- Native-provider protocol compatibility: 14 Dart tests passed, covering full → cached → release/reload, topology mutation rejection and legacy-provider behavior. These inject Core providers and are not real-Core evidence.
- Current ON QJBC native story, save migration, feature tour and parallax: nine tests passed in 17.45s, `/tmp/pocket-current-topology-on-native.log`. These do not replace actual Cubism execution.
- Both primary Profile comparisons above use actual Core 6.0.1, actual geometry and real pointer-driven workflows; they are real-Core evidence for the measured model scenes and two release cycles.

The final ON model Profile interaction/pixel run passed in 59 seconds and completed `model-showcase`: three whole-body poses, close-up, actual Core movement/masks, pause/resume, release/re-entry and store isolation. Four PNGs, the response, log and identities are archived under `model-captures/` in the evidence directory. Whole-body head/hands/shoes remain visible and image UI stays sharp. This functional run overlapped Editor work and is not a timing acceptance run.

Normal twenty-cycle stabilized RSS, physical platforms and the overall performance gate remain distinct checks. Clock actor release is not observed by the Flutter soak harness and is explicitly unverified; audio channel allocation is recorded, with legitimate main-story BGM allowed to remain in the catalog.

## Normal twenty-cycle follow-up: gate not passed

The normal (non-ablation) Profile run completed all seven whole-game windows, five model windows and twenty real enter/exit cycles. Every cycle released the native handle and Hiyori draw operations, including the post-RSS recheck. Audio allocation remained 1→1, consistent with the retained main-story BGM; clock release remains unobserved.

The first-five median was 638,009,344 bytes and final-five median 570,753,024 bytes (signed difference −67,256,320 bytes). Neither positive-growth threshold was exceeded. However, cycles 3–8 had unstable sample windows, so `allCycleWindowsStable=false`, `gatePassed=false`, status `unverified-unstable-sample-window`. The driver test failed at this gate; `model-stable-rss` must not be reported complete. Twenty released handles and a negative end-to-end RSS difference do not turn the stable-memory gate into a pass.

The five model windows measured build P95 13.642–14.496 ms, with 22/1,984 frame entries over 16.67 ms (1.11%). Both strict model performance targets remain unmet. Seven ordinary windows are one observation per scene, and static menus produce few frame entries; these do not establish five windows per class or whole-game 60 Hz acceptance.

The ordinary cached Demo remains the previously validated `e0a4a109…` input/LOD version. The ON `a3647025…` artifact stays an experimental candidate, with the current complete evidence retained for further memory/performance work. Full run evidence (source, artifacts, log, failure response and manifest): `sdk/.pocket-build/novel-stable-rss-fullrun-20261108/`; see [the stable RSS protocol and result](VISUAL_NOVEL_STABLE_RSS_SAMPLING.md). Full run log: `/tmp/pocket-stable-rss-fullrun-20261108.log`.
