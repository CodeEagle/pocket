import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart' show PlatformDispatcher;
import 'package:path_provider/path_provider.dart';
import 'package:pocket_diagnostics/pocket_diagnostics.dart';
import 'package:pocket_services/pocket_services.dart';

import 'pocket_config.dart';

/// Host-owned diagnostics collector and durable JSONL journal adapter.
///
/// Captures actual Flutter/Dart error boundaries and PocketSession execution
/// facts without introducing a second Dart application state machine.
final class PocketHostDiagnostics {
  PocketHostDiagnostics({
    Directory? directory,
    DiagnosticsCollector? collector,
    this.maxFileBytes = defaultMaxFileBytes,
    this.maxRotatedFiles = defaultMaxRotatedFiles,
    this.maxRecords = defaultMaxRecords,
    this.recentLogLimit = defaultRecentLogLimit,
    this.captureFlutterErrors = false,
    this.capturePlatformDispatcherErrors = false,
    DiagnosticContext? context,
  }) : _explicitDirectory = directory,
       _explicitCollector = collector,
       _initialContext = context {
    if (maxFileBytes < 1024) {
      throw RangeError.value(maxFileBytes, 'maxFileBytes', 'must be >= 1024');
    }
    if (maxRotatedFiles < 0 || maxRotatedFiles > 32) {
      throw RangeError.range(maxRotatedFiles, 0, 32, 'maxRotatedFiles');
    }
    if (maxRecords < 1) {
      throw RangeError.value(maxRecords, 'maxRecords', 'must be >= 1');
    }
  }

  final Directory? _explicitDirectory;
  final DiagnosticsCollector? _explicitCollector;
  final DiagnosticContext? _initialContext;
  final int maxFileBytes;
  final int maxRotatedFiles;
  final int maxRecords;
  final int recentLogLimit;
  final bool captureFlutterErrors;
  final bool capturePlatformDispatcherErrors;

  DiagnosticsCollector? _collector;
  FileDiagnosticsStorage? _fileStorage;
  Future<DiagnosticsCollector>? _initFuture;
  FlutterErrorCollectorHandle? _errorCollectorHandle;
  final Map<(PocketAppConfig, bool), PocketAppConfig> _configured = {};
  bool _closed = false;

  bool get closed => _closed;

  String get journalPath => _fileStorage?.journalPath ?? '';

  DiagnosticsCollector? get collectorOrNull => _collector;

  /// Initializes or returns the underlying [DiagnosticsCollector].
  Future<DiagnosticsCollector> ensureCollector() {
    if (_closed) {
      return Future<DiagnosticsCollector>.error(
        StateError('PocketHostDiagnostics is closed'),
      );
    }
    final ready = _collector;
    if (ready != null) return Future<DiagnosticsCollector>.value(ready);
    final pending = _initFuture;
    if (pending != null) return pending;
    final future = _initialize();
    _initFuture = future;
    return future;
  }

  Future<DiagnosticsCollector> _initialize() async {
    if (_explicitCollector != null) {
      _collector = _explicitCollector;
      if (_initialContext != null) {
        _explicitCollector.setContext(_initialContext);
      }
      _attachErrorCollectorsIfConfigured(_explicitCollector);
      return _explicitCollector;
    }

    final dir =
        _explicitDirectory ??
        Directory(
          '${(await getApplicationSupportDirectory()).path}/pocket-diagnostics',
        );
    final storage = FileDiagnosticsStorage(
      directory: dir,
      maxFileBytes: maxFileBytes,
      maxRotatedFiles: maxRotatedFiles,
      maxRecords: maxRecords,
    );
    final created = DiagnosticsCollector(
      storage: storage,
      context:
          _initialContext ?? const DiagnosticContext(source: 'pocket.host'),
      maxRecords: maxRecords,
      recentLogLimit: recentLogLimit,
    );
    _fileStorage = storage;
    _collector = created;
    _attachErrorCollectorsIfConfigured(created);
    return created;
  }

  void _attachErrorCollectorsIfConfigured(
    DiagnosticsCollector targetCollector, {
    PlatformDispatcher? platformDispatcher,
  }) {
    if (_errorCollectorHandle != null) return;
    if (!captureFlutterErrors && !capturePlatformDispatcherErrors) return;
    _errorCollectorHandle = attachFlutterErrorCollector(
      collector: targetCollector,
      context: targetCollector.getContext(),
      captureFlutterErrors: captureFlutterErrors,
      capturePlatformDispatcherErrors: capturePlatformDispatcherErrors,
      platformDispatcher: platformDispatcher,
    );
  }

  /// Explicitly attaches opt-in `FlutterError.onError` and/or
  /// `PlatformDispatcher.onError` chaining to this host diagnostics instance.
  Future<FlutterErrorCollectorHandle> attachFlutterErrors({
    bool flutterErrors = true,
    bool platformDispatcherErrors = true,
    DiagnosticContext? context,
    void Function(DiagnosticCrashRecord record)? onCrashRecorded,
    PlatformDispatcher? platformDispatcher,
  }) async {
    final c = await ensureCollector();
    _errorCollectorHandle?.detach();
    final handle = attachFlutterErrorCollector(
      collector: c,
      context: context ?? c.getContext(),
      captureFlutterErrors: flutterErrors,
      capturePlatformDispatcherErrors: platformDispatcherErrors,
      onCrashRecorded: onCrashRecorded,
      platformDispatcher: platformDispatcher,
    );
    _errorCollectorHandle = handle;
    return handle;
  }

