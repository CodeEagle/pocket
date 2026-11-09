// Dio exposes ResponseBody.close as an internal adapter cleanup hook. The
// provider reads bounded streams itself, so it must call that hook on both
// normal completion and quota cancellation.
// ignore_for_file: invalid_use_of_internal_member

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:isolate';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:pocket_services/pocket_services.dart';

part 'dio_worker.dart';

const Duration _workerShutdownGrace = Duration(milliseconds: 250);
const Duration _workerExitGrace = Duration(milliseconds: 100);
const Duration _workerCancellationGrace = Duration(milliseconds: 250);

const String pocketDioPluginId = 'dart.dio';
const String pocketDioRequestCapability = 'dio.request';
const String pocketDioNetworkPermission = 'network';
const int _hardMaxResponseBytes = 256 * 1024;
const int _hardMaxRequestBytes = 256 * 1024;

const PocketPluginSchema _dioRequestSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'url': PocketPluginSchema.string(),
    'method': PocketPluginSchema.string(),
    'headers': PocketPluginSchema.unknown(),
    'queryParameters': PocketPluginSchema.unknown(),
    'data': PocketPluginSchema.unknown(),
    'responseType': PocketPluginSchema.enumValue(<Object?>[
      'json',
      'text',
      'bytes',
    ]),
    'timeoutMs': PocketPluginSchema.integer(),
  },
  required: <String>{'url'},
);

const PocketPluginSchema _dioResultSchema = PocketPluginSchema.object(
  properties: <String, PocketPluginSchema>{
    'statusCode': PocketPluginSchema.integer(),
    'headers': PocketPluginSchema.unknown(),
    'data': PocketPluginSchema.unknown(),
  },
  required: <String>{'statusCode', 'headers', 'data'},
);

const PocketPluginCapabilitySchema _dioCapabilitySchema =
    PocketPluginCapabilitySchema(
      parameters: _dioRequestSchema,
      result: _dioResultSchema,
    );

/// A bounded Dio HTTP provider.
///
/// This provider deliberately exposes one request capability. It does not
/// implement retries, caching or application policy; those remain in JS. Each
/// request must match one of the exact `http`/`https` origins supplied by the
/// trusted host. No origins means that every request is denied.
final class PocketDioPlugin extends PocketPlugin {
  PocketDioPlugin({
    Iterable<String> allowedOrigins = const <String>[],
    Dio Function()? dioFactory,
    Duration requestTimeout = const Duration(seconds: 30),
    int maxResponseBytes = _hardMaxResponseBytes,
  }) : _allowedOrigins = _normalizeOrigins(allowedOrigins),
       _dioFactory = dioFactory,
       requestTimeout = _boundedTimeout(requestTimeout),
       maxResponseBytes = _boundedResponseLimit(maxResponseBytes);

  final Set<String> _allowedOrigins;
  final Dio Function()? _dioFactory;
  final Map<int, _DioPendingRequest> _pending = <int, _DioPendingRequest>{};
  final Duration requestTimeout;
  final int maxResponseBytes;
  _DioWorker? _worker;
  Future<void>? _disposeFuture;
  int _nextRequestId = 1;
  bool _disposed = false;

  /// Canonical origins granted to this provider.
  Set<String> get allowedOrigins => Set<String>.unmodifiable(_allowedOrigins);

  /// Number of requests currently owned by this plugin, including worker
  /// startup and requests dispatched to the worker.
  int get inFlightCount => _pending.length;

  @override
  PocketPluginDescriptor get descriptor => const PocketPluginDescriptor(
    id: pocketDioPluginId,
    version: '0.1.0',
    description: 'Bounded Dio HTTP requests for explicitly allowed origins',
    permissions: <String>{pocketDioNetworkPermission},
    limits: PocketPluginLimits(
      maxConcurrentRequests: 8,
      maxResponseBytes: _hardMaxResponseBytes,
    ),
    capabilities: <String, PocketPluginCapability>{
      pocketDioRequestCapability: PocketPluginCapability(
        name: pocketDioRequestCapability,
        kind: PocketCapabilityKind.request,
        schema: _dioCapabilitySchema,
      ),
    },
  );

  @override
  void register(PocketPluginContext context) {
    context.registerRequest(pocketDioRequestCapability, request);
  }

