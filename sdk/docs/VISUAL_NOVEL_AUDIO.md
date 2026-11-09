# Pocket visual novel audio provider

## Source-first gap and retained behavior

I inspected the retained parent project `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`, across `mini_apps/`, `lib/`, `native/`, `ios/`, `android/`, `macos/`, and `pubspec.yaml`. Those implementation paths have no `just_audio`, `audioplayers`, `AudioPlayer`, `AVAudioPlayer`, `ExoPlayer`, `MediaPlayer`, or `media.audio` asset-playback boundary. The root `pocketjs_super_app_demo.html` does include a browser-only `playSynthTone` oscillator and mute toggle (around lines 923–953), but it is not a reusable Flutter asset player and has no OS lifecycle bridge. The parent therefore supplies no native asset-playback implementation to migrate; that host boundary is an evidenced gap.

The retained JS game-detail app (`mini_apps/app_game_detail/main.js`) keeps game updates and rendering in JS while requesting host facts through a thin boundary. The audio provider follows that split: JS chooses story cues, channels, loops and when to stop them; Dart only loads an explicitly allowed app asset and calls the audio player. It adds no second story/audio policy, auto mode, queue or cue state machine.

## Public API

Package entry point:

```dart
import 'package:pocket_audio/pocket_audio.dart';

final plugin = PocketAudioPlugin(
  assets: const <String, String>{
    'audio/music_storm.wav': 'assets/apps/lantern/audio/music_storm.wav',
    'audio/station_bell.wav': 'assets/apps/lantern/audio/station_bell.wav',
  },
);
```

The direct constructor above is enough for BGM and sound effects. A story with
`say.voice` also needs to forward `onPlayback` into the same
`PocketViewController` event lane; otherwise auto mode has no real completion
fact and correctly remains waiting. The convenience constructor below forwards
both lifecycle and tagged playback events.

When the host has a `PocketViewController`, the convenience constructor forwards
both lifecycle and tagged playback facts through the existing controller event
lane:

```dart
final plugin = PocketAudioPlugin.forPocketViewController(
  controller,
  assets: const <String, String>{
    'audio/voice_mira_arrival_02.wav':
        'assets/apps/lantern/audio/voice_mira_arrival_02.wav',
  },
);
```

`assets` is a host-owned allowlist mapping stable request keys to Flutter asset bundle paths. Guest requests may only name an exact key from this map; file URLs, network URLs, absolute paths and traversal paths do not pass through to just_audio. The Lantern adapter maps story cue names to keys such as `audio/music_storm.wav`; the Flutter plugin maps that exact key to the asset declared by the app manifest.

The plugin registers five request capabilities: `media.audio.play`, `media.audio.stop`, `media.audio.pause`, `media.audio.resume` and `media.audio.volume`. `play` requires `{channel, asset, loop, volume, paused}` and optionally accepts a short `playbackId`. The reserved VN dialogue channel is `__pocket_vn_voice`; ordinary story audio intents cannot claim it. Other operations use `{channel}`, except volume which also takes `volume`. Channel IDs are short identifiers and are bounded to eight live player controllers. Commands on one channel are serialized; separate channels can make progress independently.

Every successful request returns `accepted`, `playerPresent`, the current just_audio `processingState`, `playing`, `positionMs` and (when known) `durationMs` facts, with the active asset key, volume, loop flag and any asynchronous playback error when available. A synchronous asset-load/play error returns a capability error. The asynchronous `AudioPlayer.play()` completion/error is observed without holding the RPC open; its error is reported in the next response for that channel.

`deactivate` pauses active players. `activate` allows future explicit commands but does not resume playback. An optional `onActiveChanged(bool)` callback reports only actual transitions at these lifecycle methods; an initially active plugin, repeated lifecycle calls, and direct `dispose` do not create synthetic state changes. The callback is a fact bridge, not a playback command. The host can forward it to JS, where the existing audio intent and suspended policy decide whether an explicit resume is appropriate. `stop` releases the channel player; `dispose` stops and releases all remaining players. Replacement loads a new allowlisted source on the existing same-channel player, so one channel never accumulates multiple controllers.

