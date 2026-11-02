import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:path_provider/path_provider.dart';

/// Small, bounded performance log owned by the host.
///
/// The renderer only supplies JSON. Samples are validated and copied before
/// they enter the log, so a malformed metric cannot poison the persisted file
/// or make the frame callback throw. Disk work is serialized behind a future
/// chain and is never performed by [add] synchronously.
final class PerformanceHistory {
  PerformanceHistory({File? file, this.namespace}) : _file = file;

  final String? namespace;

  static const int maxSamples = 600;
  static const int periodicFlushSamples = 10;

  File? _file;
  Future<void>? _initializeFuture;
  Future<void> _writeChain = Future<void>.value();
  final List<Map<String, dynamic>> _samples = <Map<String, dynamic>>[];
  int _samplesSinceFlush = 0;
  bool _periodicFlushQueued = false;
  bool _disposed = false;
  Future<void>? _disposeFuture;
  String? _lastWriteError;

  String get logPath => _file?.path ?? '';

  /// Resolves the default application-support path and restores valid samples.
  ///
  /// Initialization is idempotent. Corrupt or out-of-contract records are
  /// ignored individually so one bad sample cannot hide the rest of the log.
  Future<void> initialize() {
    final existing = _initializeFuture;
    if (existing != null) return existing;
    final future = _initialize();
    _initializeFuture = future;
    return future;
  }

  /// Adds one renderer JSON sample and schedules a periodic asynchronous flush.
  /// Invalid samples are ignored to keep a frame callback non-throwing.
  void add(Map<String, dynamic> sample) {
    if (_disposed) return;
    final normalized = _normalize(sample);
    if (normalized == null) return;
    _samples.add(normalized);
    _sortAndTrim();
    _samplesSinceFlush++;
    if (_samplesSinceFlush >= periodicFlushSamples) {
      _samplesSinceFlush = 0;
      _schedulePeriodicFlush();
    }
  }

  /// Returns the latest metrics and a chronological window of recent samples.
  Map<String, dynamic> snapshot({int limit = 60}) {
    if (limit < 0) throw ArgumentError.value(limit, 'limit');
    final count = math.min(limit, maxSamples);
    final start = math.max(0, _samples.length - count);
    final history = _samples
        .sublist(start)
        .map((sample) => Map<String, dynamic>.unmodifiable(sample))
        .toList(growable: false);
    final latest = _samples.isEmpty ? null : _samples.last;
    final minFps = history.isEmpty
        ? null
        : history
              .map((sample) => sample['fps'] as num)
              .reduce((a, b) => a < b ? a : b);
    return <String, dynamic>{
      'recording': true,
      'latest': <String, dynamic>{
        'timestamp': latest?['timestamp'],
        'fps': latest?['fps'],
        'minFps': minFps,
        'maxGapMs': latest?['maxGapMs'],
        'slowFrames': latest?['slowFrames'],
        'nativeMsP95': latest?['nativeMsP95'],
      },
      'history': List<Map<String, dynamic>>.unmodifiable(history),
      'logPath': logPath,
      'logError': _lastWriteError,
    };
  }

  /// Serializes all pending writes and persists the current bounded log.
  Future<void> flush() => _enqueueWrite(_flushNow);

  /// Stops accepting samples and waits until the final snapshot is persisted.
  Future<void> dispose() => _disposeFuture ??= _dispose();

  Future<void> _dispose() async {
    if (_disposed) return;
    _disposed = true;
    try {
      await flush();
    } on Object catch (error) {
      // Dispose is best effort. The in-memory snapshot remains available and
      // the failure is exposed through snapshot()['logError'].
      _lastWriteError = error.toString();
    }
  }

  Future<void> _initialize() async {
    _file ??= File(
      '${(await getApplicationSupportDirectory()).path}/pocket-performance/${namespace == null ? '' : '$namespace/'}history.json',
    );
    final file = _file!;
    if (!await file.exists()) return;
    try {
      final decoded = jsonDecode(await file.readAsString());
      final raw = decoded is Map ? decoded['history'] : decoded;
      if (raw is! List) return;
      final restored = <Map<String, dynamic>>[];
      for (final item in raw) {
        if (item is! Map) continue;
        final normalized = _normalize(Map<String, dynamic>.from(item));
        if (normalized != null) restored.add(normalized);
      }
      // Preserve samples that arrived while asynchronous loading was in
      // progress, then retain the newest 600 by timestamp.
      _samples
        ..addAll(restored)
        ..sort(_compareSamples);
      _sortAndTrim();
    } on Object {
      // A malformed local log is non-fatal; the next flush replaces it with
      // a valid bounded document.
    }
  }