  /// Executes one bounded request. The same method is registered on the
  /// Pocket host bridge and is useful for a direct provider-level test.
  Future<Object?> request(Map<String, dynamic> params) {
    if (_disposed) {
      return Future<Object?>.error(
        const PocketCapabilityException(
          'plugin_disposed',
          'Dio plugin is disposed',
        ),
      );
    }
    if (_pending.length + (_worker?.cancelling.length ?? 0) >= 8) {
      return Future<Object?>.error(
        const PocketCapabilityException(
          'request_limit',
          'Dio plugin already has eight pending requests',
        ),
      );
    }

    final id = _nextRequestId++;
    final budget = _requestBudget(params);
    final deadline = DateTime.now().add(budget).microsecondsSinceEpoch;
    final pending = _DioPendingRequest(id, params, deadline);
    _pending[id] = pending;
    pending.timer = Timer(budget, () => _onDeadline(id));
    _ensureWorker();
    final worker = _worker;
    if (worker != null && worker.commandPort != null) {
      _dispatchPending(worker);
    }
    return pending.completer.future;
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    _settleAllCancelled('Dio plugin was deactivated');
    await _stopWorker();
  }

  @override
  Future<void> dispose() => _disposeFuture ??= _dispose();

  Future<void> _dispose() async {
    if (_disposed) return;
    _disposed = true;
    _settleAllCancelled('Dio plugin was disposed');
    await _stopWorker();
  }

  void _ensureWorker() {
    if (_worker != null || _disposed) return;
    final worker = _DioWorker(
      events: ReceivePort(),
      errors: ReceivePort(),
      exits: ReceivePort(),
    );
    _worker = worker;
    worker.events.listen((message) => _onWorkerMessage(worker, message));
    worker.errors.listen((message) => _onWorkerError(worker, message));
    worker.exits.listen((_) => _onWorkerExit(worker));
    unawaited(_startWorker(worker));
  }

  Future<void> _startWorker(_DioWorker worker) async {
    try {
      final isolate = await Isolate.spawn<_DioWorkerStart>(
        _dioWorkerMain,
        _DioWorkerStart(
          events: worker.events.sendPort,
          allowedOrigins: _allowedOrigins.toList(growable: false),
          requestTimeoutMicros: requestTimeout.inMicroseconds,
          maxResponseBytes: maxResponseBytes,
          dioFactory: _dioFactory,
        ),
        onError: worker.errors.sendPort,
        onExit: worker.exits.sendPort,
        debugName: 'PocketDio IO worker',
      );
      worker.isolate = isolate;
      if (!worker.startupSettled.isCompleted) worker.startupSettled.complete();
      if (worker.stopping) isolate.kill(priority: Isolate.immediate);
    } on Object catch (error) {
      if (!worker.startupSettled.isCompleted) worker.startupSettled.complete();
      _failWorker(
        worker,
        'request_failed',
        'Dio worker failed to start: $error',
      );
    }
  }

  void _onWorkerMessage(_DioWorker worker, Object? message) {
    if (!identical(_worker, worker) || worker.stopping || message is! Map) {
      return;
    }
    final type = message['type'];
    if (type == 'ready') {
      final commandPort = message['commandPort'];
      if (commandPort is! SendPort) {
        _failWorker(
          worker,
          'request_failed',
          'Dio worker sent an invalid ready message',
        );
        return;
      }
      worker.commandPort = commandPort;
      _dispatchPending(worker);
      return;
    }
    if (type == 'startup_error') {
      _failWorker(
        worker,
        'request_failed',
        message['message']?.toString() ?? 'Dio worker failed to initialize',
      );
      return;
    }
    if (type != 'result' && type != 'error') {
      _failWorker(
        worker,
        'request_failed',
        'Dio worker sent an invalid message',
      );
      return;
    }
    final id = message['id'];
    if (id is! int) {
      _failWorker(
        worker,
        'request_failed',
        'Dio worker sent an invalid request id',
      );
      return;
    }
    _acknowledgeCancellation(worker, id);
    final pending = _pending[id];
    if (pending == null) return; // Late replies after timeout/cancel are inert.
    if (type == 'result') {
      _settleResult(pending, message['value']);
    } else {
      final code = message['code'];
      final errorMessage = message['message'];
      _settleError(
        pending,
        PocketCapabilityException(
          code is String ? code : 'request_failed',
          errorMessage is String ? errorMessage : 'Dio worker request failed',
        ),
      );
    }
  }