## Dialogue playback facts

Tagged `play` calls emit `media.audio.playback` facts with `channel`,
`playbackId`, `status`, `positionMs`, optional `durationMs`, and optional
`error`. Status changes come from just_audio `playerStateStream`; native player
errors come from `errorStream`. The provider reads the current position and
duration only when one of those events arrives. It does not subscribe to
`positionStream` or poll. Untagged music and sound effects produce no dialogue
events.

State and error subscriptions belong to one channel play generation. The
provider cancels the old subscriptions before replacing a source and before
stopping/releasing a channel, and the remaining asynchronous `play()` Future
callback checks the captured generation. This prevents a delayed completion or
error from an old source from being attached to a newer `playbackId`. Completion
is reported once, then the JS adapter releases the voice channel. Replaying a
line uses a fresh engine token; the provider reloads even the same asset so the
new request starts at the beginning.

Only requests with a `playbackId` attach those state/error subscriptions.
Ordinary BGM/SFX remain on the existing non-blocking `play()` Future error path
and do not add player-state listeners or stream-cancellation work. The
just_audio state mapping is a direct synchronous stream transform, so canceling
a voice generation reaches the source stream without an async-generator wait
layer.

The VN adapter imports `NOVEL_VOICE_CHANNEL` from the package voice contract.
It starts native voice only when the snapshot token changes, stops when voice
becomes null, and asynchronously calls `onVoicePlayback(fact)` for native
facts, request failures, resume failures and unknown cues. Deferring the
callback prevents a `reportVoice()` call from re-entering an engine listener
before its current update has finished. Facts are accepted only for the active
token; completed/error/unavailable tokens do not resume. Engine/menu pause
pauses dialogue only, while host lifecycle suspension still pauses all live
channels. On resume, JS restores looping intents and an unfinished current
voice, never a completed one-shot sound. `setAssets(nextAssets)` swaps the
logical cue map without immediately playing anything. Retained audio intents
include the last resolved asset, so the next engine update replaces a cue if
its localized asset changed and leaves unchanged BGM alone.

For ordinary music and effects, an unregistered cue reports
`onStatus("error", "Unknown audio cue: …")` and does not issue a native
request. Keep that callback on the factory options; the private `play()`
dispatch options only control restart, cancellation and skipped work. The
retained parent `mini_apps/` has no cue-to-asset playback/status adapter to
reuse; its closest example is the standalone oscillator demo described above.

The engine-side voice contract and its auto-wait, replay, save/load and
localization behavior are documented in
[`VISUAL_NOVEL_VOICE.md`](VISUAL_NOVEL_VOICE.md).

## just_audio API basis

This package pins `just_audio: ^0.10.6`, currently the published stable version verified for this implementation. Its official API provides `AudioPlayer.setAsset`, `setLoopMode`, `setVolume`, `pause`, `stop`, `dispose`, `playerState`, `playerStateStream` and `errorStream`. The official API explicitly says `play()` completes only when playback completes, pauses or stops, so this provider launches and observes that future rather than awaiting it as the capability response. Asset support and playback/volume are listed for Android, iOS, macOS, Web, Windows and Linux; this does not certify Pocket integration on every target.

