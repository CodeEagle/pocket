import 'dart:async';

import 'package:just_audio/just_audio.dart';
import 'package:pocket_flutter/pocket_flutter.dart' show PocketViewController;
import 'package:pocket_services/pocket_services.dart';

const String pocketAudioPluginId = 'dart.audio';
const String pocketAudioPlayCapability = 'media.audio.play';
const String pocketAudioStopCapability = 'media.audio.stop';
const String pocketAudioPauseCapability = 'media.audio.pause';
const String pocketAudioResumeCapability = 'media.audio.resume';
const String pocketAudioVolumeCapability = 'media.audio.volume';
const String pocketAudioPlaybackEvent = 'media.audio.playback';
const int pocketAudioMaxChannels = 8;

const PocketPluginSchema _playParameters = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'channel': PocketPluginSchema.string(),
    'asset': PocketPluginSchema.string(),
    'loop': PocketPluginSchema.boolean(),
    'volume': PocketPluginSchema.number(),
    'paused': PocketPluginSchema.boolean(),
    'playbackId': PocketPluginSchema.string(),
    'restart': PocketPluginSchema.boolean(),
  },
  required: <String>{'channel', 'asset', 'loop', 'volume', 'paused'},
);

const PocketPluginSchema _channelParameters = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'channel': PocketPluginSchema.string(),
  },
  required: <String>{'channel'},
);

const PocketPluginSchema _volumeParameters = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'channel': PocketPluginSchema.string(),
    'volume': PocketPluginSchema.number(),
  },
  required: <String>{'channel', 'volume'},
);

const PocketPluginSchema _resultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'accepted': PocketPluginSchema.boolean(),
    'channel': PocketPluginSchema.string(),
    'playerPresent': PocketPluginSchema.boolean(),
    'processingState': PocketPluginSchema.string(),
    'playing': PocketPluginSchema.boolean(),
    'positionMs': PocketPluginSchema.integer(),
    'durationMs': PocketPluginSchema.integer(),
    'volume': PocketPluginSchema.number(),
    'asset': PocketPluginSchema.string(),
    'loop': PocketPluginSchema.boolean(),
    'error': PocketPluginSchema.string(),
  },
  required: <String>{
    'accepted',
    'channel',
    'playerPresent',
    'processingState',
    'playing',
    'positionMs',
  },
);

const PocketPluginCapabilitySchema _playSchema = PocketPluginCapabilitySchema(
  parameters: _playParameters,
  result: _resultSchema,
);
const PocketPluginCapabilitySchema _channelSchema =
    PocketPluginCapabilitySchema(
      parameters: _channelParameters,
      result: _resultSchema,
    );
const PocketPluginCapabilitySchema _volumeSchema = PocketPluginCapabilitySchema(
  parameters: _volumeParameters,
  result: _resultSchema,
);

typedef PocketAudioPlayerFactory = PocketAudioPlayer Function();

typedef PocketAudioActiveChanged = void Function(bool active);
typedef PocketAudioPlaybackChanged = void Function(Map<String, Object?> fact);

/// State emitted by the real player's state/error streams, without polling.
final class PocketAudioPlayerState {
  const PocketAudioPlayerState({
    required this.status,
    required this.position,
    this.duration,
    this.error,
  });

  final String status;
  final Duration position;
  final Duration? duration;
  final String? error;
}

/// A narrow injectable surface around just_audio for provider-level tests.
/// Playback, lifecycle and channel policy remain in [PocketAudioPlugin].
abstract interface class PocketAudioPlayer {
  Stream<PocketAudioPlayerState> get stateStream;
  Stream<Object> get errorStream;
  bool get playing;
  Duration get position;
  Duration? get duration;
  String get processingState;
  double get volume;

  Future<void> setAsset(String assetPath);
  Future<void> setLooping(bool loop);
  Future<void> setVolume(double volume);
  Future<void> seek(Duration position);
  Future<void> play();
  Future<void> pause();
  Future<void> stop();
  Future<void> dispose();
}

/// Thin native audio provider. It decodes exact, host-whitelisted Flutter
/// assets and exposes one just_audio controller per bounded audio channel.
/// Cue choice, auto/skip policy and playback transitions stay in JavaScript.
final class PocketAudioPlugin extends PocketPlugin {
  factory PocketAudioPlugin.forPocketViewController(
    PocketViewController controller, {
    Map<String, String> assets = const <String, String>{},
    String? assetPrefix,
    PocketAudioPlayerFactory? playerFactory,
  }) => PocketAudioPlugin(
    assets: assets,
    assetPrefix: assetPrefix,
    playerFactory: playerFactory,
    onActiveChanged: (active) => controller.send(
      method: 'media.audio.activation',
      params: <String, Object?>{'active': active},
    ),
    onPlayback: (fact) =>
        controller.send(method: pocketAudioPlaybackEvent, params: fact),
  );