  void _onWorkerError(_DioWorker worker, Object? message) {
    if (!identical(_worker, worker) || worker.stopping) return;
    _failWorker(
      worker,
      'request_failed',
      'Dio worker failed: ${_workerErrorMessage(message)}',
    );
  }

  void _onWorkerExit(_DioWorker worker) {
    if (!worker.exited.isCompleted) worker.exited.complete();
    if (!identical(_worker, worker) || worker.stopping) return;
    _failWorker(worker, 'request_failed', 'Dio worker exited unexpectedly');
  }

  void _dispatchPending(_DioWorker worker) {
    final commandPort = worker.commandPort;
    if (commandPort == null || worker.stopping) return;
    for (final pending in _pending.values.toList(growable: false)) {
      if (pending.sent) continue;
      if (pending.deadlineMicros <= DateTime.now().microsecondsSinceEpoch) {
        _onDeadline(pending.id);
        continue;
      }
      try {
        commandPort.send(<String, Object?>{
          'type': 'request',
          'id': pending.id,
          'deadlineMicros': pending.deadlineMicros,
          'params': pending.params,
        });
        pending.sent = true;
      } on Object {
        _settleError(
          pending,
          const PocketCapabilityException(
            'invalid_request',
            'request parameters could not be transferred to the Dio worker',
          ),
        );
      }
    }
  }

  void _onDeadline(int id) {
    final pending = _pending[id];
    if (pending == null) return;
    if (pending.sent) {
      final worker = _worker;
      if (worker?.commandPort != null) {
        worker!.commandPort!.send(<String, Object?>{
          'type': 'cancel',
          'id': id,
        });
        _trackCancellation(worker, id);
      }
    }
    _settleError(
      pending,
      const PocketCapabilityException(
        'request_timeout',
        'Dio request exceeded its deadline',
      ),
    );
    if (_pending.isEmpty && _worker?.commandPort == null) {
      unawaited(_stopWorker());
    }
  }

  void _settleResult(_DioPendingRequest pending, Object? value) {
    if (!_pending.containsKey(pending.id)) return;
    _pending.remove(pending.id);
    pending.timer?.cancel();
    if (!pending.completer.isCompleted) pending.completer.complete(value);
  }

  void _settleError(
    _DioPendingRequest pending,
    PocketCapabilityException error,
  ) {
    if (!_pending.containsKey(pending.id)) return;
    _pending.remove(pending.id);
    pending.timer?.cancel();
    if (!pending.completer.isCompleted) pending.completer.completeError(error);
  }

  void _settleAllCancelled(String message) {
    for (final pending in _pending.values.toList(growable: false)) {
      _settleError(
        pending,
        PocketCapabilityException('request_cancelled', message),
      );
    }
  }

  void _trackCancellation(_DioWorker worker, int id) {
    worker.cancelling.add(id);
    worker.cancellationWatchdog ??= Timer(_workerCancellationGrace, () {
      if (identical(_worker, worker) && worker.cancelling.isNotEmpty) {
        _failWorker(
          worker,
          'request_failed',
          'Dio worker did not acknowledge request cancellation',
        );
      }
    });
  }

  void _acknowledgeCancellation(_DioWorker worker, int id) {
    worker.cancelling.remove(id);
    if (worker.cancelling.isEmpty) {
      worker.cancellationWatchdog?.cancel();
      worker.cancellationWatchdog = null;
    }
  }

  void _failWorker(_DioWorker worker, String code, String message) {
    if (!identical(_worker, worker)) return;
    _worker = null;
    worker.stopping = true;
    for (final pending in _pending.values.toList(growable: false)) {
      _settleError(pending, PocketCapabilityException(code, message));
    }
    worker.isolate?.kill(priority: Isolate.immediate);
    worker.closePorts();
  }

  Future<void> _stopWorker() async {
    final worker = _worker;
    if (worker == null) return;
    _worker = null;
    worker.stopping = true;
    worker.commandPort?.send(const <String, Object?>{'type': 'shutdown'});
    try {
      await worker.startupSettled.future.timeout(_workerShutdownGrace);
      if (worker.isolate != null) {
        await worker.exited.future.timeout(_workerShutdownGrace);
      }
    } on Object {
      worker.isolate?.kill(priority: Isolate.immediate);
      try {
        await worker.exited.future.timeout(_workerExitGrace);
      } on Object {
        // Ports are still closed if an isolate does not exit in the grace time.
      }
    } finally {
      worker.closePorts();
    }
  }