  void _schedulePeriodicFlush() {
    if (_periodicFlushQueued) return;
    _periodicFlushQueued = true;
    final future = _enqueueWrite(() async {
      try {
        await _flushNow();
      } finally {
        _periodicFlushQueued = false;
      }
    });
    // Periodic sampling must never surface an unhandled I/O future. Explicit
    // flush() remains awaitable and still propagates the write error.
    unawaited(_swallowWriteError(future));
  }

  Future<void> _flushNow() async {
    try {
      await initialize();
      await _writeCurrent();
      _lastWriteError = null;
    } on Object catch (error) {
      _lastWriteError = error.toString();
      rethrow;
    }
  }

  Future<void> _swallowWriteError(Future<void> future) async {
    try {
      await future;
    } on Object catch (error) {
      _lastWriteError = error.toString();
    }
  }

  Future<void> _enqueueWrite(Future<void> Function() operation) {
    final next = _writeChain.then<void>(
      (_) => operation(),
      // Keep the queue usable after an earlier write failure. The failed
      // operation is still surfaced to the caller that awaited it.
      onError: (Object _, StackTrace __) => operation(),
    );
    _writeChain = next;
    return next;
  }

  Future<void> _writeCurrent() async {
    final file = _file;
    if (file == null) return;
    await file.parent.create(recursive: true);
    final document = <String, dynamic>{
      'version': 1,
      'history': _samples
          .map(Map<String, dynamic>.from)
          .toList(growable: false),
    };
    final temporary = File(
      '${file.path}.tmp-${DateTime.now().microsecondsSinceEpoch}',
    );
    try {
      await temporary.writeAsString(jsonEncode(document), flush: true);
      await temporary.rename(file.path);
    } finally {
      if (await temporary.exists()) await temporary.delete();
    }
  }

  void _sortAndTrim() {
    _samples.sort(_compareSamples);
    if (_samples.length > maxSamples) {
      _samples.removeRange(0, _samples.length - maxSamples);
    }
  }

  static int _compareSamples(
    Map<String, dynamic> left,
    Map<String, dynamic> right,
  ) => (left['timestamp'] as String).compareTo(right['timestamp'] as String);

  static Map<String, dynamic>? _normalize(Map<String, dynamic> sample) {
    try {
      // Reject non-JSON values (including NaN and Infinity) before selecting
      // fields. This also bounds the input to a reasonably sized object.
      final encoded = jsonEncode(sample);
      if (encoded.length > 64 * 1024) return null;
      final timestamp = sample['timestamp'];
      if (timestamp is! String) return null;
      final parsed = DateTime.tryParse(timestamp);
      if (parsed == null) return null;
      final fps = _number(sample['fps'], 0, 1000);
      final frames = _number(sample['frames'], 0, 1000000000);
      final durationMs = _number(sample['durationMs'], 0, 3600000);
      final maxGapMs = _number(sample['maxGapMs'], 0, 3600000);
      final slowFrames = _number(sample['slowFrames'], 0, 1000000000);
      final nativeMsP95 = _number(sample['nativeMsP95'], 0, 3600000);
      final refreshHz = _number(sample['refreshHz'], 0, 1000);
      if ([
        fps,
        frames,
        durationMs,
        maxGapMs,
        slowFrames,
        nativeMsP95,
        refreshHz,
      ].any((value) => value == null)) {
        return null;
      }
      return <String, dynamic>{
        'timestamp': parsed.toUtc().toIso8601String(),
        'fps': fps,
        'frames': frames,
        'durationMs': durationMs,
        'maxGapMs': maxGapMs,
        'slowFrames': slowFrames,
        'nativeMsP95': nativeMsP95,
        'refreshHz': refreshHz,
      };
    } on Object {
      return null;
    }
  }

  static num? _number(Object? value, num minimum, num maximum) {
    if (value is! num || !value.isFinite) return null;
    if (value < minimum || value > maximum) return null;
    return value;
  }
}
