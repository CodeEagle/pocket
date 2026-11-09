# Timeline audio gain envelopes

## Source-first scope

The retained `../pocketjs_flutter_demo/pocketjs_super_app_demo.html:925–940` (excluding `pocket_host/`) creates a WebAudio GainNode, sets gain 0.08 and exponentially ramps a synthesized tone to 0.001 before stopping it. This demonstrates per-tone decay; it contains no serializable narrative channel envelope or native volume transport. The adaptation uses the existing VN timeline sampler/clock, audio intents and JS audio adapter. The existing `PocketAudioPlugin` already exposes `media.audio.volume` and native decoder facts; no Dart narrative scheduler is added.

## Contract

A timeline may contain `audioGains: [{channel,keyframes:[{atMs,value,easing?}]}]`. Gains are finite 0..1, and use the existing destination-frame `linear` / `easeInOut` interpolation. Tracks begin at zero, have strictly increasing integer times within the preset duration, and are limited to 32 distinct channels and 64 keyframes per track. Channels follow the existing native provider’s identifier grammar and 64-character bound; the dialogue voice channel is reserved. An authored track count is not a simultaneous player guarantee: the bundled provider retains its existing **eight-channel budget**, shared with music, voice, effects and text sounds.

The engine samples only currently playing named intents; a track may wait for a future cue on that channel. Frame-zero and crossed cues apply before gain sampling. Gain is stored as optional `audioIntents[channel].gain`, with omitted gain meaning one. There is no parallel gain state, audio cursor or second timer. At preset completion/cancellation the current intent holds its gain until a subsequent play/stop. An explicit play outside an active gain track resets gain to one; inside an active track it immediately takes that track’s current sampled gain. Saves/checkpoints validate gain bounds and its consistency with active timeline time; old absent fields retain their shape.

The adapter computes `master × group × authored gain`. Pure gain changes use volume transport, without replaying or replacing the audio source. Per-channel volume transport coalesces pending updates to the latest value, retaining the current in-flight request rather than accumulating a frame-sized promise chain. Replay named channels have isolated, native-valid transport identities and are released when stopped or when leaving the replay. Dialogue voice and the existing music-preview ownership mechanism remain separate. These policies run in JS, using the registered native provider for IO only.

## Demo

The existing “灯塔合奏 / Lighthouse Ensemble” entry gains a second movement. A six-second `harbor_crescendo` preset fades the wind 0 → .85 → .4 → 0, with a bell between the waves and an authored stop at the end. An explicit following stop also handles early advancement. No existing instruction is reordered; the preset and three localized lines are additive. The main save remains isolated through the existing replay engine.

## Validation status

Final evidence is in `sdk/.pocket-build/timeline-gain-20261108/`:

- `vn-final-frozen.log`: 226 SDK tests / 1,848 assertions; strict source TypeScript passes. `story-locales-final.log`: 29 story/localization tests / 1,622 assertions, including strict old revision maps and main-save isolation.
- `audio-suite.log`: 27 audio tests. The slow-host case blocks the first volume call, applies 79 newer gain values, and observes only two volume requests (in-flight 0.14, latest 0.693) with a single play. Gain-free and fixed-gain controls send no extra volume/play requests. The redundant reverse channel map was removed; the existing mapping is scanned only on allocation. These are functional/queue bounds, not an FPS claim.
- `editor/final.log`: 23 service/browser tests. Actual Playwright Chromium authors 0→1→0, edits times/markers, adds/deletes tracks/frames, uses undo/redo, renames the referenced preset, saves/reopens, then compiles the saved story with pinned buildGuest. Actual NativeSession pointer input produces one `harbor-wind` play and volume requests reaching zero without replay. Screenshot, saved story, accepted QJBC/PAK/metadata, final audio source hash and native requests are retained in `editor/`. The initial fixture lacked an audio adapter subscription; that test wiring was corrected before final acceptance.
- `macos-gain-final.log` and `flutter-response.json`: all **seven** declared checks complete, covering the original decoded motion/lifecycle/cue/preset/store checks plus gain automation and early replay exit. The real production native player yields 142 snapshots: volume 0.003421→0.594951→0.000191 (expected peak .7×.85=.595), position 34→5,948 ms without retreat, followed by player release. A second replay exits while the gain channel is playing and verifies release. Awaiting official session close also proves zero native audio channels before temporary-directory cleanup. Human-audible output was not independently listened to.
- `native-regression-final.log`: six actual pinned-QJBC cases pass across the feature tour, timeline and reveal fixtures. The full eight-category route uses this exact Lantern candidate. `flutter-analyze-final.log` and `git diff --check` pass.

The first diagnostic Flutter attempt completed the six feature checks but failed while deleting its isolated directory: widget disposal had scheduled asynchronous storage writes. The test now captures the real system sessions and awaits their existing `close()` boundaries after widget disposal, before restoring/deleting the isolated path. No SDK shutdown API or deletion retry was added; no failed attempt counts as acceptance.

The accepted Lantern QJBC is 1,160,990 bytes, SHA-256 `23aecb9060b0ae6446474838037dda4954532104ecf2ef26d93c9c6f4e7fb71b`; PAK remains 69,216,560 bytes, SHA-256 `54c923d8507e1131263ad3c1e3f705c0386d46faea74f352d60a7a93ac2f3f5e`; metadata SHA-256 `c42e21f513058ce46f7634c12084f5dd7a916ddd956f3a8c346cda9a863a9be2`. The retained high-resolution pinned compiler package is supplied through `POCKET_TOOLS_PACKAGE`; original textures are unchanged.

Human-audible output, sample-accurate synchronization, iOS/Android/Windows execution and end-to-end performance require separate evidence. Preset track counts do not raise the native eight-player limit. At this historical checkpoint, drag editing and timeline reduced-motion target presentation were unimplemented; the subsequent [accessibility increment](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md) records their implementation and actual evidence. Live2D clarity remains deferred by user instruction. The full 54-group goal stays active.

Adapter-owned transient pool identities (`effect-0`…`effect-3`), text-sound transport and `music-preview` should not be used as authored automation targets. The original envelope checkpoint rejected dialogue voice only. The subsequent [timeline accessibility increment](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md) also rejects the four transient pool identities and `music-preview` at the shared schema boundary. Ordinary consumer channels such as `harbor-wind` and the logical `music` bus are covered by this increment.

## Ordinary Demo

At the original envelope checkpoint, the normal `lib/main.dart` Profile app was `sdk/.pocket-build/lantern-playable-timeline-gain-20261108/pocket_host.app`, PID44175. Code signature, exact Lantern QJBC/PAK/metadata/manifest, runnable main isolate and 800×632 onscreen window were verified. Old owned PID7621 was retired only after readiness. The normal Demo opens without the editor and user storage was not cleared. AppKit still reports `com.apple.loginwindow` frontmost; foreground visibility is not established and no unlock was attempted. `final-acceptance-manifest.json` records the frozen sources, artifacts and logs. The full goal remains 9 passed / 34 partial / 11 pending groups.

Current ordinary Demo and subsequent validation are recorded in [timeline accessibility](VISUAL_NOVEL_TIMELINE_ACCESSIBILITY.md).

The subsequent [cross-track music increment](VISUAL_NOVEL_CROSSFADE.md) reuses these envelopes with explicitly grouped named music cues and an additional playable replay.
