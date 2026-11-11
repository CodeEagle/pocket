import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'normalize.dart';
import 'types.dart';

String defaultDiagnosticIdGenerator([math.Random? random]) {
  final rng = random ?? math.Random();
  final time = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
  final rand = (rng.nextInt(0x7fffffff)).toRadixString(36).padLeft(6, '0');
  return 'diag-$time-$rand';
}

bool matchesClearFilter(
  DiagnosticRecord record, [
  DiagnosticClearFilter? filter,
]) {
  if (filter == null) return true;
  final allowedKinds = <DiagnosticRecordKind>{
    if (filter.kind != null) filter.kind!,
    if (filter.kinds != null) ...filter.kinds!,
  };
  if (allowedKinds.isNotEmpty && !allowedKinds.contains(record.kind)) {
    return false;
  }
  if (filter.projectId != null && record.projectId != filter.projectId) {
    return false;
  }
  if (filter.sessionId != null && record.sessionId != filter.sessionId) {
    return false;
  }
  if (filter.runtimeId != null && record.runtimeId != filter.runtimeId) {
    return false;
  }
  if (filter.before != null) {
    final beforeMs = _parseTimestampMs(filter.before);
    final recMs = _parseTimestampMs(record.timestamp);
    if (beforeMs != null && recMs != null && recMs >= beforeMs) {
      return false;
    }
  }
  return true;
}

List<DiagnosticRecord> filterAndSortRecords(
  List<DiagnosticRecord> records, [
  DiagnosticQuery? query,
]) {
  if (query == null) return List<DiagnosticRecord>.unmodifiable(records);

  final allowedKinds = <DiagnosticRecordKind>{
    if (query.kind != null) query.kind!,
    if (query.kinds != null) ...query.kinds!,
  };
  final allowedSeverities = <DiagnosticSeverity>{
    if (query.severity != null) query.severity!,
    if (query.severities != null) ...query.severities!,
  };
  final minRank = query.minSeverity?.rank;
  final sinceMs = _parseTimestampMs(query.since);
  final untilMs = _parseTimestampMs(query.until);
  final searchLower = query.search?.trim().isNotEmpty == true
      ? query.search!.trim().toLowerCase()
      : null;

  final matched = <DiagnosticRecord>[];
  for (final rec in records) {
    if (allowedKinds.isNotEmpty && !allowedKinds.contains(rec.kind)) continue;
    if (allowedSeverities.isNotEmpty &&
        !allowedSeverities.contains(rec.severity)) {
      continue;
    }
    if (minRank != null && rec.severity.rank < minRank) continue;
    if (query.source != null && rec.source != query.source) continue;
    if (query.projectId != null && rec.projectId != query.projectId) continue;
    if (query.sessionId != null && rec.sessionId != query.sessionId) continue;
    if (query.runtimeId != null && rec.runtimeId != query.runtimeId) continue;
    if (query.revision != null && rec.revision != query.revision) continue;
    if (query.tag != null && rec.tag != query.tag) continue;

    if (sinceMs != null) {
      final recMs = _parseTimestampMs(rec.timestamp);
      if (recMs != null && recMs < sinceMs) continue;
    }
    if (untilMs != null) {
      final recMs = _parseTimestampMs(rec.timestamp);
      if (recMs != null && recMs > untilMs) continue;
    }

    if (searchLower != null) {
      final msgMatch = rec.message.toLowerCase().contains(searchLower);
      final tagMatch = rec.tag?.toLowerCase().contains(searchLower) ?? false;
      final errMatch = rec is DiagnosticCrashRecord
          ? rec.error.message.toLowerCase().contains(searchLower) ||
                rec.error.name.toLowerCase().contains(searchLower) ||
                (rec.error.stack?.toLowerCase().contains(searchLower) ?? false)
          : false;
      if (!msgMatch && !tagMatch && !errMatch) continue;
    }
    matched.add(rec);
  }

  if (query.descending) {
    final reversed = matched.reversed.toList(growable: false);
    if (query.limit != null && query.limit! >= 0) {
      final max = math.min(reversed.length, query.limit!);
      return List<DiagnosticRecord>.unmodifiable(reversed.sublist(0, max));
    }
    return List<DiagnosticRecord>.unmodifiable(reversed);
  }

  if (query.limit != null && query.limit! >= 0) {
    final max = math.min(matched.length, query.limit!);
    return List<DiagnosticRecord>.unmodifiable(matched.sublist(0, max));
  }
  return List<DiagnosticRecord>.unmodifiable(matched);
}