- [just_audio 0.10.6 package and platform support](https://pub.dev/packages/just_audio/versions/0.10.6)
- [AudioPlayer API](https://pub.dev/documentation/just_audio/0.10.6/just_audio/AudioPlayer-class.html)

## Tests and limits

`test/pocket_audio_plugin_test.dart` injects a narrow fake player boundary and exercises capability registration, non-blocking play return, channel/controller reuse, exact asset whitelist rejection, the eight-channel bound, lifecycle fact transitions, optional tagged playback facts, completion, errors, per-generation state-listener cancellation, stale play Future errors, release and input bounds. These tests verify provider logic; they do not prove a device emitted audible sound.

Reproducible package validation:

```sh
cd sdk/packages/pocket_audio
flutter analyze lib test
flutter test test/pocket_audio_plugin_test.dart
```

With the repository-pinned Flutter 3.47.9, `flutter analyze --no-pub lib test` reported no issues and `flutter test --no-pub test/pocket_audio_plugin_test.dart` passed all 16 tests, including tagged state/completion/error facts, resume-generation handling and stale-event release behavior.

The JS policy and token bridge tests also pass:

```sh
bun test sdk/packages/pocket_vn/test/audio.test.ts
```

The current suite passes 20 tests / 103 assertions, covering cue-intent reuse,
token matching, asynchronous facts, missing/unavailable cues, resume failures,
locale asset swaps, grouped gains, reveal sounds, queue bounds and lifecycle
cleanup. The missing-cue regression confirms the error reaches `onStatus`
without dispatching a native player request.

The real macOS provider integration passed with the Demo host's bundled story assets:

```sh
cd demo
flutter test integration_test/novel_audio_test.dart -d macos
```

`demo/integration_test/novel_audio_test.dart` used the real just_audio-backed provider to load a bundled WAV, observed `positionMs` advance, checked that pause held the position, resumed and observed it advance again, then stopped and disposed the plugin and confirmed there were no live channel players. This verifies native loading and player state in the macOS integration runner. It does not include a human listening check, certify every platform, or establish physical-device output/background behavior.

## Foreground recovery and intent ablation

The stronger Android SystemHost game test exposed a real boundary gap: story
save/load, textured model animation and ticker pause/resume worked, but the
real music player's `playing` fact was false after OS foreground recovery.
The native provider had correctly paused it during deactivation; activation
only restored capability availability and supplied no fact to the JS owner.

`PocketAudioPlugin.onActiveChanged` now reports actual activate/deactivate
transitions. The Showcase factory forwards this fact through the existing
controller event lane as `media.audio.activation`; it does not make a playback
decision. `createNovelAudioAdapter` subscribes through the existing HostBridge
and explicitly resumes current looping intents when the provider returns,
unless the JS owner is suspended. Non-looping/transient cues are not replayed
on return. A current unfinished dialogue token may resume through the separate
voice path documented above; completed or stale tokens do not resume.

The adapter retains one copy of each three-field intent (`action`, `cue`,
`loop`) and compares those fields directly. This removes per-snapshot JSON
serialization and the retained serialized signature. It shares the existing
per-channel command queue, unsubscribes on disposal, and neither polls native
state nor adds a Dart playback state machine. The JS regression verifies
resumption, suspension, stopped-intent behavior, transient-cue exclusion and
listener cleanup. The strengthened macOS SystemHost game test now passes with
the real provider: music is playing before backgrounding and after foreground
recovery, alongside model pixels, keyboard interaction, save/load and animation
lifecycle (`/tmp/pocket-novel-macos-complete-final.log`). Independent post-fix
iOS and Android simulator runs also pass the strengthened test, including the
same real-player recovery assertion (`/tmp/pocket-novel-ios-music-final.log`,
`/tmp/pocket-novel-android-music-final.log`). These are simulator results, not
physical-device or audible-output certification.

The historical music lifecycle passes above predate single-line playback fact
subscriptions. The first combined macOS run exposed a music command timeout
following foreground recovery. Removing untagged state/error subscriptions and
the async* await-for conversion layer resolved that path in the final combined
acceptance: `novel_platform_test.dart` passes on macOS, iOS 27.2 simulator and
Android API 35 ARM64 emulator. Each run exercises real voice pause/resume,
replay, native completion advancing QJBC auto mode, manual save/load, textured
model animation and music recovery. Final logs are
`/tmp/pocket-voice-game-macos-final.log`,
`/tmp/pocket-voice-game-ios-final.log`, and
`/tmp/pocket-voice-game-android-final.log` (1 pass each). The final macOS direct
WAV transport/completion test also passes both cases in
`/tmp/pocket-voice-macos-native-final.log`. Physical mobile devices, Windows
runtime and audible output through a particular speaker remain unverified.