  Duration _requestBudget(Map<String, dynamic> params) {
    final value = params['timeoutMs'];
    if (value is int && value > 0 && value < requestTimeout.inMilliseconds) {
      return Duration(milliseconds: value);
    }
    return requestTimeout;
  }

  static Duration _parseTimeout(Object? value, Duration requestTimeout) {
    if (value == null) return requestTimeout;
    if (value is! int || value <= 0) {
      throw const PocketCapabilityException(
        'invalid_request',
        'timeoutMs must be a positive integer',
      );
    }
    final requested = Duration(milliseconds: value);
    return requested <= requestTimeout ? requested : requestTimeout;
  }

  static Uri _parseUrl(Object? value) {
    if (value is! String || value.isEmpty || value.length > 8192) {
      throw const PocketCapabilityException(
        'invalid_request',
        'url must be a non-empty string of at most 8192 characters',
      );
    }
    late final Uri uri;
    try {
      uri = Uri.parse(value);
    } catch (_) {
      throw const PocketCapabilityException(
        'invalid_request',
        'url is invalid',
      );
    }
    if ((uri.scheme != 'http' && uri.scheme != 'https') ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        (uri.hasPort && uri.port == 0) ||
        uri.hasFragment) {
      throw const PocketCapabilityException(
        'invalid_request',
        'url must be an absolute http(s) URL without credentials or fragments',
      );
    }
    return uri;
  }

  static String _parseMethod(Object? value) {
    final method = value == null ? 'GET' : value;
    if (method is! String ||
        method.isEmpty ||
        !RegExp(
          r"^[A-Za-z][A-Za-z0-9!#$%&'*+.^_`|~-]{0,15}$",
        ).hasMatch(method)) {
      throw const PocketCapabilityException(
        'invalid_request',
        'method must be a valid HTTP token',
      );
    }
    return method.toUpperCase();
  }

  static Map<String, dynamic>? _parseHeaders(Object? value) {
    if (value == null) return null;
    if (value is! Map || value.keys.any((key) => key is! String)) {
      throw const PocketCapabilityException(
        'invalid_request',
        'headers must be an object with string keys',
      );
    }
    final result = <String, dynamic>{};
    for (final entry in value.entries) {
      final name = entry.key as String;
      if (name.isEmpty ||
          name.length > 256 ||
          name.contains(RegExp(r'[\r\n]'))) {
        throw const PocketCapabilityException(
          'invalid_request',
          'header names must not contain line breaks',
        );
      }
      final headerValue = entry.value;
      if (headerValue is! String &&
          headerValue is! num &&
          headerValue is! bool &&
          !(headerValue is List &&
              headerValue.every((item) => item is String))) {
        throw const PocketCapabilityException(
          'invalid_request',
          'header values must be strings, numbers, booleans or string arrays',
        );
      }
      result[name] = headerValue;
    }
    return result;
  }

  static Map<String, dynamic>? _parseQueryParameters(Object? value) {
    if (value == null) return null;
    if (value is! Map || value.keys.any((key) => key is! String)) {
      throw const PocketCapabilityException(
        'invalid_request',
        'queryParameters must be an object with string keys',
      );
    }
    final result = <String, dynamic>{};
    for (final entry in value.entries) {
      final queryValue = entry.value;
      if (queryValue is! String &&
          queryValue is! num &&
          queryValue is! bool &&
          !(queryValue is Iterable &&
              queryValue.every((item) => item is String))) {
        throw const PocketCapabilityException(
          'invalid_request',
          'query parameter values must be primitive or string arrays',
        );
      }
      result[entry.key as String] = queryValue;
    }
    return result;
  }

  static String _parseResponseType(Object? value) {
    final result = value ?? 'json';
    if (result is! String ||
        !const {'json', 'text', 'bytes'}.contains(result)) {
      throw const PocketCapabilityException(
        'invalid_request',
        'responseType must be json, text or bytes',
      );
    }
    return result;
  }

