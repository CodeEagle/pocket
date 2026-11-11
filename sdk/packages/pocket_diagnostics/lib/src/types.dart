import 'dart:collection';

import 'package:flutter/foundation.dart';

const int diagnosticsSchemaVersion = 1;
const int defaultMaxRecords = 500;
const int defaultRecentLogLimit = 20;
const int defaultMaxDepth = 8;
const int defaultMaxNodes = 512;
const int defaultMaxArrayLength = 64;
const int defaultMaxObjectKeys = 64;
const int defaultMaxStringLength = 4096;
const int defaultMaxStackLength = 16 * 1024;
const int defaultMaxCauseDepth = 6;
const int defaultMaxDataBytes = 32 * 1024;
const String defaultJournalFilename = 'diagnostics.jsonl';
const int defaultMaxFileBytes = 512 * 1024;
const int defaultMaxRotatedFiles = 3;

enum DiagnosticRecordKind {
  log('log'),
  crash('crash');

  const DiagnosticRecordKind(this.value);
  final String value;

  static DiagnosticRecordKind? tryParse(Object? raw) => switch (raw) {
    DiagnosticRecordKind k => k,
    'log' => DiagnosticRecordKind.log,
    'crash' => DiagnosticRecordKind.crash,
    _ => null,
  };
}

enum DiagnosticSeverity {
  debug('debug', 10),
  info('info', 20),
  warn('warn', 30),
  error('error', 40),
  fatal('fatal', 50);

  const DiagnosticSeverity(this.value, this.rank);
  final String value;
  final int rank;

  static DiagnosticSeverity? tryParse(Object? raw) => switch (raw) {
    DiagnosticSeverity s => s,
    'debug' => DiagnosticSeverity.debug,
    'info' => DiagnosticSeverity.info,
    'warn' || 'warning' => DiagnosticSeverity.warn,
    'error' => DiagnosticSeverity.error,
    'fatal' => DiagnosticSeverity.fatal,
    _ => null,
  };
}

enum RecentLogCaptureMode {
  auto('auto'),
  ids('ids'),
  summaries('summaries'),
  none('none');

  const RecentLogCaptureMode(this.value);
  final String value;
}

@immutable
final class DiagnosticContext {
  const DiagnosticContext({
    this.source,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.revision,
    Map<String, Object?> extra = const <String, Object?>{},
  }) : _extra = extra;

  factory DiagnosticContext.fromJson(Map<String, Object?> json) {
    final extra = <String, Object?>{};
    for (final entry in json.entries) {
      if (!const <String>{
            'source',
            'projectId',
            'sessionId',
            'runtimeId',
            'revision',
          }.contains(entry.key) &&
          entry.value != null) {
        extra[entry.key] = entry.value;
      }
    }
    return DiagnosticContext(
      source: _stringOrNull(json['source']),
      projectId: _stringOrNull(json['projectId']),
      sessionId: _stringOrNull(json['sessionId']),
      runtimeId: _stringOrNull(json['runtimeId']),
      revision: _revisionOrNull(json['revision']),
      extra: extra.isEmpty
          ? const <String, Object?>{}
          : Map<String, Object?>.unmodifiable(extra),
    );
  }

  final String? source;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;

  /// Numeric or string revision identifier.
  final Object? revision;
  final Map<String, Object?> _extra;

  Map<String, Object?> get extra => _extra.isEmpty
      ? const <String, Object?>{}
      : UnmodifiableMapView<String, Object?>(_extra);

  bool get isEmpty =>
      source == null &&
      projectId == null &&
      sessionId == null &&
      runtimeId == null &&
      revision == null &&
      _extra.isEmpty;

  DiagnosticContext merge(DiagnosticContext? other) {
    if (other == null || other.isEmpty) return this;
    final mergedExtra = <String, Object?>{..._extra, ...other._extra};
    return DiagnosticContext(
      source: other.source ?? source,
      projectId: other.projectId ?? projectId,
      sessionId: other.sessionId ?? sessionId,
      runtimeId: other.runtimeId ?? runtimeId,
      revision: other.revision ?? revision,
      extra: mergedExtra.isEmpty
          ? const <String, Object?>{}
          : Map<String, Object?>.unmodifiable(mergedExtra),
    );
  }

  DiagnosticContext copyWith({
    String? source,
    String? projectId,
    String? sessionId,
    String? runtimeId,
    Object? revision,
    Map<String, Object?>? extra,
  }) => DiagnosticContext(
    source: source ?? this.source,
    projectId: projectId ?? this.projectId,
    sessionId: sessionId ?? this.sessionId,
    runtimeId: runtimeId ?? this.runtimeId,
    revision: revision ?? this.revision,
    extra: extra == null
        ? _extra
        : Map<String, Object?>.unmodifiable(Map<String, Object?>.from(extra)),
  );

