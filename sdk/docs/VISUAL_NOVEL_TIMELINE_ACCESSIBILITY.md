# Timeline editing and motion accessibility

This increment extends S04; it does not establish full engine parity or final cross-platform performance. Live2D image clarity remains deferred at the user's request.

## Source-first evidence

The retained parent `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo` was inspected excluding `pocket_host/`. `lib/render/pocket_ui_components.dart:790` transports game touch deltas; no timeline/keyframe authoring or reduce-motion timeline policy was found in the retained `lib/` and `mini_apps/`. `pocketjs_super_app_demo.html:933–938` uses a one-shot Web Audio gain ramp and has no reusable named-channel ownership model. These are evidenced gaps, not replacements of working parent capabilities.

The implementation adapts the current SDK's single `StoryDefinition.timelines` source, editor form/history/draft pipeline, private `sampleNovelTimeline` sampler and app-level accessibility provider. Flutter already reports `MediaQuery.disableAnimations` through `accessibility.preferences` in `packages/pocket_flutter/lib/src/pocket_view.dart`; no Dart policy or second clock is added.

## Presentation and canonical state

`NovelEngine.getStagePresentation({reduceMotion:true})` projects an active timeline's camera and actors to their authored endpoint using the existing sampler. The default/false path returns the canonical snapshot stage without allocation. The projected stage is frozen, is not stored in a save, and retains the real timeline cursor. Audio cues, gain envelopes, lifecycle pause, save/load and rollback continue on the original engine clock.

`NovelView` memoizes this read-only projection and uses it consistently for stage art, camera and spatial choice layout/hit geometry. Reduced-motion scene transitions render as cuts; the canonical transition remains available to the engine/save layer. Toggling the preference off returns to the current real timeline sample. This scope does not claim every model animation or platform motion behavior has been disabled.

## Editor and audio ownership

Camera, actor, cue and gain markers edit the same canonical `atMs` fields as their forms. Drag operations use a transient starting value and existing history, without a second timeline model. Motion frames retain strict array order and a fixed first frame at zero; audio cues can share a timestamp. Escape/cancellation restore the starting value, and a committed drag has one undo step. Default drag snapping and arrow-key steps are 10 ms; Shift uses 1 ms. The lane chooses the nearest marker center, including locked first frames, so a legal frame at 899 ms beside a 900 ms frame can be dragged back. Overlapping same-time cue markers can be selected precisely with Tab and adjusted with arrows. Switching presets during capture restores the original preset by its stored ID, without changing the newly selected preset.

Audio gain tracks reject the SDK-owned `effect-0` through `effect-3`, `music-preview`, and dialogue voice identity. The existing native identifier grammar and 64-character limit are retained. `music`, `effect-4` and ordinary custom channels remain valid; this change does not alter legacy audio instructions or saved intent compatibility.

## Validation

Evidence for this increment is recorded under `sdk/.pocket-build/timeline-access-20261108/`. The core suite passes 232 tests / 1,919 assertions; strict core and view TypeScript checks pass. The Editor joint run passes 26 tests across five files, including real Chromium drag/history/cancel/near-frame-boundary/save/reopen and saved Guest/native camera, actor, cue and gain behavior. Story/localization passes 29 tests / 1,622 assertions. Seven existing real Native regressions and the new reduced-motion Native fixture pass. The latter verifies canonical/save pose and cursor isolation, continuing audio requests, live preference switches, HUD input and a spatial choice selected through its projected native pointer coordinates. The macOS Profile Demo passes four declared checkpoints: decoded endpoint pose, live preference toggles, real audio decode/playback and preserved ordinary storage. Final source/artifact hashes are recorded in the acceptance manifest. The macOS test supplies accessibility facts through Flutter's official `TestPlatformDispatcher` boundary; it is not evidence that a human changed the operating system setting. It then observes production host events, shipped QJBC, decoded image geometry and the real audio plugin. No user storage is cleared.

