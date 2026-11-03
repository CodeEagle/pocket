import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// Stable identity for one native provider request. All three fields are
/// checked before a result is delivered back to QuickJS.
final class PocketOffloadKey {
  const PocketOffloadKey({
    required this.generation,
    required this.session,
    required this.id,
  });

  final int generation;
  final int session;
  final int id;

  @override
  bool operator ==(Object other) =>
      other is PocketOffloadKey &&
      generation == other.generation &&
      session == other.session &&
      id == other.id;

  @override
  int get hashCode => Object.hash(generation, session, id);
}

/// Bounded request record decoded from the pinned io.offload protocol.
final class PocketOffloadRequest {
  const PocketOffloadRequest({
    required this.key,
    required this.method,
    required this.payload,
    required this.timeout,
  });

  final PocketOffloadKey key;
  final String method;
  final String payload;
  final Duration timeout;

  int get generation => key.generation;
  int get session => key.session;
  int get id => key.id;

  Map<String, Object> toJson() => {
    'generation': generation,
    'session': session,
    'id': id,
    'method': method,
    'payload': payload,
    'timeoutMicros': timeout.inMicroseconds,
  };

  static PocketOffloadRequest fromJson(Map<String, Object?> value) {
    int integer(String field) {
      final candidate = value[field];
      if (candidate is! int || candidate < 1 || candidate > 0xffffffff) {
        throw FormatException('invalid offload $field');
      }
      return candidate;
    }

    final id = value['id'];
    if (id is! int || id < 1 || id > 9007199254740991) {
      throw const FormatException('invalid offload id');
    }
    final method = value['method'];
    final payload = value['payload'];
    final timeoutMicros = value['timeoutMicros'];
    if (method is! String || !_validMethod(method)) {
      throw const FormatException('invalid offload method');
    }
    if (payload is! String || utf8.encode(payload).length > 4096) {
      throw const FormatException('invalid offload payload');
    }
    if (timeoutMicros is! int ||
        timeoutMicros < 1 ||
        timeoutMicros > 3600000000) {
      throw const FormatException('invalid offload timeout');
    }
    return PocketOffloadRequest(
      key: PocketOffloadKey(
        generation: integer('generation'),
        session: integer('session'),
        id: id,
      ),
      method: method,
      payload: payload,
      timeout: Duration(microseconds: timeoutMicros),
    );
  }
}

/// Completion body passed back to native `offload_complete`.
final class PocketOffloadCompletion {
  const PocketOffloadCompletion.success(this.key, this.payload) : error = null;
  const PocketOffloadCompletion.failure(this.key, this.error) : payload = null;

  final PocketOffloadKey key;
  final String? payload;
  final String? error;

  Map<String, Object> toJson() => {
    'generation': key.generation,
    'session': key.session,
    'id': key.id,
    if (payload != null) 'payload': payload!,
    if (error != null) 'error': _truncate(error!, 160),
  };

  String toNativeRecord() => jsonEncode({
    'generation': key.generation,
    'session': key.session,
    'id': key.id,
    if (payload != null) 'payload': payload!,
    if (error != null) 'error': _truncate(error!, 160),
  });
}

/// Cancellation travels with the provider future and also through `cancel`
/// so socket and isolate work can stop immediately.
final class PocketOffloadCancellationToken {
  final Completer<void> _cancelled = Completer<void>();

  bool get isCancelled => _cancelled.isCompleted;
  Future<void> get whenCancelled => _cancelled.future;

  void cancel() {
    if (!_cancelled.isCompleted) _cancelled.complete();
  }

  void throwIfCancelled() {
    if (isCancelled) throw const PocketOffloadCancelled();
  }
}

final class PocketOffloadCancelled implements Exception {
  const PocketOffloadCancelled();

  @override
  String toString() => 'offload request was cancelled';
}

/// A trusted app or companion provider executes explicitly registered methods.
/// Each invocation is asynchronous and every cancellation is scoped to a full
/// generation/session/request tuple.
abstract interface class PocketOffloadProvider {
  int get session;
  Set<String> get methods;

  Future<String> execute(
    PocketOffloadRequest request,
    PocketOffloadCancellationToken cancellation,
  );

  void cancel(PocketOffloadRequest request);
  Future<void> close();
}

/// Optional interface implemented by the native runtime owner. It is installed
/// before guest evaluation; the native host remains responsible for draining
/// and completing requests and for retaining its wake callback.
abstract interface class PocketOffloadRuntime {
  void configureOffload(
    PocketOffloadProvider? provider, {
    required void Function() onWake,
  });
}