int? _parseTimestampMs(Object? value) {
  if (value == null) return null;
  if (value is DateTime) return value.millisecondsSinceEpoch;
  if (value is int) return value;
  if (value is num && value.isFinite) return value.toInt();
  if (value is String) {
    final parsed = DateTime.tryParse(value);
    return parsed?.millisecondsSinceEpoch;
  }
  return null;
}

DiagnosticRecentLogSummary summarizeDiagnosticLog(DiagnosticLogRecord log) =>
    DiagnosticRecentLogSummary(
      id: log.id,
      timestamp: log.timestamp,
      severity: log.severity,
      message: truncateString(log.message, 512),
      tag: log.tag,
      source: log.source,
      projectId: log.projectId,
      sessionId: log.sessionId,
      runtimeId: log.runtimeId,
      revision: log.revision,
    );

final class MemoryDiagnosticsStorage implements DiagnosticsStorage {
  MemoryDiagnosticsStorage({
    int maxRecords = defaultMaxRecords,
    int maxBytes = 2 * 1024 * 1024,
    this.preservesLogHistory = true,
  }) : maxRecords = maxRecords > 0 ? maxRecords : defaultMaxRecords,
       maxBytes = maxBytes > 0 ? maxBytes : 2 * 1024 * 1024;

  final int maxRecords;
  final int maxBytes;

  @override
  final bool preservesLogHistory;

  final List<DiagnosticRecord> _records = <DiagnosticRecord>[];
  final List<int> _sizes = <int>[];
  int _totalBytes = 0;

  void _enforceBounds() {
    while (_records.length > maxRecords ||
        (_records.length > 1 && _totalBytes > maxBytes)) {
      _records.removeAt(0);
      final removed = _sizes.removeAt(0);
      _totalBytes = math.max(0, _totalBytes - removed);
    }
  }

  @override
  Future<void> append(
    DiagnosticRecord record, {
    DiagnosticsStorageAppendOptions options =
        const DiagnosticsStorageAppendOptions(),
  }) async {
    final serialized = jsonEncode(record.toJson());
    final byteLen = estimateUtf8Bytes(serialized);
    _records.add(record);
    _sizes.add(byteLen);
    _totalBytes += byteLen;
    _enforceBounds();
  }

  @override
  Future<List<DiagnosticRecord>> readAll() async =>
      List<DiagnosticRecord>.unmodifiable(_records);

  @override
  Future<int> clear([DiagnosticClearFilter? filter]) async {
    if (filter == null) {
      final count = _records.length;
      _records.clear();
      _sizes.clear();
      _totalBytes = 0;
      return count;
    }
    var removedCount = 0;
    for (var i = _records.length - 1; i >= 0; i -= 1) {
      if (matchesClearFilter(_records[i], filter)) {
        _records.removeAt(i);
        final sz = _sizes.removeAt(i);
        _totalBytes = math.max(0, _totalBytes - sz);
        removedCount += 1;
      }
    }
    return removedCount;
  }

  @override
  Future<void> flush() async {}

  @override
  Future<void> close() async {}
}

