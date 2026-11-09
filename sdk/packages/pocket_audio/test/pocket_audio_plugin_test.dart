import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_audio/pocket_audio.dart';
import 'package:pocket_services/pocket_services.dart';

void main() {
  const assets = <String, String>{
    'storm': 'assets/audio/storm.wav',
    'letter': 'assets/audio/letter.wav',
    'bell': 'assets/audio/bell.wav',
    'audio/music_storm.wav': 'assets/audio/storm.wav',
  };

  late List<_FakeAudioPlayer> players;
  late List<bool> activeChanges;
  late List<Map<String, Object?>> playbackFacts;
  late PocketAudioPlugin plugin;
  Completer<void>? playGate;

  setUp(() {
    players = <_FakeAudioPlayer>[];
    activeChanges = <bool>[];
    playbackFacts = <Map<String, Object?>>[];
    playGate = null;
    plugin = PocketAudioPlugin(
      assets: assets,
      onActiveChanged: activeChanges.add,
      onPlayback: playbackFacts.add,
      playerFactory: () {
        final player = _FakeAudioPlayer();
        player.playCompleter = playGate;
        players.add(player);
        return player;
      },
    );
  });

  tearDown(() async {
    await plugin.dispose();
  });

  test('registers five bounded request capabilities', () {
    final registry = PocketHostRegistry();
    final context = PocketPluginContext(
      plugin: plugin.descriptor,
      appId: 'test.audio',
      sessionId: 'audio-session',
      registry: registry,
    );

    plugin.register(context);

    expect(context.registeredCapabilities, <String>{
      pocketAudioPlayCapability,
      pocketAudioStopCapability,
      pocketAudioPauseCapability,
      pocketAudioResumeCapability,
      pocketAudioVolumeCapability,
    });
    expect(
      plugin.descriptor.limits.maxConcurrentRequests,
      pocketAudioMaxChannels,
    );
    expect(plugin.descriptor.toJson()['capabilities'], hasLength(5));
    context.dispose();
  });

  test(
    'play returns accepted player facts without waiting for track completion',
    () async {
      final completion = Completer<void>();
      playGate = completion;
      final resultFuture = plugin.play(
        _playRequest(channel: 'music', asset: 'storm'),
      );
      final result = await resultFuture.timeout(
        const Duration(milliseconds: 250),
      );

      expect(result, containsPair('accepted', true));
      expect(result, containsPair('playerPresent', true));
      expect(result, containsPair('channel', 'music'));
      expect(result, containsPair('asset', 'storm'));
      expect(result, containsPair('playing', true));
      expect(result, containsPair('processingState', 'ready'));
      expect(result, containsPair('durationMs', 1000));
      expect(result, containsPair('volume', 0.7));
      expect(result, containsPair('loop', true));
      expect(players, hasLength(1));
      expect(players.single.operations, <String>[
        'volume:0.7',
        'loop:true',
        'asset:assets/audio/storm.wav',
        'play',
      ]);
      completion.complete();
    },
  );

  test(
    'explicit repeated transient play rewinds without reloading or replacing its player',
    () async {
      await plugin.play(
        _playRequest(channel: 'effect-0', asset: 'bell', loop: false),
      );
      final player = players.single;
      player.positionMs = 1000;
      player._processingState = 'completed';
      final operationCount = player.operations.length;

      final result = await plugin.play({
        ..._playRequest(channel: 'effect-0', asset: 'bell', loop: false),
        'restart': true,
      });

      expect(players, hasLength(1));
      expect(result, containsPair('positionMs', 0));
      expect(player.operations.sublist(operationCount), [
        'volume:0.7',
        'seek:0',
        'play',
      ]);
      expect(
        player.operations.where((value) => value.startsWith('asset:')),
        hasLength(1),
      );
      expect(player.stopCalls, 0);

      player.positionMs = 450;
      await plugin.pause({'channel': 'effect-0'});
      await plugin.resume({'channel': 'effect-0'});
      expect(
        player.positionMs,
        450,
        reason: 'resume must preserve the existing playhead',
      );
      expect(
        player.operations.where((value) => value.startsWith('seek:')),
        hasLength(1),
      );
    },
  );

  test(
    'explicit voice restart reuses decoded audio and binds only the new playback identity',
    () async {
      await plugin.play({
        ..._playRequest(
          channel: '__pocket_vn_voice',
          asset: 'letter',
          loop: false,
          playbackId: 'voice-old',
        ),
        'restart': true,
      });
      final player = players.single;
      player.positionMs = 1000;
      player._processingState = 'completed';
      final operationCount = player.operations.length;

      await plugin.play({
        ..._playRequest(
          channel: '__pocket_vn_voice',
          asset: 'letter',
          loop: false,
          playbackId: 'voice-new',
        ),
        'restart': true,
      });
      player.emitState('playing');
      await Future<void>.delayed(Duration.zero);
      expect(player.operations.sublist(operationCount), [
        'volume:0.7',
        'seek:0',
        'play',
      ]);
      expect(players, hasLength(1));
      expect(
        player.operations.where((value) => value.startsWith('asset:')),
        hasLength(1),
      );
      expect(playbackFacts, hasLength(1));
      expect(playbackFacts.single, containsPair('playbackId', 'voice-new'));
      expect(playbackFacts.single, containsPair('positionMs', 0));
    },
  );

  test('replaces one channel asset on its existing player', () async {
    await plugin.play(_playRequest(channel: 'music', asset: 'storm'));
    final player = players.single;

    final result = await plugin.play(
      _playRequest(
        channel: 'music',
        asset: 'letter',
        loop: false,
        volume: 0.35,
      ),
    );

    expect(players, hasLength(1));
    expect(result, containsPair('asset', 'letter'));
    expect(player.operations, <String>[
      'volume:0.7',
      'loop:true',
      'asset:assets/audio/storm.wav',
      'play',
      'volume:0.35',
      'stop',
      'loop:false',
      'asset:assets/audio/letter.wav',
      'play',
    ]);
  });

  test(
    'tagged dialogue reports player state, completion and duration facts',
    () async {
      await plugin.play(
        _playRequest(
          channel: '__pocket_vn_voice',
          asset: 'letter',
          loop: false,
          playbackId: 'voice-12-4',
        ),
      );
      final player = players.single;
      player.positionMs = 260;
      player.durationMs = 900;
      player.emitState('playing');
      player.emitState('paused');
      player.positionMs = 900;
      player.emitState('completed');
      // Terminal state clears the request ID; later events cannot revive it.
      player.emitState('playing');
      await Future<void>.delayed(Duration.zero);

      expect(playbackFacts, <Map<String, Object?>>[
        <String, Object?>{
          'channel': '__pocket_vn_voice',
          'playbackId': 'voice-12-4',
          'status': 'playing',
          'positionMs': 260,
          'durationMs': 900,
        },
        <String, Object?>{
          'channel': '__pocket_vn_voice',
          'playbackId': 'voice-12-4',
          'status': 'paused',
          'positionMs': 260,
          'durationMs': 900,
        },
        <String, Object?>{
          'channel': '__pocket_vn_voice',
          'playbackId': 'voice-12-4',
          'status': 'completed',
          'positionMs': 900,
          'durationMs': 900,
        },
      ]);
    },
  );

  test('replacement and release ignore old play Future errors', () async {
    final oldPlay = Completer<void>();
    playGate = oldPlay;
    await plugin.play(
      _playRequest(
        channel: '__pocket_vn_voice',
        asset: 'letter',
        loop: false,
        playbackId: 'voice-old',
      ),
    );
    final player = players.single;

    final newPlay = Completer<void>();
    player.completePlayOnStop = false;
    player.playCompleter = newPlay;
    await plugin.play(
      _playRequest(
        channel: '__pocket_vn_voice',
        asset: 'bell',
        loop: false,
        playbackId: 'voice-new',
      ),
    );
    oldPlay.completeError(StateError('old source completed with error'));
    await Future<void>.delayed(Duration.zero);
    expect(playbackFacts, isEmpty);

    expect(player.activeStateListeners, 1);
    expect(player.activeErrorListeners, 1);
    player.emitState('playing');
    await Future<void>.delayed(Duration.zero);
    expect(playbackFacts, hasLength(1));
    expect(playbackFacts.single, containsPair('playbackId', 'voice-new'));

    newPlay.complete();
    player.onStop = () => player.emitState('completed');
    await plugin.stop(<String, dynamic>{'channel': '__pocket_vn_voice'});
    await Future<void>.delayed(Duration.zero);
    expect(playbackFacts, hasLength(1));
    expect(player.activeStateListeners, 0);
    expect(player.activeErrorListeners, 0);
    expect(player.disposed, isTrue);
  });

  test('ordinary untagged playback emits no voice facts', () async {
    await plugin.play(_playRequest(channel: 'music', asset: 'storm'));
    expect(players.single.activeStateListeners, 0);
    expect(players.single.activeErrorListeners, 0);
    players.single.emitState('playing');
    players.single.emitState('completed');
    await plugin.pause(<String, dynamic>{'channel': 'music'});
    await plugin.resume(<String, dynamic>{'channel': 'music'});
    expect(players.single.activeStateListeners, 0);
    expect(players.single.activeErrorListeners, 0);
    expect(playbackFacts, isEmpty);
  });

  test('tagged asynchronous player errors are terminal facts', () async {
    await plugin.play(
      _playRequest(
        channel: '__pocket_vn_voice',
        asset: 'letter',
        loop: false,
        playbackId: 'voice-error',
      ),
    );
    expect(players.single.activeStateListeners, 1);
    expect(players.single.activeErrorListeners, 1);
    players.single.emitError(StateError('decoder failed'));
    await Future<void>.delayed(Duration.zero);
    players.single.emitError(StateError('late player error'));
    await Future<void>.delayed(Duration.zero);

    expect(playbackFacts, hasLength(1));
    expect(playbackFacts.single, containsPair('playbackId', 'voice-error'));
    expect(playbackFacts.single, containsPair('status', 'error'));
    expect(
      playbackFacts.single,
      containsPair('error', contains('decoder failed')),
    );
  });

  test('resumed tagged playback subscribes to its new generation', () async {
    await plugin.play(
      _playRequest(
        channel: '__pocket_vn_voice',
        asset: 'letter',
        loop: false,
        playbackId: 'voice-resume',
      ),
    );
    await plugin.pause(<String, dynamic>{'channel': '__pocket_vn_voice'});
    players.single.emitState('paused');
    await Future<void>.delayed(Duration.zero);
    await plugin.resume(<String, dynamic>{'channel': '__pocket_vn_voice'});
    expect(players.single.activeStateListeners, 1);
    expect(players.single.activeErrorListeners, 1);
    players.single.emitState('playing');
    players.single.emitState('completed');
    await Future<void>.delayed(Duration.zero);

    expect(playbackFacts.map((fact) => fact['status']), <String>[
      'paused',
      'playing',
      'completed',
    ]);
    await plugin.stop(<String, dynamic>{'channel': '__pocket_vn_voice'});
    expect(players.single.activeStateListeners, 0);
    expect(players.single.activeErrorListeners, 0);
  });

  test('rejects unlisted paths before creating any player', () async {
    for (final asset in <String>[
      '../secret.wav',
      'file:///tmp/secret.wav',
      'https://example.invalid/music.mp3',
    ]) {
      await expectLater(
        plugin.play(_playRequest(channel: 'music', asset: asset)),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'audio_asset_denied',
          ),
        ),
      );
    }
    expect(players, isEmpty);

    expect(
      () => PocketAudioPlugin(
        assets: const <String, String>{'escape': '../outside.wav'},
      ),
      throwsArgumentError,
    );
  });

  test(
    'allows a path-like request key only when the exact key is whitelisted',
    () async {
      final result = await plugin.play(
        _playRequest(channel: 'music', asset: 'audio/music_storm.wav'),
      );
      expect(result, containsPair('asset', 'audio/music_storm.wav'));
      expect(players.single.assetPath, 'assets/audio/storm.wav');
    },
  );

  test('resolves safe request keys under a bundle asset prefix', () async {
    final prefixPlayers = <_FakeAudioPlayer>[];
    final prefixPlugin = PocketAudioPlugin(
      assetPrefix: 'assets/apps/lantern/',
      playerFactory: () {
        final player = _FakeAudioPlayer();
        prefixPlayers.add(player);
        return player;
      },
    );
    try {
      final result = await prefixPlugin.play(
        _playRequest(channel: 'music', asset: 'audio/music_storm.wav'),
      );

      expect(result, containsPair('asset', 'audio/music_storm.wav'));
      expect(
        prefixPlayers.single.assetPath,
        'assets/apps/lantern/audio/music_storm.wav',
      );
    } finally {
      await prefixPlugin.dispose();
    }
  });

  test(
    'explicit mapping takes precedence over a configured asset prefix',
    () async {
      final mappedPlayers = <_FakeAudioPlayer>[];
      final mappedPlugin = PocketAudioPlugin(
        assets: const <String, String>{
          'audio/music_storm.wav': 'assets/explicit/storm.wav',
        },
        assetPrefix: 'assets/apps/lantern/',
        playerFactory: () {
          final player = _FakeAudioPlayer();
          mappedPlayers.add(player);
          return player;
        },
      );
      try {
        await mappedPlugin.play(
          _playRequest(channel: 'music', asset: 'audio/music_storm.wav'),
        );

        expect(mappedPlayers.single.assetPath, 'assets/explicit/storm.wav');
      } finally {
        await mappedPlugin.dispose();
      }
    },
  );

  test(
    'asset prefix and request keys reject traversal and non-bundle paths',
    () async {
      for (final prefix in <String>[
        '',
        '/assets/apps/lantern/',
        'assets/apps/../lantern/',
        'assets//apps/lantern/',
        r'assets\apps\lantern\',
        'https://example.invalid/assets/',
        'assets/apps/lantern',
      ]) {
        expect(
          () => PocketAudioPlugin(assetPrefix: prefix),
          throwsArgumentError,
          reason: 'unsafe or non-directory prefix is rejected: $prefix',
        );
      }

      final prefixPlayers = <_FakeAudioPlayer>[];
      final prefixPlugin = PocketAudioPlugin(
        assetPrefix: 'assets/apps/lantern/',
        playerFactory: () {
          final player = _FakeAudioPlayer();
          prefixPlayers.add(player);
          return player;
        },
      );
      try {
        for (final asset in <String>[
          '../private.wav',
          '/private.wav',
          'audio/../private.wav',
          r'audio\private.wav',
          'https://example.invalid/private.wav',
          'audio//private.wav',
        ]) {
          await expectLater(
            prefixPlugin.play(_playRequest(channel: 'music', asset: asset)),
            throwsA(
              isA<PocketCapabilityException>().having(
                (error) => error.code,
                'code',
                'audio_asset_denied',
              ),
            ),
            reason: 'unsafe logical request key is denied: $asset',
          );
        }
        expect(prefixPlayers, isEmpty);
      } finally {
        await prefixPlugin.dispose();
      }
    },
  );

  test(
    'a missing or undecodable prefixed bundle asset is reported as a play error',
    () async {
      final failingPlayers = <_FakeAudioPlayer>[];
      final prefixPlugin = PocketAudioPlugin(
        assetPrefix: 'assets/apps/lantern/',
        playerFactory: () {
          final player = _FakeAudioPlayer()
            ..assetLoadError = StateError('bundle asset is missing or invalid');
          failingPlayers.add(player);
          return player;
        },
      );
      try {
        await expectLater(
          prefixPlugin.play(
            _playRequest(channel: 'music', asset: 'audio/missing.wav'),
          ),
          throwsA(
            isA<PocketCapabilityException>()
                .having((error) => error.code, 'code', 'audio_play_failed')
                .having(
                  (error) => error.message,
                  'message',
                  contains('bundle asset is missing or invalid'),
                ),
          ),
        );
        expect(failingPlayers, hasLength(1));
        expect(failingPlayers.single.assetPath, isNull);
      } finally {
        await prefixPlugin.dispose();
      }
    },
  );

  test('limits controllers to eight and stop releases a slot', () async {
    for (var index = 0; index < pocketAudioMaxChannels; index++) {
      await plugin.play(_playRequest(channel: 'fx-$index', asset: 'bell'));
    }
    expect(plugin.activeChannelCount, pocketAudioMaxChannels);
    expect(players, hasLength(pocketAudioMaxChannels));

    await expectLater(
      plugin.play(_playRequest(channel: 'overflow', asset: 'bell')),
      throwsA(
        isA<PocketCapabilityException>().having(
          (error) => error.code,
          'code',
          'audio_channel_limit',
        ),
      ),
    );

    await plugin.stop(<String, dynamic>{'channel': 'fx-0'});
    expect(players.first.disposed, isTrue);
    expect(plugin.activeChannelCount, pocketAudioMaxChannels - 1);
    await plugin.play(_playRequest(channel: 'overflow', asset: 'bell'));
    expect(plugin.activeChannelCount, pocketAudioMaxChannels);
  });

  test(
    'reports lifecycle transitions without resuming a paused player',
    () async {
      final context = _context(plugin);
      await plugin.play(_playRequest(channel: 'music', asset: 'storm'));
      final player = players.single;
      expect(player.playing, isTrue);

      // The plugin is active at construction, so an idempotent activate call
      // reports no transition.
      await plugin.activate(context);
      expect(activeChanges, isEmpty);

      await plugin.deactivate(context);
      expect(player.playing, isFalse);
      expect(player.pauseCalls, 1);
      expect(activeChanges, <bool>[false]);
      final startsBeforeActivate = player.playCalls;

      // Repeated lifecycle delivery is idempotent at the provider boundary.
      await plugin.deactivate(context);
      expect(player.pauseCalls, 1);
      expect(activeChanges, <bool>[false]);

      await plugin.activate(context);
      expect(activeChanges, <bool>[false, true]);
      await plugin.activate(context);
      expect(activeChanges, <bool>[false, true]);
      expect(player.playCalls, startsBeforeActivate);
      expect(player.playing, isFalse);

      await plugin.resume(<String, dynamic>{'channel': 'music'});
      expect(player.playing, isTrue);
      expect(player.playCalls, startsBeforeActivate + 1);
      expect(activeChanges, <bool>[false, true]);
    },
  );

  test('lifecycle notification failure does not skip native pause', () async {
    final error = StateError('event transport rejected lifecycle fact');
    final failingPlayers = <_FakeAudioPlayer>[];
    plugin = PocketAudioPlugin(
      assets: assets,
      onActiveChanged: (_) => throw error,
      playerFactory: () {
        final player = _FakeAudioPlayer();
        failingPlayers.add(player);
        return player;
      },
    );
    final context = _context(plugin);
    await plugin.play(_playRequest(channel: 'music', asset: 'storm'));
    final player = failingPlayers.single;

    await expectLater(plugin.deactivate(context), throwsA(same(error)));

    expect(player.playing, isFalse);
    expect(player.pauseCalls, 1);
    expect(plugin.isActive, isFalse);
  });

  test(
    'reports asynchronous play Future errors with the next player facts',
    () async {
      final completion = Completer<void>();
      playGate = completion;
      final result = await plugin.play(
        _playRequest(channel: 'music', asset: 'storm'),
      );
      expect(result, isNot(containsPair('error', anything)));

      completion.completeError(StateError('decoder failed'));
      await Future<void>.delayed(Duration.zero);
      final status = await plugin.setVolume(<String, dynamic>{
        'channel': 'music',
        'volume': 0.4,
      });

      expect(status, containsPair('error', contains('decoder failed')));
      expect(status, containsPair('playing', isTrue));
      expect(status, containsPair('processingState', 'ready'));
    },
  );

  test(
    'read-only channel snapshots expose player facts without issuing commands',
    () async {
      await plugin.play(
        _playRequest(channel: 'music', asset: 'storm', volume: 0.35),
      );
      final player = players.single;
      player.positionMs = 420;
      final operations = List<String>.of(player.operations);

      final snapshot = plugin.snapshotChannel('music');
      expect(snapshot, containsPair('playerPresent', true));
      expect(snapshot, containsPair('playing', true));
      expect(snapshot, containsPair('positionMs', 420));
      expect(snapshot, containsPair('volume', 0.35));
      expect(
        player.operations,
        operations,
        reason: 'snapshot reads must not mutate the player',
      );
      expect(
        plugin.snapshotChannel('missing'),
        containsPair('playerPresent', false),
      );
      expect(
        () => plugin.snapshotChannel('music/effects'),
        throwsA(isA<PocketCapabilityException>()),
      );
    },
  );

  test('dispose stops and releases every channel and is idempotent', () async {
    await plugin.play(_playRequest(channel: 'music', asset: 'storm'));
    await plugin.play(_playRequest(channel: 'ambience', asset: 'bell'));
    final active = List<_FakeAudioPlayer>.of(players);

    await plugin.dispose();
    await plugin.dispose();

    expect(plugin.activeChannelCount, 0);
    expect(active.every((player) => player.disposed), isTrue);
    expect(active.every((player) => player.stopCalls == 1), isTrue);
    expect(activeChanges, isEmpty);
  });

  test('validates short channel names and volume range', () async {
    await expectLater(
      plugin.play({
        ..._playRequest(channel: 'effect-0', asset: 'bell'),
        'restart': 'yes',
      }),
      throwsA(isA<PocketCapabilityException>()),
    );
    await expectLater(
      plugin.play(_playRequest(channel: 'music/effects', asset: 'bell')),
      throwsA(isA<PocketCapabilityException>()),
    );
    await expectLater(
      plugin.play(_playRequest(channel: 'music', asset: 'bell', volume: 1.1)),
      throwsA(isA<PocketCapabilityException>()),
    );
    await expectLater(
      plugin.play(
        _playRequest(
          channel: '__pocket_vn_voice',
          asset: 'letter',
          playbackId: '../stale',
        ),
      ),
      throwsA(isA<PocketCapabilityException>()),
    );
    expect(players, isEmpty);
  });
}

