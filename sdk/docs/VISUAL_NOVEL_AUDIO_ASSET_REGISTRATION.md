# Visual novel audio asset registration

## Retained source and the current boundary

Source-first review of `/Volumes/ORICO/Development/Github/pocketjs_flutter_demo`
excluded `pocket_host/`. The retained
[`pocketjs_super_app_demo.html`](../../../pocketjs_flutter_demo/pocketjs_super_app_demo.html)
contains a browser Web Audio oscillator and mute toggle around lines 923–953;
it does not register bundled audio files or provide a native asset player.
The retained `mini_apps/app_game_detail/main.js` keeps game behavior in
JavaScript but has no audio asset registry. There is no parent Flutter asset
allowlist implementation to port.

The SDK already has one playback boundary in
[`pocket_audio_plugin.dart`](../packages/pocket_audio/lib/src/pocket_audio_plugin.dart):
JS sends a logical asset key to the host, the plugin resolves a Flutter bundle
path, and the existing per-channel queue loads that path through just_audio.
This change reuses that plugin, queue, player and error path. It removes the
Showcase's duplicate list of thirteen cue-to-identical-path entries; it does
not add a second manifest, player or playback state.

## Registration choices

Existing exact maps remain supported:

```dart
PocketAudioPlugin.forPocketViewController(
  controller,
  assets: const <String, String>{
    'audio/music_storm.wav': 'assets/apps/lantern/audio/music_storm.wav',
  },
);
```

Consumers whose request keys match their bundle directory can use
`assetPrefix` instead:

```dart
PocketAudioPlugin.forPocketViewController(
  controller,
  assetPrefix: 'assets/apps/lantern/',
);
```

For a request key `audio/music_storm.wav`, the plugin asks just_audio to load
`assets/apps/lantern/audio/music_storm.wav`. The request still reports and
returns the logical key, so the JS cue registry remains the single cue-name
source. If both styles are configured, an exact `assets` entry wins; an
unmapped safe key can then fall back to the prefix.

The prefix is a Flutter bundle directory, not a filesystem path or URL. It
must be relative, end in `/`, and contain only nonempty path segments other
than `.` or `..`. Request keys use the same relative path rules, with a 256
character bound; a prefixed result is additionally limited to 512 characters.
Absolute paths, URI schemes, backslashes, empty segments and traversal are
rejected before a player is created. This prefix intentionally grants access
to safe paths below the configured directory, so consumers should point it at
the narrowest bundle subtree that contains their registered media.

The prefix does not enumerate or check bundle files up front. If a safe path
does not exist or cannot be decoded, the existing player load path returns a
`media.audio.play` capability error (`audio_play_failed`) with the underlying
player failure; it is not reported as successful playback. Explicit maps
continue to validate every request key and bundle path at plugin construction.

Lantern uses `assets/apps/lantern/` because its JS cues are already named as
relative paths such as `audio/music_storm.wav`. The project asset registry and
`demo/pubspec.yaml` remain responsible for which audio files are compiled into
the app bundle. The Flutter host no longer duplicates those JS paths into a
second thirteen-row map in `demo/lib/main.dart`.

## Validation

`pocket_audio_plugin_test.dart` covers prefix resolution, exact-map priority,
invalid prefixes, traversal/URI/backslash request rejection before player
creation, and a missing/invalid bundle asset surfacing as a play error. The
existing tests continue to cover exact maps, playback queues, lifecycle,
channel limits, playback facts and cleanup. With the repository-pinned Flutter
3.47.9, `flutter analyze lib test` reported no issues and the targeted plugin
suite passed all 23 tests:

```sh
cd sdk/packages/pocket_audio
flutter analyze lib test
flutter test test/pocket_audio_plugin_test.dart
```

The real macOS Profile follow-up used the staged strict v4 Guest
`8defe742…` / PAK `8126d148…`:

- `novel_audio_test.dart`: two cases passed in 15 seconds. The voiced-line
  case uses `assetPrefix` and received actual completion at 13,601/13,601 ms;
  the second case retains an explicit map and validates real WAV transport.
  Log: `/tmp/pocket-lantern-v4-prefix-audio.log`.
- `novel_replay_music_test.dart`: passed in 8 seconds through the ordinary
  Lantern factory. Main music resumed at 2,983 ms, the preview player was
  released and isolated main progress was preserved.
  Log: `/tmp/pocket-lantern-v4-prefix-replay-music.log`.

`python3 sdk/scripts/check_architecture.py` passes with the host entry at
89 lines. No keyboard mapping, native model plugin or memory policy was
removed to meet that limit. These are macOS/native playback facts, not
physical-phone audio or cold-start/memory acceptance.