class DiagnosticsCollector {
  DiagnosticsCollector({
    DiagnosticsStorage? storage,
    DiagnosticContext? context,
    int maxRecords = defaultMaxRecords,
    int recentLogLimit = defaultRecentLogLimit,
    this.recentLogMode = RecentLogCaptureMode.auto,
    DiagnosticNormalizationLimits? normalization,
    DateTime Function()? now,
    String Function()? idGenerator,
  }) : _maxRecords = maxRecords > 0 ? maxRecords : defaultMaxRecords,
       _defaultRecentLogLimit = math.max(0, math.min(200, recentLogLimit)),
       _normLimits = resolveNormalizationLimits(normalization),
       _nowFn = now ?? DateTime.now,
       _idGen = idGenerator ?? defaultDiagnosticIdGenerator,
       _baseContext = normalizeDiagnosticContext(context) {
    _storage = storage ?? MemoryDiagnosticsStorage(maxRecords: _maxRecords);
  }

  late final DiagnosticsStorage _storage;
  final int _maxRecords;
  final int _defaultRecentLogLimit;
  final RecentLogCaptureMode recentLogMode;
  final ResolvedNormalizationLimits _normLimits;
  final DateTime Function() _nowFn;
  final String Function() _idGen;

  DiagnosticContext _baseContext;
  bool _closed = false;
  int _seqCounter = 0;
  final List<DiagnosticLogRecord> _recentLogsWindow = <DiagnosticLogRecord>[];
  Future<void> _queue = Future<void>.value();

  DiagnosticsStorage get storage => _storage;
  bool get closed => _closed;

  DiagnosticContext getContext() => _baseContext;

  DiagnosticContext setContext(DiagnosticContext next) {
    _baseContext = normalizeDiagnosticContext(_baseContext.merge(next));
    return _baseContext;
  }

  Future<T> _enqueue<T>(FutureOr<T> Function() task) {
    final completer = Completer<T>();
    final next = _queue.then((_) async {
      try {
        completer.complete(await task());
      } on Object catch (error, stackTrace) {
        completer.completeError(error, stackTrace);
      }
    });
    _queue = next.catchError((Object _) {});
    return completer.future;
  }

  void _assertOpen() {
    if (_closed) {
      throw StateError('DiagnosticsCollector is closed');
    }
  }

  void _pushRecentLog(DiagnosticLogRecord record) {
    if (_defaultRecentLogLimit <= 0 &&
        recentLogMode == RecentLogCaptureMode.none) {
      return;
    }
    _recentLogsWindow.add(record);
    final cap = math.max(_defaultRecentLogLimit, 50);
    if (_recentLogsWindow.length > cap) {
      _recentLogsWindow.removeRange(0, _recentLogsWindow.length - cap);
    }
  }

  DiagnosticContext _mergeContext({
    String? source,
    String? projectId,
    String? sessionId,
    String? runtimeId,
    Object? revision,
    DiagnosticContext? override,
  }) {
    final explicit = DiagnosticContext(
      source: source ?? override?.source,
      projectId: projectId ?? override?.projectId,
      sessionId: sessionId ?? override?.sessionId,
      runtimeId: runtimeId ?? override?.runtimeId,
      revision: revision ?? override?.revision,
      extra: override?.extra ?? const <String, Object?>{},
    );
    return _baseContext.merge(normalizeDiagnosticContext(explicit));
  }

