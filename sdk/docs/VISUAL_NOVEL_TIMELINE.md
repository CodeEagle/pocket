# Visual novel shared timeline

This document records the initial timeline checkpoint. The later [audio envelope increment](VISUAL_NOVEL_AUDIO_ENVELOPES.md) adds gain tracks; its final manifest and the [current tracker](VISUAL_NOVEL_GOAL_TRACKER.md) supersede the ordinary app/PID and audio-envelope limitations below.

## Scope and source-first adaptation

The retained parent `../pocketjs_flutter_demo/` was inspected without its `pocket_host/` directory. No reusable visual-novel multi-track preset/editor was found. The retained `mini_apps/syslib/pocket_syslib_router.js:84–106` resolves eased translation/scale for route compositing; `lib/render/pocket_ui_components.dart` supplies host component animation boundaries. Neither owns narrative timeline state. `pocketjs_super_app_demo.html:923–953` schedules a WebAudio oscillator and its stop; it is not the native audio transport. Microphone `hardware.audio.recordSample` is unrelated to playback.

The adaptation reuses current SDK `camera.ts` transform bounds, `scene.ts` actor transforms, the engine’s existing audio cue emitter and `attachNovelClock`. Flutter acquires no narrative state machine. The existing view renders sampled stage transforms without a second renderer.

## Authoring contract

`StoryDefinition.timelines` maps reusable preset IDs to `{durationMs,camera?,actors?,audio?}`. A scene’s `timeline` references a preset; omission or `null` cancels an active preset. Scene character changes apply before preset frame zero. A missing actor target rejects activation.

Camera keyframes contain `{atMs,value:{x,y,scale},easing?}`. Actor tracks contain `{id,keyframes:[{atMs,value:{position:{x,y},scale,rotation},easing?}]}`. Motion tracks start at zero, have strictly increasing integer times, and interpolate with the destination frame’s `linear` or `easeInOut` easing. Values are absolute authored transforms. A camera track cannot overlap the same scene’s cameraMotion. Actor-only presets may coexist with camera motion.

Audio cues contain `{atMs,cue,action?,channel?,loop?}` and reuse registered audio assets. Frame-zero cues fire on activation; forward traversal fires cues in `(previousTime,nextTime]`, ordered by time then declaration order. Completion samples the endpoint and endpoint cues, removes the active timeline, and holds the final pose. Load does not reemit crossed cues; rollback can cross future cues again. Existing persistent channel-intent recovery remains separate from one-shot cue events.

Limits are 128 presets, 60 seconds per preset, 32 actor tracks, 64 frames per motion track and 256 audio cues. These are validation bounds, not measured performance guarantees. Gain curves, audio fades, sample-accurate synchronization and draggable keyframes are outside this increment.

## State and ablation

Active stage data adds only `{id,elapsedMs}`; definitions remain in the story. Inactive stages omit the property, preserving old save shapes. Loading validates preset, elapsed range, targets and sampled pose consistency. Camera/actor poses use existing stage fields. No second timer, copied preset, audio cursor or alternate renderer is introduced. The native fixture compares a running preset with an ordinary cut-only scene, and verifies that cancellation/completion stop motion. Existing clock tests verify demand stops when idle.

## Showcase

Lantern’s replay gallery adds **灯塔合奏 / Lighthouse Ensemble**. One six-second `beacon_sweep` preset drives camera and Mira transforms with wind, bell and relay cues, then is reused on the roof. Existing story instructions, revision six and old revision maps are preserved; the entry is additive and the main save is kept separate by the existing replay mechanism.

## Acceptance

Evidence is under `sdk/.pocket-build/timeline-20261108/`:

- VN SDK: 213 pass / 1,727 assertions; strict core TypeScript passes. Story/localization: 28 pass / 1,608 assertions, including original v1–v5 migration comparisons and parked main-save isolation.
- Editor service + real Playwright Chromium + saved-story pinned build/native: 23 pass. See [Editor details](VISUAL_NOVEL_TIMELINE_EDITOR.md) and `editor-final.log`; screenshot inspected.
- Separate native fixtures for timeline and reveal: 2 pass. The timeline fixture covers actual camera/actor geometry, pause, quick save/load, rollback re-crossing, null cancellation and static cut ablation. Storage is injected process memory, and audio requests alone do not establish codec or speaker output.
- macOS Profile Flutter: `macos-timeline-final.log` exits zero; `flutter-response.json` has all five declared checkpoints: decoded motion, lifecycle pause/resume, real audio decoding, preset reuse, normal store preserved. Actual production audio plugin snapshots report 8,000 ms wind, 2,800 ms bell and 180 ms relay assets with players present. This proves decoder/transport facts, not human-audible output or sample-accurate sync. Lifecycle is injected through the test binding, not an OS background transition.
- App-layer initial/moving/resumed/near-end/roof captures are retained and visually inspected. Camera full image geometry is reconstructed from the real clipped quad UV span: width 800 → 850.67 → 868.71 logical pixels. Actor bounds change from `[209,109,225,328]` to `[205,86,251,361]`; this bridge check complements the native fixture’s independent track checks. The file named `finished.png` samples a near-end frame within one pixel of baseline, not an exact completion-time proof; endpoint holding is verified by SDK/native fixtures.

The first Flutter attempt incorrectly expected a clipped background quad to overflow the viewport. It was corrected to use UV-derived geometry. A later left-only actor threshold was replaced by the maximum change across the actual actor rectangle, since camera translation, scale and rotation can cancel its left-edge shift. Production runtime/artifacts were unchanged during these test corrections. No failed attempt counts as acceptance.

The accepted Lantern QJBC is 1,152,121 bytes, SHA-256 `41c2d0c00d0db1ecfaae64f32a0f835959f4f4914309ef2ddc2e9d58d6078fa6`. PAK is unchanged at 69,216,560 bytes, SHA-256 `54c923d8507e1131263ad3c1e3f705c0386d46faea74f352d60a7a93ac2f3f5e`. Metadata SHA-256 is `ccce742c78ffeba04e917944418ebfbb6231b53695672d16336ff7e55370f4d5`. It uses the retained generated pinned high-resolution tools package via `POCKET_TOOLS_PACKAGE`, preserving original assets. No Live2D quality work was performed; the user deferred it.

This increment leaves S04 partially accepted. Windows, iOS/Android timeline execution, physical devices and end-to-end performance remain unverified.

## Ordinary Demo and limits

The normal `lib/main.dart` Profile app is `sdk/.pocket-build/lantern-playable-timeline-20261108/pocket_host.app`, PID7621. Code signature, exact packaged Lantern assets, runnable main isolate and 800×632 onscreen window were checked; old owned PID63535 was retired after readiness. The editor was not opened for the ordinary Demo, and normal user storage was not cleared. AppKit reports `com.apple.loginwindow` frontmost, so user-visible foreground pixels are unverified; no unlock was attempted.

Final feature-tour regression against the exact candidate passes 4/4 (`feature-tour-final.log`). The additional title replay button moves later menu items below the phone viewport; the test now performs a real drag and verifies movement before tapping the gallery. An earlier concurrent regression also missed the short fade window; five isolated phone runs and the final serial full run passed without dropping the fade/input assertion. That timing sensitivity remains documented rather than called an engine regression.

Timeline reduced-motion target-pose presentation has not been added; existing cameraMotion reduction does not establish timeline accessibility behavior. Audio envelopes, draggable keyframes and all-platform/performance acceptance remain follow-up work. The full 54-group goal is still active, with 9 passed / 34 partial / 11 pending groups.