  PocketAudioPlugin({
    Map<String, String> assets = const <String, String>{},
    String? assetPrefix,
    PocketAudioPlayerFactory? playerFactory,
    this.onActiveChanged,
    this.onPlayback,
  }) : _assets = _validateAssets(assets),
       _assetPrefix = _validateAssetPrefix(assetPrefix),
       _playerFactory = playerFactory ?? _JustAudioPocketPlayer.new;

  final Map<String, String> _assets;

  /// Optional Flutter bundle directory for consumer-owned relative request
  /// keys. Exact [_assets] entries take precedence over this directory.
  final String? _assetPrefix;
  final PocketAudioPlayerFactory _playerFactory;

  /// Reports real provider lifecycle transitions to an optional host bridge.
  /// This callback never starts or resumes playback.
  final PocketAudioActiveChanged? onActiveChanged;

  /// Reports just_audio state/completion/error facts for requests tagged with
  /// `playbackId`. Facts are emitted only at native player event boundaries;
  /// the plugin never polls playback position.
  final PocketAudioPlaybackChanged? onPlayback;

  final Map<String, _AudioChannel> _channels = <String, _AudioChannel>{};
  final Map<String, Future<void>> _channelTails = <String, Future<void>>{};
  bool _active = true;
  bool _disposed = false;