  DiagnosticLogRecord _buildLogRecord(Object input) {
    final DiagnosticLogInput normalizedInput = switch (input) {
      DiagnosticLogInput i => i,
      String s => DiagnosticLogInput(message: s),
      _ => throw ArgumentError.value(
        input,
        'input',
        'must be a String or DiagnosticLogInput',
      ),
    };
    final message = truncateString(
      normalizedInput.message,
      _normLimits.maxStringLength,
    );
    final id = normalizeContextString(normalizedInput.id, 128) ?? _idGen();
    final timestamp = normalizeTimestamp(normalizedInput.timestamp, _nowFn);
    final tag = normalizeContextString(normalizedInput.tag, 128);
    final durationMs =
        normalizedInput.durationMs != null &&
            normalizedInput.durationMs!.isFinite &&
            normalizedInput.durationMs! >= 0
        ? normalizedInput.durationMs
        : null;
    final ctx = _mergeContext(
      source: normalizedInput.source,
      projectId: normalizedInput.projectId,
      sessionId: normalizedInput.sessionId,
      runtimeId: normalizedInput.runtimeId,
      revision: normalizedInput.revision,
      override: normalizedInput.context,
    );
    final data = normalizeDiagnosticData(
      normalizedInput.data,
      DiagnosticNormalizationLimits(
        maxDepth: _normLimits.maxDepth,
        maxNodes: _normLimits.maxNodes,
        maxArrayLength: _normLimits.maxArrayLength,
        maxObjectKeys: _normLimits.maxObjectKeys,
        maxStringLength: _normLimits.maxStringLength,
        maxStackLength: _normLimits.maxStackLength,
        maxCauseDepth: _normLimits.maxCauseDepth,
        maxDataBytes: _normLimits.maxDataBytes,
      ),
    );
    _seqCounter += 1;

    return DiagnosticLogRecord(
      id: id,
      timestamp: timestamp,
      seq: _seqCounter,
      severity: normalizedInput.severity,
      message: message,
      tag: tag,
      durationMs: durationMs,
      source: ctx.source,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      runtimeId: ctx.runtimeId,
      revision: ctx.revision,
      data: data,
      context: ctx,
    );
  }