  /// Detaches any active Flutter/PlatformDispatcher error handler hooks.
  void detachFlutterErrors() {
    _errorCollectorHandle?.detach();
    _errorCollectorHandle = null;
  }

  /// Attaches this diagnostics instance to [config].
  ///
  /// When [controls] is true, also attaches a trusted `pocket.diagnostics`
  /// capability provider so SystemUI or a diagnostic surface can query/export
  /// persisted records.
  PocketAppConfig attach(PocketAppConfig config, {bool controls = false}) {
    if (identical(config.diagnostics, this) && !controls) {
      return config;
    }
    final cacheKey = (config, controls);
    final existing = _configured[cacheKey];
    if (existing != null) return existing;
    final configured = config.copyWith(
      diagnostics: this,
      pluginFactories: controls
          ? <PocketPluginFactory>[
              ...config.pluginFactories,
              (_) => _DiagnosticsPlugin(this, config.appId),
            ]
          : null,
    );
    _configured[cacheKey] = configured;
    return configured;
  }

  Future<DiagnosticLogRecord> recordLog(Object input) async {
    final c = await ensureCollector();
    return c.recordLog(input);
  }

  Future<DiagnosticCrashRecord> recordCrash(
    Object? errorOrInput, [
    DiagnosticCrashInput? overrides,
  ]) async {
    final c = await ensureCollector();
    return c.recordCrash(errorOrInput, overrides);
  }

  /// Called at PocketSession boundaries to record non-spam lifecycle/update/admission facts.
  void recordSessionLog({
    required String appId,
    required int generation,
    required String tag,
    required String message,
    DiagnosticSeverity severity = DiagnosticSeverity.info,
    Object? revision,
    String? runtimeId,
    Map<String, Object?>? data,
  }) {
    if (_closed) return;
    unawaited(
      ensureCollector()
          .then<void>(
            (c) => c.recordLog(
              DiagnosticLogInput(
                severity: severity,
                tag: tag,
                message: message,
                source: 'pocket.session',
                projectId: appId,
                sessionId: 'guest-$generation',
                runtimeId: runtimeId ?? appId,
                revision: revision ?? generation,
                data: data,
              ),
            ),
          )
          .catchError((Object _) {}),
    );
  }

  /// Called at PocketSession's actual `onError` / candidate failure boundary
  /// BEFORE fallback or recovery mutates the active package/generation context.
  Future<DiagnosticCrashRecord?> recordSessionCrash({
    required String appId,
    required int generation,
    required String stage,
    required String event,
    required Object error,
    StackTrace? stackTrace,
    Object? revision,
    String? version,
    String? payloadSha256,
    String? runtimeId,
    bool unhandled = true,
  }) async {
    if (_closed) return null;
    try {
      final c = await ensureCollector();
      return await c.recordCrash(
        error,
        DiagnosticCrashInput(
          stackTrace: stackTrace,
          severity: DiagnosticSeverity.fatal,
          tag: event,
          source: 'pocket.session',
          projectId: appId,
          sessionId: 'guest-$generation',
          runtimeId: runtimeId ?? appId,
          revision: revision ?? generation,
          unhandled: unhandled,
          data: <String, Object?>{
            'event': event,
            'stage': stage,
            'generation': generation,
            if (version != null) 'version': version,
            if (payloadSha256 != null) 'payloadSha256': payloadSha256,
          },
        ),
      );
    } on Object {
      return null;
    }
  }

  Future<List<DiagnosticRecord>> list([DiagnosticQuery? query]) async {
    final c = await ensureCollector();
    return c.list(query);
  }

  Future<List<DiagnosticLogRecord>> listLogs([DiagnosticQuery? query]) async {
    final c = await ensureCollector();
    return c.listLogs(query);
  }

  Future<List<DiagnosticCrashRecord>> listCrashes([
    DiagnosticQuery? query,
  ]) async {
    final c = await ensureCollector();
    return c.listCrashes(query);
  }

  Future<List<DiagnosticLogRecord>> getCrashRecentLogs(
    Object crashOrId, {
    int? limit,
  }) async {
    final c = await ensureCollector();
    return c.getCrashRecentLogs(crashOrId, limit: limit);
  }

  Future<DiagnosticExportBundle> exportRecords([DiagnosticQuery? query]) async {
    final c = await ensureCollector();
    return c.exportRecords(query);
  }

  Future<int> clear([DiagnosticClearFilter? filter]) async {
    final c = await ensureCollector();
    return c.clear(filter);
  }

  Future<void> flush() async {
    final pending = _initFuture;
    final c = _collector ?? (pending == null ? null : await pending);
    if (c != null) await c.flush();
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    detachFlutterErrors();
    final pending = _initFuture;
    if (pending != null) {
      try {
        final c = await pending;
        await c.close();
        return;
      } catch (_) {}
    }
    final c = _collector;
    if (c != null) {
      await c.close();
    }
  }
}