  int get activeChannelCount => _channels.length;
  bool get isActive => _active && !_disposed;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: pocketAudioPluginId,
    version: '0.1.0',
    description: 'Whitelisted asset playback for PocketJS audio requests',
    limits: PocketPluginLimits(maxConcurrentRequests: pocketAudioMaxChannels),
    capabilities: <String, PocketPluginCapability>{
      pocketAudioPlayCapability: PocketPluginCapability(
        name: pocketAudioPlayCapability,
        kind: PocketCapabilityKind.request,
        description: 'Load and play one whitelisted asset on a channel',
        schema: _playSchema,
      ),
      pocketAudioStopCapability: PocketPluginCapability(
        name: pocketAudioStopCapability,
        kind: PocketCapabilityKind.request,
        description: 'Stop and release one audio channel',
        schema: _channelSchema,
      ),
      pocketAudioPauseCapability: PocketPluginCapability(
        name: pocketAudioPauseCapability,
        kind: PocketCapabilityKind.request,
        description: 'Pause one audio channel',
        schema: _channelSchema,
      ),
      pocketAudioResumeCapability: PocketPluginCapability(
        name: pocketAudioResumeCapability,
        kind: PocketCapabilityKind.request,
        description: 'Resume one audio channel on explicit request',
        schema: _channelSchema,
      ),
      pocketAudioVolumeCapability: PocketPluginCapability(
        name: pocketAudioVolumeCapability,
        kind: PocketCapabilityKind.request,
        description: 'Set one audio channel volume',
        schema: _volumeSchema,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(pocketAudioPlayCapability, play);
    context.registerRequest(pocketAudioStopCapability, stop);
    context.registerRequest(pocketAudioPauseCapability, pause);
    context.registerRequest(pocketAudioResumeCapability, resume);
    context.registerRequest(pocketAudioVolumeCapability, setVolume);
  }

  /// Starts or replaces the asset on [channel]. `play()` is intentionally not
  /// awaited: just_audio's Future completes only on end/pause/stop, so awaiting
  /// it would hold the Pocket RPC open for the whole track.
  Future<Object?> play(Map<String, dynamic> params) async {
    final channel = _parseChannel(params['channel']);
    final assetKey = params['asset'];
    final assetPath = _resolveAssetPath(assetKey);
    if (assetKey is! String || assetPath == null) {
      throw const PocketCapabilityException(
        'audio_asset_denied',
        'asset is not present in the host audio allowlist or asset prefix',
      );
    }
    final loop = params['loop'];
    final paused = params['paused'];
    final restart = params['restart'] ?? false;
    final playbackId = _parsePlaybackId(
      params['playbackId'],
      present: params.containsKey('playbackId'),
    );
    final volume = _parseVolume(params['volume']);
    if (loop is! bool || paused is! bool || restart is! bool) {
      throw const PocketCapabilityException(
        'invalid_request',
        'loop, paused and restart must be booleans',
      );
    }

    return _serialize(channel, () async {
      _ensureActive();
      var slot = _channels[channel];
      if (slot == null) {
        if (_channels.length >= pocketAudioMaxChannels) {
          throw const PocketCapabilityException(
            'audio_channel_limit',
            'audio channel limit reached',
          );
        }
        slot = _createChannel(channel);
      }
      final generation = ++slot.generation;
      final previousPlaybackId = slot.playbackId;
      // Until the new source is ready, old state/completion events must not be
      // attributed to this request. The requested ID is bound at the call to
      // pause/play below.
      slot.playbackId = null;
      slot.acceptPlaybackEvents = false;
      slot.lastError = null;
      await _cancelPlaybackEvents(slot);

      try {
        await slot.player.setVolume(volume);
        if (!_active || _disposed) {
          throw const PocketCapabilityException(
            'plugin_inactive',
            'audio plugin became inactive before playback',
          );
        }
        final replayingTaggedVoice =
            playbackId != null && playbackId != previousPlaybackId;
        final reusesSource =
            slot.assetKey == assetKey && (!replayingTaggedVoice || restart);
        if (!reusesSource) {
          if (slot.assetKey != null) await slot.player.stop();
          slot.assetKey = null;
          slot.loop = loop;
          await slot.player.setLooping(loop);
          await slot.player.setAsset(assetPath);
          slot.assetKey = assetKey;
        } else if (slot.loop != loop) {
          slot.loop = loop;
          await slot.player.setLooping(loop);
        }
        // Repeated transient cues reuse their decoded source and native player.
        // play() alone leaves a completed just_audio stream at its end; only an
        // explicit JS restart request rewinds it. Ordinary resume keeps position.
        if (restart && reusesSource) await slot.player.seek(Duration.zero);
        if (!_active || _disposed) {
          await slot.player.pause();
          throw const PocketCapabilityException(
            'plugin_inactive',
            'audio plugin became inactive before playback',
          );
        }
        if (paused) {
          slot.playbackId = playbackId;
          slot.acceptPlaybackEvents = playbackId != null;
          if (playbackId != null) {
            _listenPlaybackEvents(channel, slot, generation);
          }
          await slot.player.pause();
        } else {
          slot.playbackId = playbackId;
          slot.acceptPlaybackEvents = playbackId != null;
          if (playbackId != null) {
            _listenPlaybackEvents(channel, slot, generation);
          }
          _startPlayback(channel, slot, generation);
        }
        return _snapshot(channel, slot);
      } on PocketCapabilityException {
        rethrow;
      } catch (error, stackTrace) {
        // The request Promise carries synchronous load/start failures to JS.
        // Clear this binding first so a stream notification emitted as part
        // of the failing call cannot duplicate that terminal result.
        slot.playbackId = null;
        slot.acceptPlaybackEvents = false;
        _captureError(channel, slot, generation, error, stackTrace);
        throw PocketCapabilityException(
          'audio_play_failed',
          'Could not load or start audio asset: $error',
        );
      }
    });
  }

  Future<Object?> stop(Map<String, dynamic> params) async {
    final channel = _parseChannel(params['channel']);
    return _serialize(channel, () async {
      _ensureNotDisposed();
      await _releaseChannel(channel);
      return _snapshot(channel, null);
    });
  }

  Future<Object?> pause(Map<String, dynamic> params) async {
    final channel = _parseChannel(params['channel']);
    return _serialize(channel, () async {
      _ensureActive();
      final slot = _channels[channel];
      if (slot != null) await slot.player.pause();
      return _snapshot(channel, slot);
    });
  }

  Future<Object?> resume(Map<String, dynamic> params) async {
    final channel = _parseChannel(params['channel']);
    return _serialize(channel, () async {
      _ensureActive();
      final slot = _channels[channel];
      if (slot != null) {
        slot.lastError = null;
        final generation = ++slot.generation;
        if (slot.stateSubscription != null || slot.errorSubscription != null) {
          await _cancelPlaybackEvents(slot);
        }
        if (slot.playbackId != null) {
          _listenPlaybackEvents(channel, slot, generation);
        }
        _startPlayback(channel, slot, generation);
      }
      return _snapshot(channel, slot);
    });
  }

  Future<Object?> setVolume(Map<String, dynamic> params) async {
    final channel = _parseChannel(params['channel']);
    final volume = _parseVolume(params['volume']);
    return _serialize(channel, () async {
      _ensureActive();
      final slot = _channels[channel];
      if (slot != null) {
        try {
          await slot.player.setVolume(volume);
        } catch (error, stackTrace) {
          _captureError(channel, slot, slot.generation, error, stackTrace);
          throw PocketCapabilityException(
            'audio_volume_failed',
            'Could not set audio volume: $error',
          );
        }
      }
      return _snapshot(channel, slot);
    });
  }

  /// Returns a local read-only snapshot of an existing channel.
  ///
  /// This reports current just_audio facts without issuing a capability
  /// request or changing playback. An absent channel returns the provider's
  /// ordinary idle snapshot.
  Map<String, Object?> snapshotChannel(String channel) {
    final parsedChannel = _parseChannel(channel);
    _ensureNotDisposed();
    return _snapshot(parsedChannel, _channels[parsedChannel]);
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    if (_disposed || !_active) return;
    _active = false;
    Object? firstError;
    StackTrace? firstStack;
    try {
      onActiveChanged?.call(false);
    } catch (error, stackTrace) {
      firstError = error;
      firstStack = stackTrace;
    }
    final channels = _channels.keys.toList(growable: false);
    for (final channel in channels) {
      try {
        await _serialize(channel, () async {
          final slot = _channels[channel];
          if (slot != null) await slot.player.pause();
        });
      } catch (error, stackTrace) {
        firstError ??= error;
        firstStack ??= stackTrace;
      }
    }
    if (firstError != null) Error.throwWithStackTrace(firstError, firstStack!);
  }

  @override
  Future<void> activate(PocketPluginContext context) async {
    if (_disposed || _active) return;
    // Activation makes explicit future commands available; it deliberately
    // does not resume players paused at the lifecycle boundary.
    _active = true;
    onActiveChanged?.call(true);
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _active = false;
    Object? firstError;
    StackTrace? firstStack;
    final channels = <String>{
      ..._channels.keys,
      ..._channelTails.keys,
    }.toList();
    for (final channel in channels) {
      try {
        await _serialize(channel, () => _releaseChannel(channel));
      } catch (error, stackTrace) {
        firstError ??= error;
        firstStack ??= stackTrace;
      }
    }
    if (firstError != null) Error.throwWithStackTrace(firstError, firstStack!);
  }

  _AudioChannel _createChannel(String channel) {
    final slot = _AudioChannel(_playerFactory());
    _channels[channel] = slot;
    return slot;
  }

  void _listenPlaybackEvents(
    String channel,
    _AudioChannel slot,
    int generation,
  ) {
    slot.stateSubscription = slot.player.stateStream.listen(
      (state) => _capturePlayerState(channel, slot, generation, state),
      onError: (Object error, StackTrace stackTrace) =>
          _captureError(channel, slot, generation, error, stackTrace),
    );
    slot.errorSubscription = slot.player.errorStream.listen(
      (error) =>
          _captureError(channel, slot, generation, error, StackTrace.current),
    );
  }

  Future<void> _cancelPlaybackEvents(_AudioChannel slot) async {
    final stateSubscription = slot.stateSubscription;
    final errorSubscription = slot.errorSubscription;
    slot.stateSubscription = null;
    slot.errorSubscription = null;
    await stateSubscription?.cancel();
    await errorSubscription?.cancel();
  }

  void _startPlayback(String channel, _AudioChannel slot, int generation) {
    final playback = slot.player.play();
    unawaited(
      playback.then<void>(
        (_) {},
        onError: (Object error, StackTrace stackTrace) {
          _captureError(channel, slot, generation, error, stackTrace);
        },
      ),
    );
  }

  void _captureError(
    String channel,
    _AudioChannel slot,
    int generation,
    Object error,
    StackTrace _,
  ) {
    // A delayed callback from an old source cannot overwrite a newer source
    // or a player which has already been released.
    if (!identical(_channels[channel], slot) ||
        slot.generation != generation ||
        _disposed) {
      return;
    }
    slot.lastError = error.toString();
    final playbackId = slot.playbackId;
    if (slot.acceptPlaybackEvents && playbackId != null) {
      slot.playbackId = null;
      slot.acceptPlaybackEvents = false;
      _emitPlayback(
        channel,
        playbackId,
        status: 'error',
        position: slot.player.position,
        duration: slot.player.duration,
        error: error.toString(),
      );
    }
  }

  void _capturePlayerState(
    String channel,
    _AudioChannel slot,
    int generation,
    PocketAudioPlayerState state,
  ) {
    final playbackId = slot.playbackId;
    if (!identical(_channels[channel], slot) ||
        slot.generation != generation ||
        _disposed ||
        !slot.acceptPlaybackEvents ||
        playbackId == null) {
      return;
    }
    if (state.status == 'completed' || state.status == 'error') {
      slot.playbackId = null;
      slot.acceptPlaybackEvents = false;
    }
    _emitPlayback(
      channel,
      playbackId,
      status: state.status,
      position: state.position,
      duration: state.duration,
      error: state.error,
    );
  }

  void _emitPlayback(
    String channel,
    String playbackId, {
    required String status,
    required Duration position,
    Duration? duration,
    String? error,
  }) {
    onPlayback?.call(<String, Object?>{
      'channel': channel,
      'playbackId': playbackId,
      'status': status,
      'positionMs': position.inMilliseconds < 0 ? 0 : position.inMilliseconds,
      if (duration != null)
        'durationMs': duration.inMilliseconds < 0 ? 0 : duration.inMilliseconds,
      if (error != null) 'error': error,
    });
  }

  Future<void> _releaseChannel(String channel) async {
    final slot = _channels.remove(channel);
    if (slot == null) return;
    slot.generation++;
    slot.playbackId = null;
    slot.acceptPlaybackEvents = false;
    Object? firstError;
    StackTrace? firstStack;
    try {
      await _cancelPlaybackEvents(slot);
    } catch (error, stackTrace) {
      firstError = error;
      firstStack = stackTrace;
    }
    try {
      await slot.player.stop();
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStack ??= stackTrace;
    }
    try {
      await slot.player.dispose();
    } catch (error, stackTrace) {
      firstError ??= error;
      firstStack ??= stackTrace;
    }
    if (firstError != null) Error.throwWithStackTrace(firstError, firstStack!);
  }

  Map<String, Object?> _snapshot(
    String channel,
    _AudioChannel? slot,
  ) => <String, Object?>{
    'accepted': true,
    'channel': channel,
    'playerPresent': slot != null,
    'processingState': slot?.player.processingState ?? 'idle',
    'playing': slot?.player.playing ?? false,
    'positionMs': slot?.player.position.inMilliseconds ?? 0,
    if (slot?.player.duration case final duration?)
      'durationMs': duration.inMilliseconds < 0 ? 0 : duration.inMilliseconds,
    if (slot != null) 'volume': slot.player.volume,
    if (slot?.assetKey case final assetKey?) 'asset': assetKey,
    if (slot != null) 'loop': slot.loop,
    if (slot?.lastError case final error?) 'error': error,
  };

  Future<T> _serialize<T>(String channel, Future<T> Function() operation) {
    final previous = _channelTails[channel] ?? Future<void>.value();
    final done = Completer<void>();
    final tail = done.future;
    _channelTails[channel] = tail;
    return (() async {
      try {
        await previous;
        return await operation();
      } finally {
        done.complete();
        if (identical(_channelTails[channel], tail)) {
          _channelTails.remove(channel);
        }
      }
    })();
  }

  void _ensureNotDisposed() {
    if (_disposed) {
      throw const PocketCapabilityException(
        'plugin_disposed',
        'audio plugin is disposed',
      );
    }
  }

  void _ensureActive() {
    _ensureNotDisposed();
    if (!_active) {
      throw const PocketCapabilityException(
        'plugin_inactive',
        'audio plugin is inactive',
      );
    }
  }

  static String _parseChannel(Object? value) {
    if (value is! String ||
        value.length > 64 ||
        (value != '__pocket_vn_voice' &&
            !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]*$').hasMatch(value))) {
      throw const PocketCapabilityException(
        'invalid_request',
        'channel must be a short non-empty identifier',
      );
    }
    return value;
  }

  static String? _parsePlaybackId(Object? value, {required bool present}) {
    if (!present) return null;
    if (value is! String ||
        value.length > 128 ||
        !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._:-]*$').hasMatch(value)) {
      throw const PocketCapabilityException(
        'invalid_request',
        'playbackId must be a short non-empty identifier',
      );
    }
    return value;
  }