  Map<String, Object?> toJson() => <String, Object?>{
    if (source != null) 'source': source,
    if (projectId != null) 'projectId': projectId,
    if (sessionId != null) 'sessionId': sessionId,
    if (runtimeId != null) 'runtimeId': runtimeId,
    if (revision != null) 'revision': revision,
    for (final entry in _extra.entries)
      if (entry.value != null) entry.key: entry.value,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is DiagnosticContext &&
          source == other.source &&
          projectId == other.projectId &&
          sessionId == other.sessionId &&
          runtimeId == other.runtimeId &&
          revision == other.revision &&
          mapEquals(_extra, other._extra);

  @override
  int get hashCode => Object.hash(
    source,
    projectId,
    sessionId,
    runtimeId,
    revision,
    Object.hashAllUnordered(
      _extra.entries.map((e) => Object.hash(e.key, e.value)),
    ),
  );
}

@immutable
final class NormalizedDiagnosticError {
  const NormalizedDiagnosticError({
    required this.name,
    required this.message,
    this.stack,
    this.code,
    this.cause,
    this.details,
    this.truncated,
  });

  factory NormalizedDiagnosticError.fromJson(Map<String, Object?> json) {
    final rawCause = json['cause'];
    return NormalizedDiagnosticError(
      name: _stringOrNull(json['name']) ?? 'Error',
      message: json['message'] is String
          ? json['message'] as String
          : '${json['message'] ?? ''}',
      stack: _stringOrNull(json['stack']),
      code: json['code'] is String || json['code'] is num ? json['code'] : null,
      cause: rawCause is Map
          ? NormalizedDiagnosticError.fromJson(
              Map<String, Object?>.from(rawCause),
            )
          : null,
      details: json['details'],
      truncated: json['truncated'] is bool ? json['truncated'] as bool : null,
    );
  }

  final String name;
  final String message;
  final String? stack;
  final Object? code;
  final NormalizedDiagnosticError? cause;
  final Object? details;
  final bool? truncated;

  Map<String, Object?> toJson() => <String, Object?>{
    'name': name,
    'message': message,
    if (stack != null) 'stack': stack,
    if (code != null) 'code': code,
    if (cause != null) 'cause': cause!.toJson(),
    if (details != null) 'details': details,
    if (truncated == true) 'truncated': true,
  };
}

@immutable
final class DiagnosticRecentLogSummary {
  const DiagnosticRecentLogSummary({
    required this.id,
    required this.timestamp,
    required this.severity,
    required this.message,
    this.tag,
    this.source,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.revision,
  });

  factory DiagnosticRecentLogSummary.fromJson(Map<String, Object?> json) =>
      DiagnosticRecentLogSummary(
        id: _stringOrNull(json['id']) ?? '',
        timestamp: _stringOrNull(json['timestamp']) ?? '',
        severity:
            DiagnosticSeverity.tryParse(json['severity']) ??
            DiagnosticSeverity.info,
        message: json['message'] is String ? json['message'] as String : '',
        tag: _stringOrNull(json['tag']),
        source: _stringOrNull(json['source']),
        projectId: _stringOrNull(json['projectId']),
        sessionId: _stringOrNull(json['sessionId']),
        runtimeId: _stringOrNull(json['runtimeId']),
        revision: _revisionOrNull(json['revision']),
      );

  final String id;
  final String timestamp;
  final DiagnosticSeverity severity;
  final String message;
  final String? tag;
  final String? source;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;
  final Object? revision;

  String get level => severity.value;

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'timestamp': timestamp,
    'severity': severity.value,
    'message': message,
    if (tag != null) 'tag': tag,
    if (source != null) 'source': source,
    if (projectId != null) 'projectId': projectId,
    if (sessionId != null) 'sessionId': sessionId,
    if (runtimeId != null) 'runtimeId': runtimeId,
    if (revision != null) 'revision': revision,
  };
}

@immutable
sealed class DiagnosticRecord {
  const DiagnosticRecord({
    required this.id,
    required this.kind,
    required this.timestamp,
    required this.seq,
    required this.severity,
    required this.message,
    this.tag,
    this.source,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.revision,
    this.data,
    DiagnosticContext? context,
  }) : _context = context;

  final String id;
  final DiagnosticRecordKind kind;
  final String timestamp;
  final int seq;
  final DiagnosticSeverity severity;
  final String message;
  final String? tag;
  final String? source;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;
  final Object? revision;
  final Object? data;
  final DiagnosticContext? _context;