Map<String, dynamic> _playRequest({
  required String channel,
  required String asset,
  bool loop = true,
  double volume = 0.7,
  bool paused = false,
  String? playbackId,
}) => <String, dynamic>{
  'channel': channel,
  'asset': asset,
  'loop': loop,
  'volume': volume,
  'paused': paused,
  if (playbackId != null) 'playbackId': playbackId,
};

PocketPluginContext _context(PocketAudioPlugin plugin) => PocketPluginContext(
  plugin: plugin.descriptor,
  appId: 'test.audio',
  sessionId: 'audio-session',
  registry: PocketHostRegistry(),
);

final class _FakeAudioPlayer implements PocketAudioPlayer {
  _FakeAudioPlayer() {
    _stateController = StreamController<PocketAudioPlayerState>.broadcast(
      onListen: () => activeStateListeners++,
      onCancel: () => activeStateListeners--,
    );
    _errorController = StreamController<Object>.broadcast(
      onListen: () => activeErrorListeners++,
      onCancel: () => activeErrorListeners--,
    );
  }

  int activeStateListeners = 0;
  int activeErrorListeners = 0;
  late final StreamController<PocketAudioPlayerState> _stateController;
  late final StreamController<Object> _errorController;
  final List<String> operations = <String>[];
  String? assetPath;
  bool looping = false;
  bool disposed = false;
  bool _playing = false;
  String _processingState = 'idle';
  double _volume = 1;
  Completer<void>? playCompleter;
  bool completePlayOnStop = true;
  int playCalls = 0;
  int pauseCalls = 0;
  int stopCalls = 0;
  int positionMs = 0;
  int? durationMs = 1000;
  void Function()? onStop;
  Object? assetLoadError;

