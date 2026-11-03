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
  static const int maxLongFrameEvents = 240;
  static const int maxLongFrameEventsPerSample = 64;
  static const int periodicFlushSamples = 10;

  File? _file;
  Future<void>? _initializeFuture;
  Future<void> _writeChain = Future<void>.value();
  final List<Map<String, dynamic>> _samples = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> _longFrameEvents = <Map<String, dynamic>>[];
  int _samplesSinceFlush = 0;
  bool _periodicFlushQueued = false;
  bool _disposed = false;
  Future<void>? _disposeFuture;
  String? _lastWriteError;
  String? _context;

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

  /// Sets the latest JS-owned diagnostic context for future long-frame events.
  ///
  /// This is intentionally only an opaque string. Routing and action state
  /// remain in JS; the host merely carries the context into persisted facts.
  void setContext(String? context) {
    if (_disposed) return;
    final trimmed = context?.trim();
    _context = trimmed == null || trimmed.isEmpty
        ? null
        : trimmed.length > 256
        ? trimmed.substring(0, 256)
        : trimmed;
  }

  /// Adds one renderer JSON sample and schedules a periodic asynchronous flush.
  /// Invalid samples are ignored to keep a frame callback non-throwing.
  ///
  /// The return value contains only this sample's normalized/enriched
  /// long-frame events. It is an incremental transport for live diagnostics;
  /// callers do not need to resend the bounded persisted history.
  List<Map<String, dynamic>> add(Map<String, dynamic> sample) {
    if (_disposed) return const <Map<String, dynamic>>[];
    final normalized = _normalize(sample);
    if (normalized == null) return const <Map<String, dynamic>>[];
    final longFrameEvents = _normalizeLongFrameEvents(
      sample['longFrameEvents'],
    );
    final addedEvents = <Map<String, dynamic>>[];
    for (final event in longFrameEvents) {
      addedEvents.add(_addLongFrameEvent(event));
    }
    // An idle burst may carry a real jank fact before a complete FPS window
    // exists. Keep that event, but do not turn its zero-frame/zero-duration
    // transport sample into a bogus 0 FPS point or contaminate minFps.
    if (_hasCadence(normalized)) {
      _samples.add(normalized);
      _sortAndTrim();
    }
    _samplesSinceFlush++;
    if (_samplesSinceFlush >= periodicFlushSamples) {
      _samplesSinceFlush = 0;
      _schedulePeriodicFlush();
    }
    return List<Map<String, dynamic>>.unmodifiable(addedEvents);
  }

  /// Adds one long-frame event without creating a second persistence loop.
  ///
  /// This is useful for hosts that receive a diagnostic event independently
  /// from a one-second FPS window. The same periodic flush policy as [add] is
  /// used, so frame callbacks never perform synchronous disk work.
  Map<String, dynamic>? addLongFrameEvent(Map<String, dynamic> event) {
    if (_disposed) return null;
    final normalized = _normalizeLongFrameEvent(event);
    if (normalized == null) return null;
    final added = _addLongFrameEvent(normalized);
    _samplesSinceFlush++;
    if (_samplesSinceFlush >= periodicFlushSamples) {
      _samplesSinceFlush = 0;
      _schedulePeriodicFlush();
    }
    return added;
  }

  /// Returns the latest metrics and bounded chronological windows.
  Map<String, dynamic> snapshot({int limit = 60, int eventLimit = 60}) {
    if (limit < 0) throw ArgumentError.value(limit, 'limit');
    if (eventLimit < 0) {
      throw ArgumentError.value(eventLimit, 'eventLimit');
    }
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
    final boundedEventLimit = math.min(eventLimit, maxLongFrameEvents);
    final eventStart = math.max(0, _longFrameEvents.length - boundedEventLimit);
    final longFrameEvents = _longFrameEvents
        .sublist(eventStart)
        .map((event) => Map<String, dynamic>.unmodifiable(event))
        .toList(growable: false);
    return <String, dynamic>{
      'recording': true,
      'latest': <String, dynamic>{
        'timestamp': latest?['timestamp'],
        'fps': latest?['fps'],
        'minFps': minFps,
        'maxGapMs': latest?['maxGapMs'],
        'slowFrames': latest?['slowFrames'],
        'nativeMsP95': latest?['nativeMsP95'],
        'refreshHz': latest?['refreshHz'],
        'longFrameCount': _longFrameEvents.length,
      },
      'history': List<Map<String, dynamic>>.unmodifiable(history),
      'longFrameEvents': List<Map<String, dynamic>>.unmodifiable(
        longFrameEvents,
      ),
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
      final restored = <Map<String, dynamic>>[];
      if (raw is List) {
        for (final item in raw) {
          if (item is! Map) continue;
          final normalized = _normalize(Map<String, dynamic>.from(item));
          if (normalized != null && _hasCadence(normalized)) {
            restored.add(normalized);
          }
        }
      }
      // Preserve samples that arrived while asynchronous loading was in
      // progress, then retain the newest 600 by timestamp.
      _samples
        ..addAll(restored)
        ..sort(_compareSamples);
      _sortAndTrim();
      final rawEvents = decoded is Map ? decoded['longFrameEvents'] : null;
      for (final event in _normalizeLongFrameEvents(
        rawEvents,
        maxEvents: maxLongFrameEvents,
      )) {
        _addLongFrameEvent(event);
      }
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
      'version': 2,
      'history': _samples
          .map(Map<String, dynamic>.from)
          .toList(growable: false),
      'longFrameEvents': _longFrameEvents
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

  Map<String, dynamic> _addLongFrameEvent(Map<String, dynamic> event) {
    final context = event['context'] as String?;
    final enriched = context == null && _context != null
        ? <String, dynamic>{...event, 'context': _context}
        : Map<String, dynamic>.from(event);
    // A timing callback can first emit the native/gap portion and later merge
    // build/raster data into the same timestamp. Replace that record instead
    // of growing duplicate entries in the bounded persisted history.
    final timestamp = enriched['timestamp'];
    final existingIndex = _longFrameEvents.indexWhere(
      (item) => item['timestamp'] == timestamp,
    );
    if (existingIndex >= 0) {
      _longFrameEvents[existingIndex] = <String, dynamic>{
        ..._longFrameEvents[existingIndex],
        ...enriched,
      };
    } else {
      _longFrameEvents.add(enriched);
    }
    _longFrameEvents.sort(_compareEvents);
    if (_longFrameEvents.length > maxLongFrameEvents) {
      _longFrameEvents.removeRange(
        0,
        _longFrameEvents.length - maxLongFrameEvents,
      );
    }
    final resultIndex = _longFrameEvents.indexWhere(
      (item) => item['timestamp'] == timestamp,
    );
    return resultIndex < 0
        ? Map<String, dynamic>.unmodifiable(enriched)
        : Map<String, dynamic>.unmodifiable(_longFrameEvents[resultIndex]);
  }

  static int _compareSamples(
    Map<String, dynamic> left,
    Map<String, dynamic> right,
  ) => (left['timestamp'] as String).compareTo(right['timestamp'] as String);

  static int _compareEvents(
    Map<String, dynamic> left,
    Map<String, dynamic> right,
  ) => (left['timestamp'] as String).compareTo(right['timestamp'] as String);

  static bool _hasCadence(Map<String, dynamic> sample) =>
      (sample['frames'] as num) > 0 && (sample['durationMs'] as num) > 0;

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

  static List<Map<String, dynamic>> _normalizeLongFrameEvents(
    Object? raw, {
    int maxEvents = maxLongFrameEventsPerSample,
  }) {
    if (raw is! List) return const <Map<String, dynamic>>[];
    final normalized = <Map<String, dynamic>>[];
    final start = math.max(0, raw.length - maxEvents);
    for (final item in raw.skip(start)) {
      if (item is! Map) continue;
      final event = _normalizeLongFrameEvent(Map<String, dynamic>.from(item));
      if (event != null) normalized.add(event);
    }
    normalized.sort(_compareEvents);
    return normalized;
  }

  static Map<String, dynamic>? _normalizeLongFrameEvent(
    Map<String, dynamic> event,
  ) {
    try {
      final encoded = jsonEncode(event);
      if (encoded.length > 8 * 1024) return null;
      final timestamp = event['timestamp'];
      if (timestamp is! String) return null;
      final parsed = DateTime.tryParse(timestamp);
      if (parsed == null) return null;
      final refreshHz = _number(event['refreshHz'], 1, 1000);
      final budgetMs = _number(event['budgetMs'], 0, 3600000);
      if (refreshHz == null || budgetMs == null) return null;
      final buildMs = _numberOrNull(event['buildMs'], 0, 3600000);
      final rasterMs = _numberOrNull(event['rasterMs'], 0, 3600000);
      final nativeMs = _numberOrNull(event['nativeMs'], 0, 3600000);
      final activeGapMs = _numberOrNull(event['activeGapMs'], 0, 3600000);
      if (buildMs == null &&
          rasterMs == null &&
          nativeMs == null &&
          activeGapMs == null) {
        return null;
      }
      final active = event['active'];
      // Persisted long-frame facts must come from an active frame. An idle
      // marker is deliberately rejected so a parked ticker cannot be
      // reclassified as jank by a caller or a stale log.
      if (active != null && active != true) return null;
      final context = event['context'];
      if (context != null && context is! String) return null;
      final boundedContext = context is String && context.length > 256
          ? context.substring(0, 256)
          : context;
      final scope = event['scope'];
      if (scope != null && scope is! String) return null;
      if (scope != null && scope != 'pocketView' && scope != 'flutterView') {
        return null;
      }
      return <String, dynamic>{
        'timestamp': parsed.toUtc().toIso8601String(),
        'refreshHz': refreshHz,
        'budgetMs': budgetMs,
        if (buildMs != null) 'buildMs': buildMs,
        if (rasterMs != null) 'rasterMs': rasterMs,
        if (nativeMs != null) 'nativeMs': nativeMs,
        if (activeGapMs != null) 'activeGapMs': activeGapMs,
        'active': true,
        if (boundedContext != null && boundedContext.isNotEmpty)
          'context': boundedContext,
        if (scope != null) 'scope': scope,
      };
    } on Object {
      return null;
    }
  }

  static num? _numberOrNull(Object? value, num minimum, num maximum) {
    if (value == null) return null;
    return _number(value, minimum, maximum);
  }

  static num? _number(Object? value, num minimum, num maximum) {
    if (value is! num || !value.isFinite) return null;
    if (value < minimum || value > maximum) return null;
    return value;
  }
}
