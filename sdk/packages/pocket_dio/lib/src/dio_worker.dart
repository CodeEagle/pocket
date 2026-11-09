part of 'dio_plugin.dart';

final class _DioPendingRequest {
  _DioPendingRequest(this.id, this.params, this.deadlineMicros);

  final int id;
  final Map<String, dynamic> params;
  final int deadlineMicros;
  final Completer<Object?> completer = Completer<Object?>();
  Timer? timer;
  bool sent = false;
}

final class _DioWorker {
  _DioWorker({required this.events, required this.errors, required this.exits});

  final ReceivePort events;
  final ReceivePort errors;
  final ReceivePort exits;
  final Completer<void> startupSettled = Completer<void>();
  final Completer<void> exited = Completer<void>();
  final Set<int> cancelling = <int>{};
  Isolate? isolate;
  SendPort? commandPort;
  Timer? cancellationWatchdog;
  bool stopping = false;

  void closePorts() {
    cancellationWatchdog?.cancel();
    cancellationWatchdog = null;
    cancelling.clear();
    events.close();
    errors.close();
    exits.close();
  }
}

final class _DioWorkerStart {
  const _DioWorkerStart({
    required this.events,
    required this.allowedOrigins,
    required this.requestTimeoutMicros,
    required this.maxResponseBytes,
    required this.dioFactory,
  });

  final SendPort events;
  final List<String> allowedOrigins;
  final int requestTimeoutMicros;
  final int maxResponseBytes;
  final Dio Function()? dioFactory;
}

String _workerErrorMessage(Object? message) {
  if (message is List) return message.map((part) => '$part').join(': ');
  return '$message';
}

/// Creates one Dio client and services all admitted calls in this isolate.
/// This is an execution boundary, not a second plugin or capability registry.
void _dioWorkerMain(_DioWorkerStart start) {
  late final _DioExecutor executor;
  late final ReceivePort commands;
  try {
    final dio = start.dioFactory?.call() ?? Dio();
    executor = _DioExecutor(
      dio: dio,
      allowedOrigins: start.allowedOrigins.toSet(),
      requestTimeout: Duration(microseconds: start.requestTimeoutMicros),
      maxResponseBytes: start.maxResponseBytes,
    );
    commands = ReceivePort();
    start.events.send(<String, Object?>{
      'type': 'ready',
      'commandPort': commands.sendPort,
    });
  } on Object catch (error) {
    start.events.send(<String, Object?>{
      'type': 'startup_error',
      'message': 'Dio worker failed to initialize: $error',
    });
    return;
  }

  final active = <int, Future<void>>{};
  var stopping = false;

  Future<void> handleRequest(int id, Object? params, int deadlineMicros) async {
    try {
      if (params is! Map || params.keys.any((key) => key is! String)) {
        throw const PocketCapabilityException(
          'invalid_request',
          'request parameters must be an object',
        );
      }
      final requestParams = <String, dynamic>{
        for (final entry in params.entries) entry.key as String: entry.value,
      };
      final result = await executor.execute(id, requestParams, deadlineMicros);
      start.events.send(<String, Object?>{
        'type': 'result',
        'id': id,
        'value': result,
      });
    } on PocketCapabilityException catch (error) {
      start.events.send(<String, Object?>{
        'type': 'error',
        'id': id,
        'code': error.code,
        'message': error.message,
      });
    } on Object catch (error) {
      start.events.send(<String, Object?>{
        'type': 'error',
        'id': id,
        'code': 'request_failed',
        'message': '$error',
      });
    }
  }

  Future<void> shutdown() async {
    if (stopping) return;
    stopping = true;
    executor.cancelAll('Dio worker stopped');
    executor.close();
    commands.close();
    try {
      await Future.wait<void>(active.values).timeout(_workerShutdownGrace);
    } on Object {
      // The host will kill the isolate after the same bounded grace interval.
    }
  }

  commands.listen((Object? message) {
    if (message is! Map) return;
    switch (message['type']) {
      case 'request':
        if (stopping) return;
        final id = message['id'];
        final deadlineMicros = message['deadlineMicros'];
        if (id is! int || deadlineMicros is! int) return;
        final task = handleRequest(id, message['params'], deadlineMicros);
        active[id] = task;
        unawaited(task.whenComplete(() => active.remove(id)));
        break;
      case 'cancel':
        final id = message['id'];
        if (id is int) executor.cancel(id, 'request deadline exceeded');
        break;
      case 'shutdown':
        unawaited(shutdown());
        break;
    }
  });
}

/// Owns the only HTTP, stream reading, JSON decode and response validation
/// implementation. It is instantiated inside `_dioWorkerMain`.
final class _DioExecutor {
  _DioExecutor({
    required Dio dio,
    required Set<String> allowedOrigins,
    required this.requestTimeout,
    required this.maxResponseBytes,
  }) : _dio = dio,
       _allowedOrigins = allowedOrigins;