/// Real bounded provider for small host-authorized HTTP operations.
/// Pure computation belongs in the JS Worker. It has no default network origins. Redirects
/// are followed manually, and every destination is checked against the same
/// exact origin grant before opening a new request.
final class PocketBoundedOffloadProvider implements PocketOffloadProvider {
  PocketBoundedOffloadProvider({
    required this.session,
    Iterable<String> allowedHttpOrigins = const [],
    this.maxConcurrent = 8,
    this.maxRequestBytes = 64 * 1024,
    this.maxResponseBytes = 1800,
    this.maxRedirects = 3,
    this.timeout = const Duration(seconds: 10),
  }) : allowedHttpOrigins = Set.unmodifiable(
         allowedHttpOrigins.map(_canonicalOrigin),
       ) {
    if (session < 1 || session > 0xffffffff) {
      throw const FormatException('offload session must be a nonzero uint32');
    }
    if (maxConcurrent < 1 ||
        maxConcurrent > 8 ||
        maxRequestBytes < 1 ||
        maxRequestBytes > 1024 * 1024 ||
        maxResponseBytes < 1 ||
        maxResponseBytes > 1800 ||
        maxRedirects < 0 ||
        maxRedirects > 3 ||
        timeout <= Duration.zero ||
        timeout > const Duration(minutes: 1)) {
      throw const FormatException('offload provider limits are out of range');
    }
    _client.connectionTimeout = timeout;
    _client.maxConnectionsPerHost = maxConcurrent;
  }

  @override
  final int session;
  final Set<String> allowedHttpOrigins;
  final int maxConcurrent;
  final int maxRequestBytes;
  final int maxResponseBytes;
  final int maxRedirects;
  final Duration timeout;

  final HttpClient _client = HttpClient();
  final Map<PocketOffloadKey, _ActiveOffload> _active = {};
  bool _closed = false;

  @override
  Set<String> get methods => {
    if (allowedHttpOrigins.isNotEmpty) 'http.request',
  };

  @override
  Future<String> execute(
    PocketOffloadRequest request,
    PocketOffloadCancellationToken cancellation,
  ) async {
    if (_closed) throw StateError('offload provider is closed');
    if (request.session != session) {
      throw StateError('offload request belongs to another provider session');
    }
    if (!methods.contains(request.method)) {
      throw UnsupportedError('Provider does not implement ${request.method}');
    }
    if (_active.length >= maxConcurrent) {
      throw StateError('offload provider concurrency limit reached');
    }
    if (_active.containsKey(request.key)) {
      throw StateError('duplicate offload request identity');
    }

    final active = _ActiveOffload(cancellation);
    _active[request.key] = active;
    final cancelListener = cancellation.whenCancelled.then((_) {
      _abort(request.key, active);
    });
    try {
      cancellation.throwIfCancelled();
      final result = switch (request.method) {
        'http.request' => await _runHttp(
          request,
          active,
        ).timeout(request.timeout),
        _ => throw UnsupportedError(
          'Provider does not implement ${request.method}',
        ),
      };
      cancellation.throwIfCancelled();
      if (utf8.encode(result).length > maxResponseBytes) {
        throw StateError('offload result exceeds response budget');
      }
      return result;
    } on TimeoutException {
      _abort(request.key, active);
      throw TimeoutException('offload request timed out', request.timeout);
    } on Object {
      if (cancellation.isCancelled) throw const PocketOffloadCancelled();
      rethrow;
    } finally {
      _active.remove(request.key);
      // Keep this future observed so cancellation during teardown never becomes
      // an unhandled asynchronous error.
      unawaited(cancelListener);
      active.dispose();
    }
  }