  static double _parseVolume(Object? value) {
    if (value is! num || !value.isFinite || value < 0 || value > 1) {
      throw const PocketCapabilityException(
        'invalid_request',
        'volume must be a finite number from zero to one',
      );
    }
    return value.toDouble();
  }

  static Map<String, String> _validateAssets(Map<String, String> assets) {
    final validated = <String, String>{};
    for (final entry in assets.entries) {
      if (!_isSafeRelativePath(entry.key, maxLength: 256) ||
          !_isSafeRelativePath(entry.value, maxLength: 512)) {
        throw ArgumentError('invalid audio asset mapping: ${entry.key}');
      }
      validated[entry.key] = entry.value;
    }
    return Map<String, String>.unmodifiable(validated);
  }

  static String? _validateAssetPrefix(String? assetPrefix) {
    if (assetPrefix == null) return null;
    if (!assetPrefix.endsWith('/') ||
        !_isSafeRelativePath(
          assetPrefix.substring(0, assetPrefix.length - 1),
          maxLength: 511,
        )) {
      throw ArgumentError('invalid audio asset prefix: $assetPrefix');
    }
    return assetPrefix;
  }

  String? _resolveAssetPath(Object? assetKey) {
    if (assetKey is! String || !_isSafeRelativePath(assetKey, maxLength: 256)) {
      return null;
    }
    // Keep exact host mappings backwards compatible and make them authoritative
    // if a consumer configures both mapping styles.
    final mapped = _assets[assetKey];
    if (mapped != null) return mapped;
    final prefix = _assetPrefix;
    if (prefix == null) return null;
    final resolved = '$prefix$assetKey';
    return _isSafeRelativePath(resolved, maxLength: 512) ? resolved : null;
  }

