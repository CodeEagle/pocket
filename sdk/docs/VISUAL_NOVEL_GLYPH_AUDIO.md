# Visual Novel Synthesized Text Cues

## Source-first reuse

The retained parent demo at
`/Volumes/ORICO/Development/Github/pocketjs_flutter_demo/pocketjs_super_app_demo.html`
uses `playSynthTone` around lines 923–952 for short menu and interaction
feedback. Its call sites are menu/game actions; it does not attach a cue to
visible dialogue progress and has no TTS path. The old `pocket_host/`
subdirectory was not used.

Lantern keeps the parent's synthesized-feedback idea, but routes it through
the existing novel audio adapter and host allowlist. The JS adapter observes
real `SayState.revealProgress` / `revealedCharacters` updates and the
authored text speed; it does not run a timer or create a second audio engine.
Generated 45 ms WAV cues use the existing four-channel effects pool and effects
gain. Settings default to off and use the existing JS storage boundary.

## Authored profile

`novel.assets.json` has the optional `textSounds` object:

```json
{
  "defaultCue": "text_narrator",
  "speakers": {
    "Mira": "text_mira",
    "Ren": "text_ren"
  },
  "minIntervalMs": 100
}
```

The pure `text-sounds.ts` validator checks the object shape, cue IDs,
registered audio references, speaker keys, and the 40–1000 ms interval bounds.
It is re-exported from `@pocket/vn/audio` for consumers and the editor.

The adapter emits one cue at most per engine update, only after visible
non-whitespace text grows. Fractional reveal progress accumulates even on
frames that do not add a whole code point, keeping the pacing stable at
different virtual frame steps. It suppresses instant text, skip, reveal-all
jumps, paused dialogue and host suspension. A single in-flight cue bounds
backpressure; a cue still waiting in a channel command queue is canceled if
its reveal generation becomes stale before the native request is sent.
Disabling, pause, skip, line changes, and suspension reset or invalidate that
pending work. Completed samples are not replayed on lifecycle resume.

## Asset provenance

`demo/js/apps/lantern/scripts/generate_audio.ts` generates
`text_narrator.wav`, `text_mira.wav`, and `text_ren.wav` deterministically
as PCM16 mono, 22050 Hz samples. These are distinct soft sine/triangle tones,
not speech, TTS or recorded voices. The Lantern `PocketAudioPlugin` allowlist
contains only the exact generated cue paths; Dart does not choose speakers,
track text progress, or schedule sounds.

## Validation

- `bun test sdk/packages/pocket_vn/test`: 86 tests / 593 assertions passed,
  including fractional 8/16/32 ms progress, whitespace, reveal-all, skip,
  pause, suspension, cue pool reuse, dispatch cancellation, and preservation
  of volume tracking for already-live channels.
- `flutter analyze lib/main.dart integration_test/novel_text_sounds_test.dart`
  (pinned Flutter 3.47.9): passed.
- The editor integration was exercised through browser editing, save/reopen,
  invalid profile rejection, pinned `buildGuest`, and a real NativeSession
  cue request selecting the authored speaker asset. It verifies the QJBC
  request and gain boundary, not audio decoding.
- The compiled Lantern glyph test plus audio-mix/new-game native regressions
  passed 3 tests in 2.87 seconds (`/tmp/pocket-a04-restart-native.log`). These
  validate QJBC requests, not a simulated decoder.

## Repeated-sample ablation and native playback

The first real macOS run decoded the 45 ms sample (native duration 44 ms),
but a stronger check exposed that calling `play()` again on its completed
player never rewound it. The old QJBC
`e16b6c4594a0b6631278866b5a50a24f478540584eabe3c020128fec937c1efa`
failed this regression (`/tmp/pocket-a04-before-restart-macos.log`).
[just_audio's documented completion behavior](https://pub.dev/documentation/just_audio/latest/)
explains why `playing: true` alone is insufficient: the player stays at the
end until it seeks.

The existing `media.audio.play` boundary now accepts optional `restart: true`.
JS sends it for explicit transient/replay requests; native seeks to zero on a
reused source rather than reloading it or allocating a player. Ordinary
pause/resume and gain changes keep their positions. The provider's 19 tests
passed, including one decoded source/one player across repeated cues, no
stop/reload, a fresh voice playback identity without another decode, and position-preserving resume
(`/tmp/pocket-a04-native-audio-plugin.log`).

The corrected checkpoint uses QJBC
`fbdbf1e6162e209d2e3bd784795d955660556019fcb6bcdb76f27b63bc5a2440`
(690,993 bytes), unchanged PAK
`e02a1bb382b7d76a7d5e704f08e710eaa76c4f1d8e3c34b7b6e4786af6f72a45`,
and the unchanged pinned QuickJS ABI. Actual macOS and iOS 27.2 simulator
runs observed the same effect channel complete at 44 ms, then return to
ready playback at 4 ms and 10 ms respectively; both passed disable/lifecycle
checks. Logs: `/tmp/pocket-a04-after-restart-macos.log` and
`/tmp/pocket-a04-after-restart-ios.log`. Android API 35 passed the stronger
ready-state/advancing-position check at 30 ms after completion, with the same
44 ms decoded duration (`/tmp/pocket-a04-after-restart-android.log`). All three
passed disabling and lifecycle-return checks. Windows and physical-device
runs remain unverified.

The test normalizes previously persisted toggles and gain through the game's
settings controls, then waits for actual asset and duration facts. Channel
allocation before `setAsset` finishes is not treated as decode success.

The Flutter integration uses the real `PocketAudioPlugin` and its read-only
player snapshot to check the generated sample asset, duration and gain, then
exercises plugin lifecycle activation. Simulator/device text-to-speech
candidate-window behavior is outside this feature: these short tonal WAVs do
not open a keyboard or speech surface.