  DiagnosticCrashRecord _buildCrashRecord(
    Object? errorOrInput, [
    DiagnosticCrashInput? overrides,
  ]) {
    final DiagnosticCrashInput crashInput;
    if (overrides == null && errorOrInput is DiagnosticCrashInput) {
      crashInput = errorOrInput;
    } else {
      crashInput = DiagnosticCrashInput(
        error: overrides?.error ?? errorOrInput,
        stackTrace: overrides?.stackTrace,
        id: overrides?.id,
        timestamp: overrides?.timestamp,
        severity: overrides?.severity ?? DiagnosticSeverity.fatal,
        message: overrides?.message,
        tag: overrides?.tag,
        unhandled: overrides?.unhandled,
        source: overrides?.source,
        projectId: overrides?.projectId,
        sessionId: overrides?.sessionId,
        runtimeId: overrides?.runtimeId,
        revision: overrides?.revision,
        context: overrides?.context,
        data: overrides?.data,
        recentLogLimit: overrides?.recentLogLimit,
      );
    }

    final rawError = crashInput.error ?? errorOrInput;
    final limitsObj = DiagnosticNormalizationLimits(
      maxDepth: _normLimits.maxDepth,
      maxNodes: _normLimits.maxNodes,
      maxArrayLength: _normLimits.maxArrayLength,
      maxObjectKeys: _normLimits.maxObjectKeys,
      maxStringLength: _normLimits.maxStringLength,
      maxStackLength: _normLimits.maxStackLength,
      maxCauseDepth: _normLimits.maxCauseDepth,
      maxDataBytes: _normLimits.maxDataBytes,
    );
    final normalizedError = normalizeDiagnosticError(
      rawError,
      stackTrace: crashInput.stackTrace,
      limits: limitsObj,
    );
    final rawMsg =
        crashInput.message != null && crashInput.message!.trim().isNotEmpty
        ? crashInput.message!
        : (normalizedError.message.isNotEmpty
              ? normalizedError.message
              : (normalizedError.name.isNotEmpty
                    ? normalizedError.name
                    : 'Unhandled crash'));
    final message = truncateString(rawMsg, _normLimits.maxStringLength);
    final severity =
        crashInput.severity == DiagnosticSeverity.error ||
            crashInput.severity == DiagnosticSeverity.fatal
        ? crashInput.severity
        : DiagnosticSeverity.fatal;
    final id = normalizeContextString(crashInput.id, 128) ?? _idGen();
    final timestamp = normalizeTimestamp(crashInput.timestamp, _nowFn);
    final tag = normalizeContextString(crashInput.tag, 128);
    final ctx = _mergeContext(
      source: crashInput.source,
      projectId: crashInput.projectId,
      sessionId: crashInput.sessionId,
      runtimeId: crashInput.runtimeId,
      revision: crashInput.revision,
      override: crashInput.context,
    );
    final data = normalizeDiagnosticData(crashInput.data, limitsObj);

    final limit = crashInput.recentLogLimit != null
        ? math.max(0, math.min(200, crashInput.recentLogLimit!))
        : _defaultRecentLogLimit;

    final relevantLogs = <DiagnosticLogRecord>[];
    if (limit > 0) {
      for (final log in _recentLogsWindow) {
        if (ctx.projectId != null &&
            log.projectId != null &&
            log.projectId != ctx.projectId) {
          continue;
        }
        if (ctx.sessionId != null &&
            log.sessionId != null &&
            log.sessionId != ctx.sessionId) {
          continue;
        }
        relevantLogs.add(log);
      }
      if (relevantLogs.length > limit) {
        relevantLogs.removeRange(0, relevantLogs.length - limit);
      }
    }

    final effectiveMode = recentLogMode == RecentLogCaptureMode.auto
        ? (_storage.preservesLogHistory
              ? RecentLogCaptureMode.ids
              : RecentLogCaptureMode.summaries)
        : recentLogMode;

    final recentLogIds =
        effectiveMode == RecentLogCaptureMode.ids && relevantLogs.isNotEmpty
        ? List<String>.unmodifiable(relevantLogs.map((l) => l.id))
        : null;
    final recentLogs =
        effectiveMode == RecentLogCaptureMode.summaries &&
            relevantLogs.isNotEmpty
        ? List<DiagnosticRecentLogSummary>.unmodifiable(
            relevantLogs.map(summarizeDiagnosticLog),
          )
        : null;

    _seqCounter += 1;

    return DiagnosticCrashRecord(
      id: id,
      timestamp: timestamp,
      seq: _seqCounter,
      severity: severity,
      message: message,
      tag: tag,
      source: ctx.source,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
      runtimeId: ctx.runtimeId,
      revision: ctx.revision,
      error: normalizedError,
      unhandled: crashInput.unhandled,
      data: data,
      recentLogIds: recentLogIds,
      recentLogs: recentLogs,
      context: ctx,
    );
  }

  Future<DiagnosticLogRecord> recordLog(Object input) {
    _assertOpen();
    final record = _buildLogRecord(input);
    _pushRecentLog(record);
    return _enqueue(() async {
      await _storage.append(
        record,
        options: const DiagnosticsStorageAppendOptions(sync: false),
      );
      return record;
    });
  }

  Future<DiagnosticLogRecord> log(
    String message, [
    DiagnosticLogInput? overrides,
  ]) => _recordLogWithSeverity(DiagnosticSeverity.info, message, overrides);

  Future<DiagnosticLogRecord> debug(
    String message, [
    DiagnosticLogInput? overrides,
  ]) => _recordLogWithSeverity(DiagnosticSeverity.debug, message, overrides);

  Future<DiagnosticLogRecord> info(
    String message, [
    DiagnosticLogInput? overrides,
  ]) => _recordLogWithSeverity(DiagnosticSeverity.info, message, overrides);

  Future<DiagnosticLogRecord> warn(
    String message, [
    DiagnosticLogInput? overrides,
  ]) => _recordLogWithSeverity(DiagnosticSeverity.warn, message, overrides);

  Future<DiagnosticLogRecord> error(
    String message, [
    DiagnosticLogInput? overrides,
  ]) => _recordLogWithSeverity(DiagnosticSeverity.error, message, overrides);