  int get schemaVersion => diagnosticsSchemaVersion;

  DiagnosticContext get context =>
      _context ??
      DiagnosticContext(
        source: source,
        projectId: projectId,
        sessionId: sessionId,
        runtimeId: runtimeId,
        revision: revision,
      );

  NormalizedDiagnosticError? get error => null;

  Map<String, Object?> toJson();

  static DiagnosticRecord? tryFromJson(Object? raw) {
    if (raw is! Map) return null;
    final map = Map<String, Object?>.from(raw);
    final versionVal = map['schemaVersion'];
    if (versionVal != diagnosticsSchemaVersion) return null;
    final kind = DiagnosticRecordKind.tryParse(map['kind']);
    if (kind == null) return null;
    final id = _stringOrNull(map['id']);
    final timestamp = _stringOrNull(map['timestamp']);
    if (id == null || timestamp == null) return null;
    final severity = DiagnosticSeverity.tryParse(map['severity']);
    if (severity == null) return null;
    final message = map['message'];
    if (message is! String) return null;
    final seqRaw = map['seq'];
    final seq = seqRaw is num && seqRaw.isFinite ? seqRaw.toInt() : 0;

    final nestedCtx = map['context'] is Map
        ? Map<String, Object?>.from(map['context'] as Map)
        : const <String, Object?>{};
    final source =
        _stringOrNull(map['source']) ?? _stringOrNull(nestedCtx['source']);
    final projectId =
        _stringOrNull(map['projectId']) ??
        _stringOrNull(nestedCtx['projectId']);
    final sessionId =
        _stringOrNull(map['sessionId']) ??
        _stringOrNull(nestedCtx['sessionId']);
    final runtimeId =
        _stringOrNull(map['runtimeId']) ??
        _stringOrNull(nestedCtx['runtimeId']);
    final revision =
        _revisionOrNull(map['revision']) ??
        _revisionOrNull(nestedCtx['revision']);
    final extraCtx = DiagnosticContext.fromJson(nestedCtx).extra;
    final contextObj = DiagnosticContext(
      source: source,
      projectId: projectId,
      sessionId: sessionId,
      runtimeId: runtimeId,
      revision: revision,
      extra: extraCtx,
    );

    final tag = _stringOrNull(map['tag']);
    final data = map['data'];

    if (kind == DiagnosticRecordKind.log) {
      final durationRaw = map['durationMs'];
      final durationMs =
          durationRaw is num && durationRaw.isFinite && durationRaw >= 0
          ? durationRaw.toDouble()
          : null;
      return DiagnosticLogRecord(
        id: id,
        timestamp: timestamp,
        seq: seq,
        severity: severity,
        message: message,
        tag: tag,
        durationMs: durationMs,
        source: source,
        projectId: projectId,
        sessionId: sessionId,
        runtimeId: runtimeId,
        revision: revision,
        data: data,
        context: contextObj,
      );
    }

    final rawError = map['error'];
    if (rawError is! Map) return null;
    final errMap = Map<String, Object?>.from(rawError);
    if (errMap['name'] is! String || errMap['message'] is! String) {
      return null;
    }
    final normalizedError = NormalizedDiagnosticError.fromJson(errMap);
    final unhandled = map['unhandled'] is bool
        ? map['unhandled'] as bool
        : null;
    final recentLogIds = map['recentLogIds'] is List
        ? (map['recentLogIds'] as List).whereType<String>().toList(
            growable: false,
          )
        : null;
    final recentLogs = map['recentLogs'] is List
        ? (map['recentLogs'] as List)
              .whereType<Map>()
              .map(
                (item) => DiagnosticRecentLogSummary.fromJson(
                  Map<String, Object?>.from(item),
                ),
              )
              .toList(growable: false)
        : null;

    return DiagnosticCrashRecord(
      id: id,
      timestamp: timestamp,
      seq: seq,
      severity: severity,
      message: message,
      error: normalizedError,
      tag: tag,
      unhandled: unhandled,
      source: source,
      projectId: projectId,
      sessionId: sessionId,
      runtimeId: runtimeId,
      revision: revision,
      data: data,
      recentLogIds: recentLogIds,
      recentLogs: recentLogs,
      context: contextObj,
    );
  }
}

@immutable
final class DiagnosticLogRecord extends DiagnosticRecord {
  const DiagnosticLogRecord({
    required super.id,
    required super.timestamp,
    required super.seq,
    required super.severity,
    required super.message,
    super.tag,
    this.durationMs,
    super.source,
    super.projectId,
    super.sessionId,
    super.runtimeId,
    super.revision,
    super.data,
    super.context,
  }) : super(kind: DiagnosticRecordKind.log);