  static Future<List<int>> _readBounded(
    ResponseBody body,
    CancelToken cancelToken,
    int maxResponseBytes,
  ) async {
    final declaredLength = body.contentLength;
    if (declaredLength > maxResponseBytes) {
      body.close();
      cancelToken.cancel('response exceeds byte limit');
      throw const PocketCapabilityException(
        'response_too_large',
        'response exceeds the configured byte limit',
      );
    }
    final bytes = BytesBuilder(copy: false);
    var size = 0;
    try {
      await for (final chunk in body.stream) {
        size += chunk.length;
        if (size > maxResponseBytes) {
          cancelToken.cancel('response exceeds byte limit');
          throw const PocketCapabilityException(
            'response_too_large',
            'response exceeds the configured byte limit',
          );
        }
        bytes.add(chunk);
      }
      return bytes.takeBytes();
    } finally {
      body.close();
    }
  }

  static Object? _decode(
    List<int> bytes,
    String responseType,
    Map<String, List<String>> headers,
  ) {
    switch (responseType) {
      case 'bytes':
        return List<int>.unmodifiable(bytes);
      case 'text':
        return utf8.decode(bytes);
      case 'json':
        if (bytes.isEmpty) return null;
        final text = utf8.decode(bytes);
        if (!_isJsonContentType(headers)) return text;
        return jsonDecode(text);
      default:
        throw StateError('unsupported response type');
    }
  }

  static bool _isJsonContentType(Map<String, List<String>> headers) {
    for (final entry in headers.entries) {
      if (entry.key.toLowerCase() != Headers.contentTypeHeader ||
          entry.value.isEmpty) {
        continue;
      }
      final mediaType = entry.value.first.split(';').first.trim().toLowerCase();
      return mediaType == Headers.jsonContentType ||
          mediaType.endsWith('+json');
    }
    return false;
  }

  static Map<String, List<String>> _responseHeaders(
    Map<String, List<String>> headers,
  ) => <String, List<String>>{
    for (final entry in headers.entries)
      entry.key: List<String>.unmodifiable(entry.value),
  };

  static void _validateJsonOrBytes(Object? value, String field, int limit) {
    try {
      if (utf8.encode(jsonEncode(value)).length > limit) {
        throw const PocketCapabilityException(
          'request_too_large',
          'request data exceeds the byte limit',
        );
      }
    } on PocketCapabilityException {
      rethrow;
    } on Object {
      throw PocketCapabilityException(
        'invalid_request',
        '$field must be JSON-safe',
      );
    }
  }

  static void _validateResponsePayload(Object? value, int limit) {
    try {
      if (utf8.encode(jsonEncode(value)).length > limit) {
        throw const PocketCapabilityException(
          'response_too_large',
          'encoded response exceeds the byte limit',
        );
      }
    } on PocketCapabilityException {
      rethrow;
    } on Object {
      throw const PocketCapabilityException(
        'response_invalid',
        'response is not JSON-safe',
      );
    }
  }

  static Set<String> _normalizeOrigins(Iterable<String> origins) {
    final result = <String>{};
    for (final raw in origins) {
      if (raw.length > 2048) throw ArgumentError.value(raw, 'allowedOrigins');
      final uri = Uri.tryParse(raw);
      if (uri == null ||
          (uri.scheme != 'http' && uri.scheme != 'https') ||
          uri.host.isEmpty ||
          uri.userInfo.isNotEmpty ||
          (uri.hasPort && uri.port == 0) ||
          (uri.path.isNotEmpty && uri.path != '/') ||
          uri.hasQuery ||
          uri.hasFragment) {
        throw ArgumentError.value(
          raw,
          'allowedOrigins',
          'must be an exact http(s) origin without path, query or fragment',
        );
      }
      result.add(_originOf(uri));
    }
    return Set<String>.unmodifiable(result);
  }

  static String _originOf(Uri uri) {
    final scheme = uri.scheme.toLowerCase();
    final host = uri.host.toLowerCase();
    final isDefaultPort =
        (scheme == 'http' && uri.port == 80) ||
        (scheme == 'https' && uri.port == 443) ||
        uri.port == 0;
    final hostPart = host.contains(':') ? '[$host]' : host;
    return '$scheme://$hostPart${isDefaultPort ? '' : ':${uri.port}'}';
  }

  static Duration _boundedTimeout(Duration value) {
    if (value <= Duration.zero)
      throw ArgumentError.value(value, 'requestTimeout');
    return value > const Duration(minutes: 2)
        ? const Duration(minutes: 2)
        : value;
  }

  static int _boundedResponseLimit(int value) {
    if (value <= 0) throw ArgumentError.value(value, 'maxResponseBytes');
    return math.min(value, _hardMaxResponseBytes);
  }
}