  Future<DiagnosticLogRecord> fatal(
    String message, [
    DiagnosticLogInput? overrides,
  ]) => _recordLogWithSeverity(DiagnosticSeverity.fatal, message, overrides);

  Future<DiagnosticLogRecord> _recordLogWithSeverity(
    DiagnosticSeverity severity,
    String message,
    DiagnosticLogInput? overrides,
  ) => recordLog(
    DiagnosticLogInput(
      message: message,
      id: overrides?.id,
      timestamp: overrides?.timestamp,
      severity: severity,
      tag: overrides?.tag,
      durationMs: overrides?.durationMs,
      source: overrides?.source,
      projectId: overrides?.projectId,
      sessionId: overrides?.sessionId,
      runtimeId: overrides?.runtimeId,
      revision: overrides?.revision,
      context: overrides?.context,
      data: overrides?.data,
    ),
  );

  Future<DiagnosticCrashRecord> recordCrash(
    Object? errorOrInput, [
    DiagnosticCrashInput? overrides,
  ]) {
    _assertOpen();
    final record = _buildCrashRecord(errorOrInput, overrides);
    return _enqueue(() async {
      await _storage.append(
        record,
        options: const DiagnosticsStorageAppendOptions(sync: true),
      );
      await _storage.flush();
      return record;
    });
  }

  /// Flushes before returning when the storage supports immediate writes.
  /// Fatal records can precede queued ordinary logs: the process may terminate
  /// before those tasks run. Normal records continue to use the async queue.
  DiagnosticCrashRecord? tryRecordCrashSync(
    Object? errorOrInput, [
    DiagnosticCrashInput? overrides,
  ]) {
    _assertOpen();
    final target = _storage;
    if (target is! SynchronousDiagnosticsStorage) return null;
    final record = _buildCrashRecord(errorOrInput, overrides);
    target.appendSync(
      record,
      options: const DiagnosticsStorageAppendOptions(sync: true),
    );
    return record;
  }

  Future<List<DiagnosticRecord>> list([DiagnosticQuery? query]) =>
      _enqueue(() async {
        final all = await _storage.readAll();
        return filterAndSortRecords(all, query);
      });

  Future<List<DiagnosticRecord>> listRecords([DiagnosticQuery? query]) =>
      list(query);

  Future<List<DiagnosticLogRecord>> listLogs([DiagnosticQuery? query]) async {
    final records = await list(
      (query ?? const DiagnosticQuery()).copyWith(
        kind: DiagnosticRecordKind.log,
        kinds: const <DiagnosticRecordKind>[DiagnosticRecordKind.log],
      ),
    );
    return List<DiagnosticLogRecord>.unmodifiable(
      records.whereType<DiagnosticLogRecord>(),
    );
  }

  Future<List<DiagnosticCrashRecord>> listCrashes([
    DiagnosticQuery? query,
  ]) async {
    final records = await list(
      (query ?? const DiagnosticQuery()).copyWith(
        kind: DiagnosticRecordKind.crash,
        kinds: const <DiagnosticRecordKind>[DiagnosticRecordKind.crash],
      ),
    );
    return List<DiagnosticCrashRecord>.unmodifiable(
      records.whereType<DiagnosticCrashRecord>(),
    );
  }