  final double? durationMs;

  @override
  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': diagnosticsSchemaVersion,
    'id': id,
    'kind': 'log',
    'timestamp': timestamp,
    'seq': seq,
    'severity': severity.value,
    'message': message,
    if (tag != null) 'tag': tag,
    if (durationMs != null) 'durationMs': durationMs,
    if (source != null) 'source': source,
    if (projectId != null) 'projectId': projectId,
    if (sessionId != null) 'sessionId': sessionId,
    if (runtimeId != null) 'runtimeId': runtimeId,
    if (revision != null) 'revision': revision,
    if (data != null) 'data': data,
  };
}

@immutable
final class DiagnosticCrashRecord extends DiagnosticRecord {
  const DiagnosticCrashRecord({
    required super.id,
    required super.timestamp,
    required super.seq,
    required super.severity,
    required super.message,
    required this.error,
    super.tag,
    this.unhandled,
    super.source,
    super.projectId,
    super.sessionId,
    super.runtimeId,
    super.revision,
    super.data,
    this.recentLogIds,
    this.recentLogs,
    super.context,
  }) : super(kind: DiagnosticRecordKind.crash);

  @override
  final NormalizedDiagnosticError error;
  final bool? unhandled;
  final List<String>? recentLogIds;
  final List<DiagnosticRecentLogSummary>? recentLogs;

  @override
  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': diagnosticsSchemaVersion,
    'id': id,
    'kind': 'crash',
    'timestamp': timestamp,
    'seq': seq,
    'severity': severity.value,
    'message': message,
    if (tag != null) 'tag': tag,
    if (source != null) 'source': source,
    if (projectId != null) 'projectId': projectId,
    if (sessionId != null) 'sessionId': sessionId,
    if (runtimeId != null) 'runtimeId': runtimeId,
    if (revision != null) 'revision': revision,
    'error': error.toJson(),
    if (unhandled != null) 'unhandled': unhandled,
    if (data != null) 'data': data,
    if (recentLogIds != null && recentLogIds!.isNotEmpty)
      'recentLogIds': recentLogIds,
    if (recentLogs != null && recentLogs!.isNotEmpty)
      'recentLogs': <Map<String, Object?>>[
        for (final summary in recentLogs!) summary.toJson(),
      ],
  };
}

@immutable
final class DiagnosticLogInput {
  const DiagnosticLogInput({
    required this.message,
    this.id,
    this.timestamp,
    this.severity = DiagnosticSeverity.info,
    this.tag,
    this.durationMs,
    this.source,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.revision,
    this.context,
    this.data,
  });

  final String? id;
  final Object? timestamp;
  final DiagnosticSeverity severity;
  final String message;
  final String? tag;
  final double? durationMs;
  final String? source;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;
  final Object? revision;
  final DiagnosticContext? context;
  final Object? data;
}

@immutable
final class DiagnosticCrashInput {
  const DiagnosticCrashInput({
    this.error,
    this.stackTrace,
    this.id,
    this.timestamp,
    this.severity = DiagnosticSeverity.fatal,
    this.message,
    this.tag,
    this.unhandled,
    this.source,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.revision,
    this.context,
    this.data,
    this.recentLogLimit,
  });

  final String? id;
  final Object? timestamp;
  final DiagnosticSeverity severity;
  final String? message;
  final String? tag;
  final Object? error;
  final StackTrace? stackTrace;
  final bool? unhandled;
  final String? source;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;
  final Object? revision;
  final DiagnosticContext? context;
  final Object? data;
  final int? recentLogLimit;
}

@immutable
final class DiagnosticQuery {
  const DiagnosticQuery({
    this.kind,
    this.kinds,
    this.severity,
    this.severities,
    this.minSeverity,
    this.source,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.revision,
    this.tag,
    this.since,
    this.until,
    this.search,
    this.limit,
    this.descending = false,
  });

  final DiagnosticRecordKind? kind;
  final List<DiagnosticRecordKind>? kinds;
  final DiagnosticSeverity? severity;
  final List<DiagnosticSeverity>? severities;
  final DiagnosticSeverity? minSeverity;
  final String? source;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;
  final Object? revision;
  final String? tag;
  final Object? since;
  final Object? until;
  final String? search;
  final int? limit;
  final bool descending;