  @override
  Stream<PocketAudioPlayerState> get stateStream => _stateController.stream;

  @override
  Stream<Object> get errorStream => _errorController.stream;

  @override
  bool get playing => _playing;

  @override
  Duration get position => Duration(milliseconds: positionMs);

  @override
  Duration? get duration =>
      durationMs == null ? null : Duration(milliseconds: durationMs!);

  @override
  String get processingState => _processingState;

  @override
  double get volume => _volume;

  @override
  Future<void> setAsset(String assetPath) async {
    _ensureOpen();
    if (assetLoadError case final error?) throw error;
    this.assetPath = assetPath;
    _processingState = 'ready';
    operations.add('asset:$assetPath');
  }

  @override
  Future<void> setLooping(bool loop) async {
    _ensureOpen();
    looping = loop;
    operations.add('loop:$loop');
  }

  @override
  Future<void> setVolume(double volume) async {
    _ensureOpen();
    _volume = volume;
    operations.add('volume:$volume');
  }

  @override
  Future<void> seek(Duration position) async {
    _ensureOpen();
    positionMs = position.inMilliseconds;
    _processingState = 'ready';
    operations.add('seek:$positionMs');
  }

  @override
  Future<void> play() {
    _ensureOpen();
    _playing = true;
    _processingState = 'ready';
    playCalls++;
    operations.add('play');
    return playCompleter?.future ?? Future<void>.value();
  }

  @override
  Future<void> pause() async {
    _ensureOpen();
    _playing = false;
    pauseCalls++;
    operations.add('pause');
  }

  @override
  Future<void> stop() async {
    if (disposed) return;
    _playing = false;
    _processingState = 'idle';
    stopCalls++;
    operations.add('stop');
    onStop?.call();
    final pending = playCompleter;
    if (completePlayOnStop && pending != null && !pending.isCompleted) {
      pending.complete();
    }
  }

  @override
  Future<void> dispose() async {
    if (disposed) return;
    disposed = true;
    _playing = false;
    operations.add('dispose');
    await _stateController.close();
    await _errorController.close();
  }

  void _ensureOpen() {
    if (disposed) throw StateError('fake player disposed');
  }

  void emitError(Object error) => _errorController.add(error);

  void emitState(String status) => _stateController.add(
    PocketAudioPlayerState(
      status: status,
      position: position,
      duration: duration,
    ),
  );
}