  final Dio _dio;
  final Set<String> _allowedOrigins;
  final Duration requestTimeout;
  final int maxResponseBytes;
  final Map<int, CancelToken> _tokens = <int, CancelToken>{};
  bool _closed = false;

  Future<Object?> execute(
    int id,
    Map<String, dynamic> params,
    int deadlineMicros,
  ) async {
    if (_closed) {
      throw const PocketCapabilityException(
        'request_cancelled',
        'Dio worker is stopped',
      );
    }
    final url = PocketDioPlugin._parseUrl(params['url']);
    final origin = PocketDioPlugin._originOf(url);
    if (!_allowedOrigins.contains(origin)) {
      throw PocketCapabilityException(
        'origin_denied',
        'HTTP origin is not allowed: $origin',
      );
    }

    final method = PocketDioPlugin._parseMethod(params['method']);
    final headers = PocketDioPlugin._parseHeaders(params['headers']);
    final queryParameters = PocketDioPlugin._parseQueryParameters(
      params['queryParameters'],
    );
    final data = params['data'];
    PocketDioPlugin._validateJsonOrBytes(data, 'data', _hardMaxRequestBytes);
    final responseType = PocketDioPlugin._parseResponseType(
      params['responseType'],
    );
    final requestedTimeout = PocketDioPlugin._parseTimeout(
      params['timeoutMs'],
      requestTimeout,
    );
    final remainingMicros =
        deadlineMicros - DateTime.now().microsecondsSinceEpoch;
    if (remainingMicros <= 0) _throwDeadline();
    final remaining = Duration(microseconds: remainingMicros);
    final timeout = requestedTimeout <= remaining
        ? requestedTimeout
        : remaining;
    final cancelToken = CancelToken();
    _tokens[id] = cancelToken;
    final stopwatch = Stopwatch()..start();

    try {
      final response = await _dio
          .request<dynamic>(
            url.toString(),
            data: data,
            queryParameters: queryParameters,
            cancelToken: cancelToken,
            options: Options(
              method: method,
              headers: headers,
              responseType: ResponseType.stream,
              sendTimeout: timeout,
              connectTimeout: timeout,
              receiveTimeout: timeout,
              followRedirects: false,
              maxRedirects: 0,
              validateStatus: (_) => true,
              receiveDataWhenStatusError: true,
            ),
          )
          .timeout(
            timeout,
            onTimeout: () {
              cancelToken.cancel('request deadline exceeded');
              _throwDeadline();
            },
          );
      final body = response.data;
      if (body is! ResponseBody) {
        throw const PocketCapabilityException(
          'response_invalid',
          'Dio did not return a response stream',
        );
      }
      final left = timeout - stopwatch.elapsed;
      if (left <= Duration.zero) {
        // No bounded reader was started, so release the response here.
        // ignore: invalid_use_of_internal_member
        body.close();
        cancelToken.cancel('request deadline exceeded');
        _throwDeadline();
      }
      final bytes =
          await PocketDioPlugin._readBounded(
            body,
            cancelToken,
            maxResponseBytes,
          ).timeout(
            left,
            onTimeout: () {
              cancelToken.cancel('request deadline exceeded');
              _throwDeadline(response: true);
            },
          );
      final decoded = PocketDioPlugin._decode(
        bytes,
        responseType,
        body.headers,
      );
      final result = <String, Object?>{
        'statusCode': response.statusCode ?? 0,
        'headers': PocketDioPlugin._responseHeaders(body.headers),
        'data': decoded,
      };
      PocketDioPlugin._validateResponsePayload(result, maxResponseBytes);
      return result;
    } on PocketCapabilityException {
      rethrow;
    } on DioException catch (error) {
      if (CancelToken.isCancel(error) || cancelToken.isCancelled) {
        throw const PocketCapabilityException(
          'request_cancelled',
          'Dio request was cancelled',
        );
      }
      throw PocketCapabilityException(
        'request_failed',
        error.message ?? 'Dio request failed',
      );
    } on FormatException catch (error) {
      throw PocketCapabilityException('response_decode', error.message);
    } on Object catch (error) {
      throw PocketCapabilityException('request_failed', '$error');
    } finally {
      _tokens.remove(id);
    }
  }

  void cancel(int id, Object reason) => _tokens[id]?.cancel(reason);

  void cancelAll(Object reason) {
    for (final token in _tokens.values.toList(growable: false)) {
      token.cancel(reason);
    }
  }

  void close() {
    if (_closed) return;
    _closed = true;
    cancelAll('Dio worker stopped');
    _dio.close(force: true);
  }

  Never _throwDeadline({bool response = false}) {
    throw PocketCapabilityException(
      'request_timeout',
      response
          ? 'Dio response exceeded its deadline'
          : 'Dio request exceeded its deadline',
    );
  }
}
