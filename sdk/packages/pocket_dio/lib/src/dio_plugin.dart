// Dio exposes ResponseBody.close as an internal adapter cleanup hook. The
// provider reads bounded streams itself, so it must call that hook on both
// normal completion and quota cancellation.
// ignore_for_file: invalid_use_of_internal_member

import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:pocket_services/pocket_services.dart';

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
    Dio? dio,
    Duration requestTimeout = const Duration(seconds: 30),
    int maxResponseBytes = _hardMaxResponseBytes,
  }) : _allowedOrigins = _normalizeOrigins(allowedOrigins),
       _dio = dio ?? Dio(),
       _ownsDio = dio == null,
       requestTimeout = _boundedTimeout(requestTimeout),
       maxResponseBytes = _boundedResponseLimit(maxResponseBytes);

  final Set<String> _allowedOrigins;
  final Dio _dio;
  final bool _ownsDio;
  final Set<CancelToken> _inFlight = <CancelToken>{};
  final Duration requestTimeout;
  final int maxResponseBytes;
  bool _disposed = false;

  /// Canonical origins granted to this provider.
  Set<String> get allowedOrigins => Set<String>.unmodifiable(_allowedOrigins);

  /// Number of requests currently owned by this plugin.
  int get inFlightCount => _inFlight.length;

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
  Future<Object?> request(Map<String, dynamic> params) async {
    if (_disposed) {
      throw const PocketCapabilityException(
        'plugin_disposed',
        'Dio plugin is disposed',
      );
    }
    final url = _parseUrl(params['url']);
    final origin = _originOf(url);
    if (!_allowedOrigins.contains(origin)) {
      throw PocketCapabilityException(
        'origin_denied',
        'HTTP origin is not allowed: $origin',
      );
    }

    final method = _parseMethod(params['method']);
    final headers = _parseHeaders(params['headers']);
    final queryParameters = _parseQueryParameters(params['queryParameters']);
    final data = params['data'];
    _validateJsonOrBytes(data, 'data', _hardMaxRequestBytes);
    final responseType = _parseResponseType(params['responseType']);
    final timeout = _parseTimeout(params['timeoutMs']);
    final cancelToken = CancelToken();
    _inFlight.add(cancelToken);
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
              throw const PocketCapabilityException(
                'request_timeout',
                'Dio request exceeded its deadline',
              );
            },
          );
      final body = response.data;
      if (body is! ResponseBody) {
        throw const PocketCapabilityException(
          'response_invalid',
          'Dio did not return a response stream',
        );
      }
      final remaining = timeout - stopwatch.elapsed;
      if (remaining <= Duration.zero) {
        cancelToken.cancel('request deadline exceeded');
        throw const PocketCapabilityException(
          'request_timeout',
          'Dio request exceeded its deadline',
        );
      }
      final bytes = await _readBounded(body, cancelToken).timeout(
        remaining,
        onTimeout: () {
          cancelToken.cancel('request deadline exceeded');
          throw const PocketCapabilityException(
            'request_timeout',
            'Dio response exceeded its deadline',
          );
        },
      );
      final decoded = _decode(bytes, responseType, body.headers);
      final result = <String, Object?>{
        'statusCode': response.statusCode ?? 0,
        'headers': _responseHeaders(body.headers),
        'data': decoded,
      };
      _validateResponsePayload(result, maxResponseBytes);
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
    } catch (error) {
      throw PocketCapabilityException('request_failed', '$error');
    } finally {
      _inFlight.remove(cancelToken);
    }
  }

  @override
  Future<void> deactivate(PocketPluginContext context) async {
    _cancelInFlight('plugin deactivated');
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _cancelInFlight('plugin disposed');
    if (_ownsDio) _dio.close(force: true);
  }

  void _cancelInFlight(Object reason) {
    for (final token in _inFlight.toList(growable: false)) {
      token.cancel(reason);
    }
  }

  Duration _parseTimeout(Object? value) {
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

  Future<List<int>> _readBounded(
    ResponseBody body,
    CancelToken cancelToken,
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