  static bool _isSafeRelativePath(String path, {required int maxLength}) {
    if (path.isEmpty ||
        path.length > maxLength ||
        !RegExp(r'^[A-Za-z0-9._/-]+$').hasMatch(path) ||
        path.startsWith('/') ||
        path.contains('://')) {
      return false;
    }
    return path
        .split('/')
        .every(
          (segment) => segment.isNotEmpty && segment != '.' && segment != '..',
        );
  }
}

final class _AudioChannel {
  _AudioChannel(this.player);

  final PocketAudioPlayer player;
  String? assetKey;
  bool loop = false;
  int generation = 0;
  String? lastError;
  String? playbackId;
  bool acceptPlaybackEvents = false;
  StreamSubscription<PocketAudioPlayerState>? stateSubscription;
  StreamSubscription<Object>? errorSubscription;
}

final class _JustAudioPocketPlayer implements PocketAudioPlayer {
  _JustAudioPocketPlayer() : _player = AudioPlayer();

  final AudioPlayer _player;
  bool _disposed = false;

  @override
  Stream<PocketAudioPlayerState> get stateStream =>
      _player.playerStateStream.expand((state) {
        final status = switch (state.processingState) {
          ProcessingState.completed => 'completed',
          _ when state.playing => 'playing',
          ProcessingState.ready => 'paused',
          _ => null,
        };
        if (status == null) return const <PocketAudioPlayerState>[];
        return <PocketAudioPlayerState>[
          PocketAudioPlayerState(
            status: status,
            position: _player.position,
            duration: _player.duration,
          ),
        ];
      });