final class _DiagnosticsPlugin extends PocketPlugin {
  _DiagnosticsPlugin(this.diagnostics, this.ownerAppId);

  final PocketHostDiagnostics diagnostics;
  final String ownerAppId;

  static const List<String> _capabilities = <String>[
    'diagnostics.log',
    'diagnostics.crash',
    'diagnostics.list',
    'diagnostics.export',
    'diagnostics.clear',
  ];

  @override
  bool get backgroundSafe => true;

  @override
  PocketPluginDescriptor get descriptor => PocketPluginDescriptor(
    id: 'pocket.diagnostics',
    version: '1.0.0',
    capabilities: <String, PocketPluginCapability>{
      for (final name in _capabilities)
        name: PocketPluginCapability(
          name: name,
          kind: PocketCapabilityKind.request,
        ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest('diagnostics.log', (params) async {
      final msg = params['message'];
      if (msg is! String || msg.trim().isEmpty) {
        throw const PocketCapabilityException(
          'invalid_params',
          'message must be a non-empty string',
        );
      }
      final rec = await diagnostics.recordLog(
        DiagnosticLogInput(
          message: msg,
          severity:
              DiagnosticSeverity.tryParse(
                params['severity'] ?? params['level'],
              ) ??
              DiagnosticSeverity.info,
          tag: params['tag'] is String ? params['tag'] as String : null,
          source: params['source'] is String
              ? params['source'] as String
              : ownerAppId,
          projectId: params['projectId'] is String
              ? params['projectId'] as String
              : ownerAppId,
          sessionId: params['sessionId'] is String
              ? params['sessionId'] as String
              : context.sessionId,
          runtimeId: params['runtimeId'] is String
              ? params['runtimeId'] as String
              : ownerAppId,
          revision: params['revision'],
          data: params['data'],
        ),
      );
      return rec.toJson();
    });

    context.registerRequest('diagnostics.crash', (params) async {
      final err = params['error'] ?? params['message'] ?? 'Guest crash';
      final rec = await diagnostics.recordCrash(
        err,
        DiagnosticCrashInput(
          message: params['message'] is String
              ? params['message'] as String
              : null,
          severity:
              DiagnosticSeverity.tryParse(
                params['severity'] ?? params['level'],
              ) ??
              DiagnosticSeverity.fatal,
          tag: params['tag'] is String ? params['tag'] as String : null,
          unhandled: params['unhandled'] is bool
              ? params['unhandled'] as bool
              : null,
          source: params['source'] is String
              ? params['source'] as String
              : ownerAppId,
          projectId: params['projectId'] is String
              ? params['projectId'] as String
              : ownerAppId,
          sessionId: params['sessionId'] is String
              ? params['sessionId'] as String
              : context.sessionId,
          runtimeId: params['runtimeId'] is String
              ? params['runtimeId'] as String
              : ownerAppId,
          revision: params['revision'],
          data: params['data'],
        ),
      );
      return rec.toJson();
    });

    context.registerRequest('diagnostics.list', (params) async {
      final query = _parseQuery(params);
      final records = await diagnostics.list(query);
      return <String, Object?>{
        'records': <Map<String, Object?>>[
          for (final record in records) record.toJson(),
        ],
      };
    });

    context.registerRequest('diagnostics.export', (params) async {
      final query = _parseQuery(params);
      final bundle = await diagnostics.exportRecords(query);
      return bundle.toJson();
    });

    context.registerRequest('diagnostics.clear', (params) async {
      final filter = DiagnosticClearFilter(
        kind: DiagnosticRecordKind.tryParse(params['kind']),
        projectId: params['projectId'] is String
            ? params['projectId'] as String
            : null,
        sessionId: params['sessionId'] is String
            ? params['sessionId'] as String
            : null,
        runtimeId: params['runtimeId'] is String
            ? params['runtimeId'] as String
            : null,
        before: params['before'],
      );
      final removed = await diagnostics.clear(filter);
      return <String, Object?>{'removed': removed};
    });
  }

  DiagnosticQuery _parseQuery(Map<String, dynamic> params) => DiagnosticQuery(
    kind: DiagnosticRecordKind.tryParse(params['kind']),
    severity: DiagnosticSeverity.tryParse(params['severity']),
    minSeverity: DiagnosticSeverity.tryParse(params['minSeverity']),
    source: params['source'] is String ? params['source'] as String : null,
    projectId: params['projectId'] is String
        ? params['projectId'] as String
        : null,
    sessionId: params['sessionId'] is String
        ? params['sessionId'] as String
        : null,
    runtimeId: params['runtimeId'] is String
        ? params['runtimeId'] as String
        : null,
    revision: params['revision'],
    tag: params['tag'] is String ? params['tag'] as String : null,
    since: params['since'],
    until: params['until'],
    search: params['search'] is String ? params['search'] as String : null,
    limit: params['limit'] is int ? params['limit'] as int : null,
    descending: params['order'] == 'desc' || params['descending'] == true,
  );
}