  Future<String> _runHttp(
    PocketOffloadRequest request,
    _ActiveOffload active,
  ) async {
    final inputBytes = utf8.encode(request.payload);
    if (inputBytes.length > maxRequestBytes) {
      throw const FormatException('HTTP request exceeds request budget');
    }
    final decoded = jsonDecode(request.payload);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('http.request payload must be a JSON object');
    }
    final url = decoded['url'];
    final method = decoded['method'] ?? 'GET';
    final headers = decoded['headers'] ?? const <String, Object?>{};
    final body = decoded['body'] ?? '';
    if (url is! String ||
        method is! String ||
        !RegExp(r'^(GET|POST|PUT|PATCH|DELETE|HEAD)$').hasMatch(method) ||
        headers is! Map<String, dynamic> ||
        body is! String ||
        utf8.encode(body).length > maxRequestBytes) {
      throw const FormatException('invalid bounded http.request fields');
    }
    var uri = Uri.parse(url);
    _checkUri(uri);
    var currentMethod = method;
    var currentBody = body;
    final requestHeaders = <String, String>{};
    for (final entry in headers.entries) {
      if (!_safeHeader(entry.key) ||
          entry.value is! String ||
          (entry.value as String).length > 512) {
        throw const FormatException('invalid HTTP request header');
      }
      requestHeaders[entry.key] = entry.value as String;
    }
    for (var redirect = 0; redirect <= maxRedirects; redirect++) {
      active.cancellation.throwIfCancelled();
      _checkUri(uri); // Revalidate every redirect target before DNS/socket IO.
      final req = await _client.openUrl(currentMethod, uri);
      req.followRedirects = false;
      active.request = req;
      req.headers.set(
        HttpHeaders.acceptHeader,
        'application/json, text/plain, */*',
      );
      for (final entry in requestHeaders.entries) {
        final key = entry.key;
        final value = entry.value;
        if (!_safeHeader(key) || value.length > 512) {
          throw const FormatException('invalid HTTP request header');
        }
        req.headers.set(key, value);
      }
      if (currentBody.isNotEmpty) {
        req.headers.contentType = ContentType.text;
        req.add(utf8.encode(currentBody));
      }
      final response = await req.close().timeout(request.timeout);
      if (_isRedirect(response.statusCode)) {
        if (redirect >= maxRedirects) {
          await response.drain<void>();
          throw const HttpException('too many HTTP redirects');
        }
        final location = response.headers.value(HttpHeaders.locationHeader);
        await response.drain<void>();
        active.request = null;
        if (location == null)
          throw const HttpException('redirect has no Location');
        final next = uri.resolve(location);
        _checkUri(next);
        if (!_sameOrigin(uri, next)) {
          requestHeaders.removeWhere(
            (key, _) => {
              'authorization',
              'cookie',
              'cookie2',
            }.contains(key.toLowerCase()),
          );
        }
        if (response.statusCode == HttpStatus.seeOther ||
            ((response.statusCode == HttpStatus.movedPermanently ||
                    response.statusCode == HttpStatus.found) &&
                currentMethod == 'POST')) {
          currentMethod = 'GET';
          currentBody = '';
        }
        uri = next;
        continue;
      }
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in response.timeout(request.timeout)) {
        active.cancellation.throwIfCancelled();
        if (bytes.length + chunk.length > maxResponseBytes) {
          req.abort(
            const HttpException('HTTP response exceeds provider budget'),
          );
          throw const HttpException('HTTP response exceeds provider budget');
        }
        bytes.add(chunk);
      }
      active.request = null;
      final responseBody = utf8.decode(
        bytes.takeBytes(),
        allowMalformed: false,
      );
      return jsonEncode({'status': response.statusCode, 'body': responseBody});
    }
    throw const HttpException('redirect limit exceeded');
  }

  void _checkUri(Uri uri) {
    if (uri.scheme != 'https' && uri.scheme != 'http' ||
        uri.userInfo.isNotEmpty ||
        uri.host.isEmpty ||
        uri.hasFragment) {
      throw const FormatException(
        'HTTP URL must be an origin-safe HTTP(S) URL',
      );
    }
    if (!allowedHttpOrigins.contains(_canonicalOrigin(uri.origin))) {
      throw const FormatException(
        'HTTP origin is not granted to this provider',
      );
    }
  }

  static bool _isRedirect(int status) =>
      status == HttpStatus.movedPermanently ||
      status == HttpStatus.found ||
      status == HttpStatus.seeOther ||
      status == HttpStatus.temporaryRedirect ||
      status == HttpStatus.permanentRedirect;

  static bool _sameOrigin(Uri left, Uri right) =>
      _canonicalOrigin(left.origin) == _canonicalOrigin(right.origin);

  static bool _safeHeader(String name) =>
      RegExp(r'^[!#$%&\x27*+.^_`|~0-9A-Za-z-]{1,64}$').hasMatch(name) &&
      name.toLowerCase() != HttpHeaders.hostHeader &&
      name.toLowerCase() != HttpHeaders.contentLengthHeader;

  static String _canonicalOrigin(String source) {
    final uri = Uri.parse(source);
    if ((uri.scheme != 'https' && uri.scheme != 'http') ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        (uri.path.isNotEmpty && uri.path != '/') ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw FormatException('invalid HTTP origin grant: $source');
    }
    return uri.origin.toLowerCase();
  }

  void _abort(PocketOffloadKey key, _ActiveOffload active) {
    active.request?.abort(const PocketOffloadCancelled());
    _active.remove(key);
  }

  @override
  void cancel(PocketOffloadRequest request) {
    final active = _active[request.key];
    if (active == null) return;
    active.cancellation.cancel();
    _abort(request.key, active);
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    for (final entry in _active.entries.toList()) {
      entry.value.cancellation.cancel();
      _abort(entry.key, entry.value);
    }
    _client.close(force: true);
  }
}

final class _ActiveOffload {
  _ActiveOffload(this.cancellation);

  final PocketOffloadCancellationToken cancellation;
  HttpClientRequest? request;

  void dispose() {
    request = null;
  }
}

bool _validMethod(String method) =>
    RegExp(r'^[a-z][a-z0-9_.-]{0,63}$').hasMatch(method);

String _truncate(String value, int maximum) {
  return String.fromCharCodes(value.runes.take(maximum));
}