  Future<List<DiagnosticLogRecord>> getCrashRecentLogs(
    Object crashOrId, {
    int? limit,
  }) => _enqueue(() async {
    final effectiveLimit = limit ?? _defaultRecentLogLimit;
    final all = await _storage.readAll();
    DiagnosticCrashRecord? crash;
    if (crashOrId is DiagnosticCrashRecord) {
      crash = crashOrId;
    } else if (crashOrId is String) {
      for (final rec in all) {
        if (rec is DiagnosticCrashRecord && rec.id == crashOrId) {
          crash = rec;
          break;
        }
      }
    }
    if (crash == null) return const <DiagnosticLogRecord>[];

    if (crash.recentLogIds != null && crash.recentLogIds!.isNotEmpty) {
      final ids = crash.recentLogIds!;
      final start = math.max<int>(
        0,
        ids.length - math.max<int>(0, effectiveLimit),
      );
      final idSet = ids.sublist(start).toSet();
      final found = <DiagnosticLogRecord>[
        for (final rec in all)
          if (rec is DiagnosticLogRecord && idSet.contains(rec.id)) rec,
      ];
      if (found.isNotEmpty) {
        return List<DiagnosticLogRecord>.unmodifiable(found);
      }
    }

    final crashIndex = all.indexWhere((r) => r.id == crash!.id);
    final candidates = crashIndex >= 0 ? all.sublist(0, crashIndex) : all;
    final logs = <DiagnosticLogRecord>[];
    for (final rec in candidates) {
      if (rec is! DiagnosticLogRecord) continue;
      if (crash.projectId != null &&
          rec.projectId != null &&
          rec.projectId != crash.projectId) {
        continue;
      }
      if (crash.sessionId != null &&
          rec.sessionId != null &&
          rec.sessionId != crash.sessionId) {
        continue;
      }
      logs.add(rec);
    }
    final maxCount = math.max(0, effectiveLimit);
    final sliceStart = math.max(0, logs.length - maxCount);
    return List<DiagnosticLogRecord>.unmodifiable(logs.sublist(sliceStart));
  });

  Future<DiagnosticExportBundle> exportRecords([DiagnosticQuery? query]) =>
      _enqueue(() async {
        final all = await _storage.readAll();
        final matched = filterAndSortRecords(all, query);
        var logCount = 0;
        var crashCount = 0;
        for (final rec in matched) {
          if (rec is DiagnosticLogRecord) {
            logCount += 1;
          } else if (rec is DiagnosticCrashRecord) {
            crashCount += 1;
          }
        }
        return DiagnosticExportBundle(
          exportedAt: normalizeTimestamp(null, _nowFn),
          totalRecords: matched.length,
          logCount: logCount,
          crashCount: crashCount,
          context: _baseContext.isEmpty ? null : _baseContext,
          records: matched,
        );
      });

  Future<String> exportJson({
    DiagnosticQuery? query,
    bool pretty = false,
  }) async {
    final bundle = await exportRecords(query);
    return pretty
        ? const JsonEncoder.withIndent('  ').convert(bundle.toJson())
        : jsonEncode(bundle.toJson());
  }

  Future<int> clear([DiagnosticClearFilter? filter]) {
    _assertOpen();
    return _enqueue(() async {
      if (filter == null) {
        _recentLogsWindow.clear();
      } else {
        for (var i = _recentLogsWindow.length - 1; i >= 0; i -= 1) {
          if (matchesClearFilter(_recentLogsWindow[i], filter)) {
            _recentLogsWindow.removeAt(i);
          }
        }
      }
      return _storage.clear(filter);
    });
  }

  Future<void> flush() => _enqueue(() => _storage.flush());

  Future<void> close() {
    if (_closed) return _queue;
    _closed = true;
    return _enqueue(() async {
      await _storage.flush();
      await _storage.close();
    });
  }
}

DiagnosticsCollector createDiagnosticsCollector({
  DiagnosticsStorage? storage,
  DiagnosticContext? context,
  int maxRecords = defaultMaxRecords,
  int recentLogLimit = defaultRecentLogLimit,
  RecentLogCaptureMode recentLogMode = RecentLogCaptureMode.auto,
  DiagnosticNormalizationLimits? normalization,
  DateTime Function()? now,
  String Function()? idGenerator,
}) => DiagnosticsCollector(
  storage: storage,
  context: context,
  maxRecords: maxRecords,
  recentLogLimit: recentLogLimit,
  recentLogMode: recentLogMode,
  normalization: normalization,
  now: now,
  idGenerator: idGenerator,
);