  DiagnosticQuery copyWith({
    DiagnosticRecordKind? kind,
    List<DiagnosticRecordKind>? kinds,
    DiagnosticSeverity? severity,
    List<DiagnosticSeverity>? severities,
    DiagnosticSeverity? minSeverity,
    String? source,
    String? projectId,
    String? sessionId,
    String? runtimeId,
    Object? revision,
    String? tag,
    Object? since,
    Object? until,
    String? search,
    int? limit,
    bool? descending,
  }) => DiagnosticQuery(
    kind: kind ?? this.kind,
    kinds: kinds ?? this.kinds,
    severity: severity ?? this.severity,
    severities: severities ?? this.severities,
    minSeverity: minSeverity ?? this.minSeverity,
    source: source ?? this.source,
    projectId: projectId ?? this.projectId,
    sessionId: sessionId ?? this.sessionId,
    runtimeId: runtimeId ?? this.runtimeId,
    revision: revision ?? this.revision,
    tag: tag ?? this.tag,
    since: since ?? this.since,
    until: until ?? this.until,
    search: search ?? this.search,
    limit: limit ?? this.limit,
    descending: descending ?? this.descending,
  );
}

@immutable
final class DiagnosticClearFilter {
  const DiagnosticClearFilter({
    this.kind,
    this.kinds,
    this.projectId,
    this.sessionId,
    this.runtimeId,
    this.before,
  });

  final DiagnosticRecordKind? kind;
  final List<DiagnosticRecordKind>? kinds;
  final String? projectId;
  final String? sessionId;
  final String? runtimeId;
  final Object? before;
}

@immutable
final class DiagnosticNormalizationLimits {
  const DiagnosticNormalizationLimits({
    this.maxDepth = defaultMaxDepth,
    this.maxNodes = defaultMaxNodes,
    this.maxArrayLength = defaultMaxArrayLength,
    this.maxObjectKeys = defaultMaxObjectKeys,
    this.maxStringLength = defaultMaxStringLength,
    this.maxStackLength = defaultMaxStackLength,
    this.maxCauseDepth = defaultMaxCauseDepth,
    this.maxDataBytes = defaultMaxDataBytes,
  });

  final int maxDepth;
  final int maxNodes;
  final int maxArrayLength;
  final int maxObjectKeys;
  final int maxStringLength;
  final int maxStackLength;
  final int maxCauseDepth;
  final int maxDataBytes;
}

@immutable
final class DiagnosticExportBundle {
  const DiagnosticExportBundle({
    required this.exportedAt,
    required this.totalRecords,
    required this.logCount,
    required this.crashCount,
    required this.records,
    this.context,
  });

  final String exportedAt;
  final int totalRecords;
  final int logCount;
  final int crashCount;
  final DiagnosticContext? context;
  final List<DiagnosticRecord> records;

  String get format => 'pocket-diagnostics-export';
  int get schemaVersion => diagnosticsSchemaVersion;

  Map<String, Object?> toJson() => <String, Object?>{
    'format': format,
    'schemaVersion': schemaVersion,
    'exportedAt': exportedAt,
    'totalRecords': totalRecords,
    'logCount': logCount,
    'crashCount': crashCount,
    if (context != null && !context!.isEmpty) 'context': context!.toJson(),
    'records': <Map<String, Object?>>[
      for (final record in records) record.toJson(),
    ],
  };
}

@immutable
final class DiagnosticsStorageAppendOptions {
  const DiagnosticsStorageAppendOptions({this.sync = false});

  final bool sync;
}

abstract interface class DiagnosticsStorage {
  bool get preservesLogHistory;

  Future<void> append(
    DiagnosticRecord record, {
    DiagnosticsStorageAppendOptions options =
        const DiagnosticsStorageAppendOptions(),
  });

  Future<List<DiagnosticRecord>> readAll();

  Future<int> clear([DiagnosticClearFilter? filter]);

  Future<void> flush();

  Future<void> close();
}

/// Optional immediate storage boundary for fatal callbacks which cannot await.
abstract interface class SynchronousDiagnosticsStorage
    implements DiagnosticsStorage {
  void appendSync(
    DiagnosticRecord record, {
    DiagnosticsStorageAppendOptions options =
        const DiagnosticsStorageAppendOptions(),
  });
}

String? _stringOrNull(Object? value) {
  if (value is! String) return null;
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : trimmed;
}

Object? _revisionOrNull(Object? value) {
  if (value is int) return value;
  if (value is num && value.isFinite) {
    return value == value.truncateToDouble() ? value.toInt() : value;
  }
  if (value is String) {
    final trimmed = value.trim();
    if (trimmed.isNotEmpty) {
      return trimmed.length <= 128 ? trimmed : trimmed.substring(0, 128);
    }
  }
  return null;
}