  @override
  Stream<Object> get errorStream => _player.errorStream.cast<Object>();

  @override
  bool get playing => _player.playerState.playing;

  @override
  Duration get position => _player.position;

  @override
  Duration? get duration => _player.duration;

  @override
  String get processingState => _player.playerState.processingState.name;

  @override
  double get volume => _player.volume;

  @override
  Future<void> setAsset(String assetPath) async {
    _ensureOpen();
    await _player.setAsset(assetPath);
  }

  @override
  Future<void> setLooping(bool loop) async {
    _ensureOpen();
    await _player.setLoopMode(loop ? LoopMode.one : LoopMode.off);
  }

  @override
  Future<void> setVolume(double volume) async {
    _ensureOpen();
    await _player.setVolume(volume);
  }

  @override
  Future<void> seek(Duration position) async {
    _ensureOpen();
    await _player.seek(position);
  }

  @override
  Future<void> play() {
    _ensureOpen();
    return _player.play();
  }

  @override
  Future<void> pause() {
    _ensureOpen();
    return _player.pause();
  }

  @override
  Future<void> stop() {
    _ensureOpen();
    return _player.stop();
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    await _player.dispose();
  }

  void _ensureOpen() {
    if (_disposed) throw StateError('just_audio player is disposed');
  }
}