Physical mobile devices, iOS/Windows timeline execution, sample-accurate synchronization, human audio assessment and whole-game performance remain separate acceptance work. Android emulator evidence follows below.

## Final artifacts and ordinary Demo

The authoritative logs are `vn.log`, `core-typecheck.log`, `view-typecheck.log`, `editor-final.log`, `story-locales-final.log`, `native-regression.log`, `native-reduced-final.log` and `macos-reduced.log`. `final-acceptance-manifest.json` verifies each relevant source hash against the final files and records artifact hashes, signature, required checkpoints and limits. Earlier fixture failures are diagnostic runs, not accepted evidence.

The shipped QJBC is 1,161,600 bytes, SHA-256 `fd670db306872811a754106888ce0a22ca8b13ba778a4b365a34776aa4e51d10`. The PAK remains byte-identical to the prior accepted 69,216,560-byte resource bundle. Demo staging, isolated Flutter mirror and ordinary app contain the exact four accepted Lantern files.

The normal `lib/main.dart` Profile app is `sdk/.pocket-build/lantern-playable-timeline-access-20261108/pocket_host.app`, PID78886. Code signature, runnable normal main isolate and 800×632 onscreen window are verified; the old owned PID44175 exited after replacement readiness. No editor was opened and ordinary user storage was preserved. AppKit reports `com.apple.loginwindow` frontmost and no screen-capture access; human foreground visibility is not established and no unlock was attempted.

Ablation retained one authored timeline, one engine clock, one existing sampler and the editor's existing history. The default presentation path returns the canonical stage without allocation; the reduced path is a view memo, not a new persisted pose map or engine cache. Performance improvement is not claimed without a whole-game benchmark.


## Android emulator follow-up (2026-11-09)

Evidence is in `sdk/.pocket-build/timeline-mobile-20261109/final-acceptance-manifest.json`. Android15/API35 arm64 emulator Profile passed the full timeline seven checkpoints and the separate reduced-motion four checkpoints with the same shipped fd670 QJBC /54c923 PAK. Real decoded PNGs, camera/actor input-driven frame changes, lifecycle-boundary pause/resume, audio decode, preset reuse, gain envelope and replay release are recorded. The full timeline used restored baseline SDK float-snapshot source; reduced-motion was compiled during the subsequently rejected float-copy candidate. Its static Mira fixture does not call Live2D. These are separately compiled test apps, not one final release binary. The isolated package is `com.example.pocket_host.timelineqa`; ordinary storage hash was preserved. A connected physical Android device was locked/Dozing and was not operated; no physical-device acceptance is claimed.

Two test assumptions were corrected from actual failures. The bounds helper now recovers the original full affine image quad from UVs for a clipped `PocketTextureTriangleOp`, matching the existing ImageOp convention; endpoint tolerances were not widened and arbitrary deforming meshes are outside this helper's scope. The endpoint wait now observes actor, camera and relay together before asserting their final geometry.

The gain test initially failed on a strict native-position monotonic invariant. Complete evidence showed position31→80→118→56ms while host elapsed105→154→191→243ms and gain increased normally. The pinned `just_audio`0.10.6 getter estimates position from the latest playback event plus elapsed wall time, capped to duration, and documents no monotonic guarantee. A later successful run still recorded108→83ms. Native timestamp-correction logs are retained; this is a sampled-position observation, not proof that actual sound rewound or that the platform has no playback fault.

The corrected test preserves the raw position trace and requires real positive progress with the expected channel/asset/loop and ready/playing state. It continues to assert gain range, peak, fade, completion and release rather than treating that native getter as the JS timeline clock. The final trace has119 active snapshots plus a released snapshot; volume reaches0.595 then fades to0.000427, followed by `playerPresent=false`, idle and not playing. Native sample-accurate synchronization and position monotonicity remain unverified. Reduced motion uses Flutter's test accessibility boundary, not a human OS setting. These results extend S04's platform evidence without promoting the full group or whole-game performance gate.
