# Lantern v4 frozen acceptance checkpoint

Date: 2026-11-08. This is a bounded checkpoint, not completion of the
[quantified Goal](VISUAL_NOVEL_GOAL.md).

## Frozen artifacts

The model framing, background planes, native story routes and migration tests
below use one frozen v4 candidate:

| Artifact | SHA-256 | Bytes |
| --- | --- | ---: |
| Lantern QJBC | `e03750c154c8fcaa4ef8b05f37f314a09e2e754ed628a249360c9c406b3bc176` | 1,073,341 |
| Lantern PAK | `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | 69,193,344 |

Story source SHA-256:
`aa21d89ce244df20346d55a06afa3664f0a8a511157bd71b02479328d1ce97e9`.
Compiled source and its story object were compared with the current source.
Artifacts and build metadata are preserved under
`sdk/.pocket-build/lantern-v4-scaled-20261108/`. Generated caches are evidence,
not source dependencies.

## Actual execution

| Scope | Result | Log |
| --- | --- | --- |
| Three natural endings, timeout, save/load/rollback, three naturally unlocked CGs, real gallery scrolling/pagination and unchanged main autosave | 1 passed | `/tmp/pocket-lantern-v4-route-gallery-fixed.log` |
| Real v1/v2/v3 save fixtures migrated directly to v4, continued and rolled back | 3 passed | `/tmp/pocket-lantern-v4-migration.log` |
| Independent feature tour and parallax replay, real pointer/IME input, UV-derived plane geometry, clear/restore, exit and main-save isolation | 5 passed | `/tmp/pocket-lantern-v4-scaled-parallax-tour.log` |
| macOS Profile real model/Core, high-resolution decoding, mask geometry movement, lifecycle resume and exit/reload release | All four size/DPR runs passed | `/tmp/pocket-model-v4-scaled-{390,1920}-dpr{1,2}.log` |

The gallery test initially selected a title clip after the count scrolled out
of view. The driver now identifies the actual visible list clip and scrolls
back to visible entries after changing pages. Assertions for real scrolling,
the third CG being absent from page one, cycling pages and unchanged autosave
remain. No gallery SDK failure was evidenced.

## Model pixels and ablation

| Test metrics | Actual capture pixels | Conservative visible-skin width, logical px |
| --- | --- | ---: |
| 390×844 / DPR 1 | 390×844 | 114 |
| 390×844 / DPR 2 | 780×1688 | 115 |
| 1920×1080 / DPR 1 | 1920×1080 | 142 |
| 1920×1080 / DPR 2 | 3840×2160 | 142.5 |

All eight full-body/closeup screenshots were preserved with SHA-256 in
`captures.json`; `acceptance.json` records log hashes, frozen payload identity
and pixel-metric checks in the same cache. Measurements use a manually bounded
bright-skin connected component, a conservative visible-cheek width rather
than an automatic whole-head detector. The DPR2 closeups were visually checked.

The unscaled control uses exactly the same story and PAK. Its desktop DPR1
measurement was 106 logical pixels; adding the SDK's existing viewport art
scale to canonical model geometry gives 142. Animated poses are not pixel
registered, so this is a framing comparison, not an exact pixel-difference
test. See [viewport scaling](VISUAL_NOVEL_MODEL_VIEWPORT_SCALE.md).

These are real macOS Profile renders with test-view metrics. They do not
establish physical-phone behavior or OS resize/rotation. Hiyori remains an
identified official sample, not original character artwork.

## Remaining gates

The independent parallax replay also passed its macOS Profile Flutter pixel
acceptance at a 390×844 logical test view / DPR2: actual PAK-decoded lamp and
mist pixels were captured before/after clear, and the isolated main auto-save
remained unchanged. This is not physical-phone or OS-rotation evidence; the
full capture hashes, alpha counts and command are in
[Lantern parallax Flutter acceptance](LANTERN_PARALLAX_FLUTTER.md). Earlier
actual video/audio decoder tests used the documented v3 Guest, so those are
not relabelled as v4 decoder results.
The zoom and clear captures also show the bottom `已读跳过` control clipped to
`已`; this parallax pixel result does not close general toolbar/layout acceptance.

Windows, physical phones, all UI art states, first-player discovery, final
60 Hz performance, cold starts and twenty-cycle stabilized RSS remain open.
The shared strict JSX check now exits cleanly after the type-narrowing fixes;
the model harness's Dart analysis also passes.

The 69,193,344-byte PAK requires the explicitly bounded Lantern-only 72 MiB
allowance in both the JS system catalog and trusted Dart native policy. This
fixes admission; it does not establish a resident-memory or startup budget.

## Subsequent strict JSX candidate

After this pixel checkpoint, the seventeen strict JSX diagnostics were fixed
with explicit memo seed types, existing numeric-style fallback semantics,
safe ref dispatch/node access and ordinary JSX children for the title's
conditional replay list. The complete shared-source strict check now exits
zero. No model viewport, story, image or background geometry was changed.

The rebuilt Lantern QJBC is 1,073,374 bytes, SHA-256
`8defe742d93c066cabbaf7e2c8f665f854c05c8ee03c40e706f1578cae9cb962`.
Its PAK is byte-identical to the table above. All nine native route,
migration, tour and parallax cases passed against this new QJBC in
`/tmp/pocket-lantern-v4-strict-native.log` (17.78 seconds). Build metadata and
hashes are in `sdk/.pocket-build/lantern-v4-strict-jsx-20261108/`.
The four model pixel runs above remain attributed to the earlier `e037…`
QJBC; they are not relabelled as pixel tests of this subsequent build.

The subsequent build also passed the actual macOS Profile model test at
390×844 / DPR2 (50 seconds), including real Core lifecycle/release and main-save
isolation. Its 780×1688 captures and payload fingerprint are preserved in
`model-390-dpr2-captures.json` in that cache; the conservative skin-component
width is 114 logical pixels. The other three matrix runs still belong to
the original frozen candidate.

The strict candidate's Profile parallax test passed in 22 seconds, log
`/tmp/pocket-lantern-v4-strict-parallax-flutter.log`. All three captures are
byte-identical to the earlier e037 candidate. Preserved screenshots and bundle
fingerprints are in `parallax-captures/` and `parallax-acceptance.json` in the
same cache. A thumbnail was initially misread as footer text truncation.
Read-only analysis of the actual physical-pixel ROI `[648,1624,744,1654]`
finds all four glyphs present: each capture has ink counts
`[102,156,189,135]`, and the complete thresholded glyph masks have zero pixel
differences. `inspect_footer.swift` and `footer-pixel-analysis.json` preserve
the method and evidence in that cache. A raw top-down 16-bit PNG check also
finds all four glyph cells populated. Whole-ROI bytes may differ because the
background changes; that is not glyph loss. The defect hypothesis was
withdrawn and no production rendering workaround was added.

The corresponding system UI rebuild has QJBC SHA-256
`472720425817eb7f3153887d455ebf70b90515b951b0fe07ce4509ffdfdad89f`;
its PAK remains `5955143e…`. These isolated candidates are not yet the
running ordinary Demo at that earlier checkpoint.

## Ordinary playable update

The subsequent ordinary `lib/main.dart` macOS Profile build succeeded and was
copied into the independent
`sdk/.pocket-build/lantern-playable-v4-strict-20261108/pocket_host.app` cache.
All four embedded Lantern/system QJBC/PAK hashes were checked against the
subsequent candidate records above. `playable.json` records PID 4789, Metal
and VM-service readiness, the successful activation request and Editor not
started. Only after those startup facts were observed was the old exact-path
v3 process (PID 39223) terminated. The unrelated Flutter daemon PID 39062 was
preserved. Main-story storage was not cleared.

The current foreground window's pixels were not independently verified:
the computer-use native pipe failed to start. Startup and activation are
therefore recorded separately from the isolated integration screenshots.
Build/startup logs are `/tmp/pocket-lantern-v4-playable-build.log` and
`/tmp/pocket-lantern-v4-playable.log`. The overall Goal remains active;
one intact footer label does not establish whole-UI visual acceptance.

## Android Profile package preparation

The arm64 Android model-test Profile APK built successfully on 2026-11-08
using `integration_test/novel_model_showcase_test.dart`, without test-view
size overrides. The archived APK is
`sdk/.pocket-build/lantern-v4-android-profile-20261108/app-profile.apk`:
67,749,729 bytes, SHA-256
`b2e4b679763727f86a23dc80b897e65251661457ce48016f5dca73c0421e3692`.
`apk-verification.json` beside it records the ZIP entries. Both Lantern and
system QJBC/PAK hashes match the strict candidates above; the native library
is ELF64 AArch64. Native source was rebuilt with bounded 2048 IMG support
before packaging. Gradle strips the library, so the packed library hash is
recorded separately from the unstripped Rust output.

`android-native-provenance.json` proves that the Rust target, JNI input and
Gradle merged library are byte-identical (`a3af0261…`), while the Gradle
stripped output and APK entry are byte-identical (`d4093c2a…`). The packaged
library therefore comes from this rebuild; its differing stripped hash is
not evidence of a stale native binary. Reproduction and stable Cubism-cache
details are in [Android preparation](VISUAL_NOVEL_ANDROID_PHYSICAL_PREP.md).

This is a prepared integration-test package, not a physical-device pass or
the ordinary player APK. The connected MAA_AN00 Android device was locked
with its screen off during preparation; unlock was requested before device
execution. No physical model, touch, IME or lifecycle result is claimed.
Build log: `/tmp/pocket-v4-android-profile-build.log`.

The exact archived APK subsequently passed the actual ARM64 Android emulator
model integration case in 53 seconds, using `--use-application-binary`
without rebuilding or test-view overrides. Log:
`/tmp/pocket-v4-android-emulator-model.log`. It exercised both 2048² Hiyori
pages, masking, moving geometry, shared model pause/resume and handle release,
Spine switching and unchanged main autosave. The reported viewport captures
were 1080×1920 physical pixels at DPR 2.625. This is emulator functional
evidence, not physical-device input, OS lifecycle or a performance pass.
`handleAppLifecycleStateChanged` is injected by the test rather than an OS
background/foreground action. The default drive cleanup uninstalled the app,
so the first run's saved PNGs were unavailable afterward; a capture-preserving
run uses `--keep-app-running` before pulling the files.

That capture-preserving run passed in 52 seconds, log
`/tmp/pocket-v4-android-emulator-model-captures.log`. Both actual PNGs were
pulled and checked as RGBA8 1080×1920; their hashes, actual 411.43×731.43
logical viewport/DPR 2.625, Guest payload fingerprint and limitations are
recorded in `emulator-model-acceptance.json` beside the archived APK.
The eyes, mouth, hair and masked edges render in the close-up. In the full
framing the feet extend behind the footer, so complete full-body composition
is still open. The temporary integration app was uninstalled after capture;
the ordinary macOS Demo and physical phone were not changed.

## Audio registration ablation

The shared audio plugin now accepts a validated bundle `assetPrefix`, allowing
the Demo to remove thirteen duplicate asset mappings while keeping exact-map
compatibility and real decode failures. Package analysis and 23 package tests
passed. The strict v4 macOS Profile audio test passed both cases (15 seconds),
including real 13,601 ms voice completion through the prefix; replay music
restoration passed (8 seconds) through the ordinary Lantern plugin factory.
Logs are `/tmp/pocket-lantern-v4-prefix-audio.log` and
`/tmp/pocket-lantern-v4-prefix-replay-music.log`; details and retained-parent
source review are in [audio registration](VISUAL_NOVEL_AUDIO_ASSET_REGISTRATION.md).
The already-running ordinary cached app predates this Dart-only change;
its Guest hashes remain the same. Architecture validation passes with the
Demo entry reduced to 89 lines, without removing its VN keyboard mapping.

## Borrowed binary-frame parsing candidate

The shared Dart runtime now parses the borrowed PFB1/full or binary-v2 packet
synchronously before calling `lastError`, retaining owned resource pixel and
palette bytes and native-error precedence. The real 2048×1024 FFI fixture
replaces the native output and verifies that the previously returned frame
remains intact. The three focused package suites pass 31 tests with the real
macOS arm64 dylib; analysis passes. The 8 MiB transfer diagnostic measured
baseline median 3,116 µs and candidate 1,112 µs in the paired focused runs;
a subsequent candidate suite run measured 1,778 µs. These are fixture timings,
not whole-game frame or RSS results. Details and commands:
[binary-frame copy ablation](VISUAL_NOVEL_BINARY_FRAME_COPY_ABLATION.md).

This source change is newer than both the ordinary cached macOS app and the
Android APK tested above. Their results do not validate this new Dart runtime;
a fresh Profile build with actual image/input checks is still required.

## Eight-screen bilingual UI baseline

The strict Guest's full macOS Profile UI integration file now passes both
cases (Flutter reports 3 including teardown), log
`/tmp/pocket-v4-ui-pixel-matrix-final2.log`. The earlier viewport case failed
because its compressed drag helper did not deliver a Guest scroll; explicit
pointer-down/move/up frames restored the retained 800×600 and short-screen
title-settings reachability assertions. The test now isolates its real app
support and verifies ordinary-store bytes unchanged.

The second case captures title, dialogue, choice, journal, settings, save/load,
log and gallery in Chinese and English: 16 actual 780×1688 PNGs at 390×844
logical/DPR2. The initial matrix itself passed even while the older case was
failing; these results are recorded separately in
[UI pixel matrix](LANTERN_UI_PIXEL_MATRIX.md). Screenshot review identifies
real open issues: the long English log heading pushes the Back skin rightward,
and long gallery replay labels are hard-clipped. This is functional/image
baseline evidence, not the final UI quality or focus/pressed-state gate.
The new borrowed-frame Dart runtime's inclusion in this particular build has
not yet been independently established, so this pass is not assigned to that
optimization until build-input provenance or a fresh Profile run confirms it.

Subsequent build-input inspection establishes inclusion: the final2 build's
`.filecache` (03:29:22) records MD5 `d76700b331720382e0dd3478e0dc7227`
for `pocket_runtime.dart`, matching source SHA-256
`af67e338e533f0ade60579ba9a926a7d9f97ce4b22dfc978c36a7667d9a9b82b`.
The Profile AOT output (03:29:25) also contains
`_parseBorrowedBinaryFrame`. The complete passing UI run therefore provides
actual Profile image/input regression evidence for the borrowed-frame runtime
with the frozen strict Guest. It remains outside the Android APK and the
ordinary cached Demo, and no whole-game performance pass is inferred.

## Full-body framing and acceptance completion protocol

Source story `a83084561a1628db1c19f229cd044fbe50a4c4bae343b4ac27d7ad80dd9c3d36` changes only three Hiyori full-body Y positions from 200 to 130. Frozen Guest `c2df4275ea8243270a4638a362d55c503aaa2f56b2e0bc43c00f00bbfb01c643` retains PAK `8126d148…`. The 24 story/localization tests and 9 real Guest regressions pass. Actual macOS Profile model runs pass at 390×844/DPR2 (176 s, diagnostic run) and 1920×1080/DPR1 (59 s, traced run), covering Idle1, Idle0, TapBody, close-up, release/re-entry and ordinary-store isolation. All six full-body PNGs were reviewed: head, arms and shoes remain clear of header/footer controls. These are test-view dimensions and an official Hiyori sample, not physical phones or original character art. Captures, exact hashes and failed trials are retained in [full-body framing evidence](LANTERN_MODEL_FULL_BODY_FRAMING.md).

A real timeout exposed a Flutter integration-driver false success: process exit 0 and “All tests passed” could occur without the test body completing. The driver now validates an optional persisted required/completed checkpoint report after writing response data. Four focused tests pass; a missing-checkpoint real Profile run exits 1 and a complete real run exits 0. Earlier five historical model logs were separately checked for actual body completion and no test errors. See [driver completion evidence](VISUAL_NOVEL_DRIVER_COMPLETION.md).

The next UI-wrap Guest is `75946cabe0c4b07a32e8050b57e851e4a7eaaba82b701bcb7add32e76be78f50`, PAK `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`. Its PAK is 16 bytes larger solely because `ui:styles` grows 14 bytes plus alignment; all 22 IMG payloads are byte-identical. A first staging attempt briefly mixed new bytecode with old PAK/metadata, so `/tmp/pocket-v4-ui-wrap-native.log` is an invalid-artifact failure, not a code-regression result. All three files were restored, then the complete new tuple was prevalidated and staged together, recorded in `lantern-v4-ui-wrap-20261108/valid-staging.json`. Only subsequent valid-tuple runs count.

Valid UI-wrap tuple NativeSession regression: **9/9 pass, 18.05 s**, `/tmp/pocket-v4-ui-wrap-native-valid.log` (four files: novel native, revision, feature tour and parallax). This result supersedes the invalid mixed-artifact run for regression assessment; Profile pixel validation is tracked separately.

## Player-reported aliasing and input ghosting batch

The user reported strong full-body Live2D staircase edges and overlapping input text in the five-minute tour. These are current quality gates, not covered by the earlier framing-only pass.

Same Guest `75946cab…` / PAK `5162ed5f…`, macOS Profile test-view 329×600/DPR2, LOD OFF and ON each complete the actual model test in 60 seconds with required/completed `model-showcase` checkpoints. Each captures Idle1 full-body, close-up, Idle0 and TapBody; ON reports both original Hiyori pages retaining 1024/512/256 variants. Frozen inputs, four PNGs per arm and reports: `sdk/.pocket-build/mesh-lod-ablation-20261108/`. OFF log `/tmp/pocket-mesh-lod-off-scroll-profile.log`, ON log `/tmp/pocket-mesh-lod-on-profile.log`. The initial OFF attempt fails because its helper waits for a culled title label without scrolling; the repaired driver delivers real pointer drags. That failure remains separate. Motion poses are not registered, so these are scenario/visual comparisons, not pixel-aligned diffs.

Review confirms smoother model hair/clothing/skirt details, but also detects blurred nine-slice button skins: the initial LOD eligibility was too broad. The subsequent candidate preserves clamped UI mesh sampling and limits derived-image generation/selection to repeat-sampling meshes. This reuses the existing sampler flag used by Live2D, not demo asset-name matching; arbitrary clamped model minification is not claimed solved. Sampling, repeat/alpha mask, first-frame, release and invalidation package regressions pass 24/24 in `/tmp/pocket-mesh-lod-skin-protection.log`; actual final-candidate image/input verification remains pending. See [sampling ablation](VISUAL_NOVEL_MESH_MINIFICATION.md).

The 329×600 OFF/ON captures also reveal shoes overlapping the footer at Y=130. Three authored full-body anchors now use Y=80; close-ups, scale, labels, addresses, story version and save schema are unchanged. This is a new framing candidate requiring its own Profile check, not evidence inherited from Y=130 captures.

The input patch retains native caret/selection/composition. It suppresses Guest glyphs only after the current editing session receives an actual mounted-editor `textInput.opened` acknowledgment, and restores them on close/submit/dismiss. No acknowledgment keeps fallback text visible; stale acknowledgments do not reactivate retired sessions. SDK/native Guest fixture regressions pass; physical IME and actual Flutter images remain distinct pending gates.

Current staged Lantern QJBC is `72cbbfa3652c806bc28e6e57ab8831780a202c183fb8b12b18606e4ddde38d82`, PAK `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`, story source `8143fa4bb2baa7c99af17f310851f413532a9f0c7060978e3d98f4503c1b54b3`. Its 31 native/story tests pass (1,397 assertions), `/tmp/pocket-lantern-input-lod-native.log`. Build source/package/tool/Bun fingerprints and complete prevalidated tuple backup are in `lantern-v4-input-lod-20261108/{build-inputs,staging}.json`. The system UI is rebuilt from the same SDK: QJBC `c91f989a669466cccd5cb4b7c00ea6b7478f9132ab79128948e2d492324fb8f5`; its PAK remains `5955143e…`. Neither staged artifact is yet the ordinary cached PID 4789.

The soak test now includes bounded post-release RSS observation and a completion checkpoint; decoded-byte estimates include distinct LOD images. This adds measurement capability, not a new memory or performance pass. Protocol: [stable RSS sampling](VISUAL_NOVEL_STABLE_RSS_SAMPLING.md).


## Input and narrow-toolbar candidate (2026-11-08)

The current staged Lantern tuple is now QJBC
`113ec9f918eb277e1d312c5aec416c7c069ffcc4f6048b96c00e625f09776e3f`
(1,076,109 bytes), PAK
`5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1`
(69,193,360 bytes), metadata
`c349c9110df537dc0dffdc62bd359f42dae50cb95ed804e4654b172261c629f8`.
Build inputs, complete previous tuple and validated payload/staging hashes are in
`sdk/.pocket-build/lantern-v4-input-lod-toolbar-20261108/`.
The same candidate passed 31 native/story tests, 1,397 assertions in 19.14s
(`/tmp/pocket-lantern-input-lod-toolbar-native.log`). The toolbar now uses its
available label width and omits icons on narrow buttons; image skins remain.
Final Flutter pixels for this tuple are still pending at this checkpoint.

The preceding tuple (`72cbbfa3…`) reached the five-minute tour input through
real pointer input at 329×600/DPR2. Focused CJK/emoji and preedit show only the
native text; blur restores one Guest copy. Diagnostic PNGs are retained in
`sdk/.pocket-build/input-overlay-329-dpr2-diagnostic-20261108/`.
The tour case subsequently passed its input assertions and isolated-store
cleanup in `/tmp/pocket-novel-input-overlay-full-final.log`; the full file
failed its main-route target lookup after the boolean input. Thus this is
bounded input evidence, not a whole-file pass. The next full run must report
nested `pocketAcceptance` required/completed checkpoints to the driver.

The narrow tour's three text cards are intentional horizontal choices. A
NativeSession check against `72cbbfa3…` confirmed their visible text bounds,
clips and actual pointer-driven entry to the input panel. Evidence is in
`sdk/.pocket-build/mesh-lod-ablation-20261108/tour-hitbox-329.json`.


### Centered toolbar follow-up

The 113ec9f9 candidate's actual narrow-window screenshot exposed left-aligned
labels touching their frame. Keeping the body Text's intrinsic width lets the
existing parent center it; `labelWidth` remains the wrapping budget. The
heading path is unchanged. The canonical rebuild is QJBC
`e0a4a109ec0836ca547bcfab6723e0f2218b0f25e453ab9368d11fa4063a3097`
(1,076,012 bytes), unchanged PAK `5162ed5f…`, metadata
`5aeeaaad5aec793398ebd019e1a329d870db90552575d3a59099491b5e4468ab`.
Full build/staging provenance and prior tuple are in
`sdk/.pocket-build/lantern-v4-input-lod-centered-20261108/`.
All nine real Guest route, migration, feature-tour and parallax tests pass in
18.71s (`/tmp/pocket-lantern-input-lod-centered-native.log`).

The final same-Guest sampling-OFF model run passed in 60 seconds at a
329×600/DPR2 test view, including three full-body motions, close-up, real
motion/mask changes, release/re-entry and main-store isolation. The four PNGs
and driver `model-showcase` checkpoint response are archived in
`sdk/.pocket-build/mesh-lod-final-ablation-20261108/off/`.
Review shows clear head, hands and shoes and centered, readable toolbar labels.
This is still the OFF control; final default-ON pixels are a separate gate.


The default-ON final model case also passed in 59 seconds with its complete
`model-showcase` checkpoint. Four ON PNGs, metadata, hashes and response are
in `sdk/.pocket-build/mesh-lod-final-ablation-20261108/on/`. Compared with the
same-Guest OFF control, model texture aliasing is visibly reduced and UI frame
sampling stays sharp; all three full-body motions retain their shoes above
the toolbar. These are test-view pixels, not a physical-device, OS-resize,
frame-rate, stabilized-RSS or complete geometric-AA result. See
[the sampling evidence](VISUAL_NOVEL_MESH_MINIFICATION.md).


### Final actual Flutter input acceptance

The final centered Guest `e0a4a109…` / Root UI `c91f989a…` passed the complete
main-story and five-minute-tour Profile input file in 1m47s. The saved response
contains nested `pocketAcceptance.required = [main-input, tour-input]` and
`completed = [main-input, tour-input]`. Evidence (five PNGs, original log,
response, exact test source and facts) is in
`sdk/.pocket-build/input-overlay-329-dpr2-e0a4a109-final-20261108/`.
The final test-source SHA is
`6a1b73eb146103016f7cf2012c83097d37b605462b8ae3aed83520d69e56a7cb`.
It verifies CJK/emoji, composition/selection, blur, number rejection and
exponent correction, boolean confirmation, and unchanged ordinary user-store
bytes. Focused input has no Guest copy; blur shows exactly one Guest value.
These use the real Flutter TextInputClient and Guest protocol, driven by the
Flutter test input client; no physical OS candidate-window behavior is claimed.

The prior main-case failures were driver advancement races: the helper checked
partial typewriter text, waited for the complete-line continue hint and then
advanced before checking that completed line again. The final helper rechecks
the completed line before sending the real pointer. The final log captures
`我会把你的署名和 林岚🙂\n的回邮格一起收好。` before advancement. No story
or boolean business logic was changed to make the regression pass.


### Ordinary playable Demo updated

The ordinary `lib/main.dart` macOS Profile build (148.7 MB) was copied into
`sdk/.pocket-build/lantern-playable-input-lod-20261108/pocket_host.app` and
launched as PID 41682. All six embedded Lantern/Root UI QJBC, PAK and metadata
hashes match the staged final tuples. Metal/Impeller and the VM service are
ready; a real on-screen window is 329×632 outer pixels. The exact prior cached
ordinary app PID 4789 was terminated only after readiness, while unrelated
Flutter daemon PID 39062 remains untouched. User storage was not cleared.
No editor backend was started. `playable.json` in that cache records exact
artifacts and sources. `open -a` of the exact new app path succeeded; the
frontmost app/game pixels could not be verified, so no game-foreground claim
is made.
