# Visual novel grouped audio mix

## Source-first migration and retained behavior

I inspected the retained parent demo at `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`, excluding `pocket_host/`. The root `pocketjs_super_app_demo.html:923-953` has a browser Web Audio oscillator (`playSynthTone`) and a mute toggle. It does not provide asset-backed playback, per-channel gain or native lifecycle handling. The retained `lib/native/mini_apps/` source likewise does not define an asset audio capability; [`VISUAL_NOVEL_AUDIO.md`](VISUAL_NOVEL_AUDIO.md) records the path audit. The browser-only tone and mute behavior are not reusable as a Pocket Flutter player.

The current host boundary is the bundled WAV allowlist and just_audio provider described in [`VISUAL_NOVEL_AUDIO.md`](VISUAL_NOVEL_AUDIO.md). This change reuses that same `media.audio.volume` capability and its existing per-channel command queue. JS still owns story cue policy, the mix, settings UI and persistence; Dart only applies the volume request to the already-live channel player.

## Mix contract

`createNovelAudioAdapter` owns the canonical validated mix:

```ts
{ master: 0.7, music: 1, effects: 1, voice: 1 }
```

Each gain is finite and normalized to `[0, 1]`; an effective channel gain is `master * group`. `setMix(partial)` returns a copy of the validated value, `getMix()` returns a read-only snapshot, and the existing `setVolume(next)` remains a compatibility alias for changing `master` only. Invalid entries reject the update atomically.

Without authored metadata, channel mapping retains the original rule: exact `music` uses music, `__pocket_vn_voice` uses voice, and ordinary custom channels use effects. The subsequent [music crossfade increment](VISUAL_NOVEL_CROSSFADE.md) adds optional `group: "music" | "effects"` to named play cues/intents, allowing multiple consumer music channels to follow the same music preference. Group is derived from existing intents and replay mappings; there is no second mixer or native category registry. Effective volume also includes an optional authored timeline gain.

When a mix changes, the adapter sends `media.audio.volume` only for a live channel whose effective gain changed. It does not send `play`, reset the position, add a timer or fade. Future loops, voice lines and bounded one-shot channels calculate their initial gain from the same mix. Repeated identical updates are deduplicated against the last requested channel volume.

## Lantern settings and persistence

The Lantern settings page exposes four compact focusable rows for master, music, effects and voice. A row cycles through `0`, `25`, `50`, `75` and `100` percent; the pre-existing `0.7` master default remains `70%` and advances to `75%`. The English locale contains translations for all four row labels.

The app persists the validated object under `lantern.audio.mix` through the existing JS `platform.storage` client. The adapter remains the sole validation and live-channel owner; the Solid signal mirrors the returned mix only to render the current percentages. Restore failures leave defaults in place and surface the existing settings status message.

## Validation

The adapter suite covers default and initial gains, live music/effects/custom/voice updates, group-only changes, deduplication, future channels, compatibility `setVolume`, atomic validation, and the absence of a replay when changing volume:

```sh
bun test sdk/packages/pocket_vn/test/audio.test.ts
```

The guest acceptance uses a compiled Lantern QJBC and `NativeSession`: it starts the existing story, taps the actual settings row, checks the recorded `media.audio.volume` request and unchanged BGM play count, then boots a fresh session with the real JS storage snapshot and checks the restored row. It must run after the repository owner rebuilds Lantern assets:

```sh
bun test demo/js/tests/novel_audio_mix_native.test.ts
```

The Flutter integration mounts the actual Showcase host and `PocketAudioPlugin`, launches Lantern through the catalog, changes the same settings row through guest pointer input, and reads the real just_audio-backed channel's playing state, volume and advancing position through the plugin's local read-only `snapshotChannel()` accessor. That observation does not send another JS capability request or mutate the player:

```sh
cd demo
flutter test integration_test/novel_audio_mix_test.dart -d macos
```

The native probe verifies guest requests, not audible output. The Flutter test verifies real plugin state on the selected runner, not a human listening check or every target. Windows remains unclaimed until that platform is actually run.

## Accepted artifact and actual runs

The source-built Lantern artifact is 666,736 bytes of QuickJS script bytecode,
with the unchanged pinned ABI
`quickjs-bytecode-v1:5ab2246bcbd64b9d66e396043be05c2f77e7a6ab78e3125c56f8a1f62019a021`:

- QJBC SHA-256: `eff53069db9b967f3d862820bc7caa253f1745bfc2a0651084689d481dedd077`.
- PAK SHA-256: `16574200309ffbd5f40858ae55a34f7e27a6548a30bd07c6d21b66b15b1201fb`.
- Font preparation retained the pinned Noto source and selected 736 characters
  (`/tmp/pocket-f04-audio-font.log`); build log:
  `/tmp/pocket-f04-audio-build.log`.

The four-file native combination passed all five tests in 8.11 seconds
(`/tmp/pocket-f04-audio-native.log`): actual settings pointer input, volume
request without replay, storage restore, new-game variable reset/read-meta
retention and music stop→same-cue replay, player input, voice completion,
locale switching, rollback, and all three endings. Test launch selectors were
corrected to use the actual title caption and the existing scrolling Showcase
launcher; runtime behavior did not change for those test corrections.

The same artifact passed the real PocketAudioPlugin/just_audio integration on:

| Runner | Observed gain / advancing position | Result log |
| --- | --- | --- |
| macOS arm64 | 0.75 / 3,836 ms | `/tmp/pocket-f04-audio-macos.log` |
| iPhone 18 Pro iOS 27.2 arm64 simulator | 0.75 / 3,755 ms | `/tmp/pocket-f04-audio-ios.log` |
| Android API 35 arm64 emulator | 0.75 / 4,303 ms | `/tmp/pocket-f04-audio-android.log` |

Each run checked that position increased by more than 250 ms across the gain
change and that only one native channel remained active. The observer is
`PocketAudioPlugin.snapshotChannel()`, a read-only local projection of existing
player facts. It issues no volume/play request; its package regression verifies
that observing a channel adds no player operations. This avoids letting the
test itself apply the gain it intends to verify. The pinned Flutter 3.47.9
package run passed 17 tests. Core/Editor service regression passed 85 tests and
501 assertions (`/tmp/pocket-f04-audio-core.log`). These results cover the
captured artifact; later source capabilities need a fresh build and acceptance.

## Restart ablation

Lantern now calls the same engine's `newGame()` instead of replacing that
engine. The adapter processes explicit channel-stop facts before reconciling
the final intent, so a new game using the same music cue still stops and
restarts it. Ordinary snapshot updates and volume changes continue to reuse the
current player. A regression covers that stop→same-cue boundary without adding
another queue or audio state machine. The engine factory remains necessary for
locale replacement and startup meta restoration.
