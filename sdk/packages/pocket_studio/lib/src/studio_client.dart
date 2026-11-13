import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pocket_services/pocket_services.dart';

import 'studio_scrub.dart';

/// Result of one service round trip. [json] is already scrubbed.
final class StudioHttpResult {
  const StudioHttpResult(this.status, this.json, this.bytes, this.contentType);
  final int status;
  final Object? json;
  final Uint8List? bytes;
  final String contentType;
}

/// Loopback-only HTTP client for the Studio service. It holds exactly one
/// cached value, the CSRF token read from `/health`, and never returns it.
final class StudioServiceClient {
  StudioServiceClient({
    required this.origin,
    required this.scrubber,
    this.requestTimeout = const Duration(seconds: 30),
    this.maxBodyBytes = 2 * 1024 * 1024,
  }) {
    final host = origin.host;
    if (origin.scheme != 'http' ||
        !(host == '127.0.0.1' || host == 'localhost' || host == '::1') ||
        !origin.hasPort) {
      throw ArgumentError.value(origin, 'origin', 'Studio service must be loopback http with a port');
    }
    _client = _newClient();
  }

  final Uri origin;
  final StudioPathScrubber scrubber;
  final Duration requestTimeout;
  final int maxBodyBytes;
  late HttpClient _client;
  String? _csrf;
  Future<void>? _rootsLoaded;
  bool _closed = false;

  HttpClient _newClient() => HttpClient()
    ..connectionTimeout = const Duration(seconds: 3)
    ..idleTimeout = const Duration(seconds: 5)
    ..findProxy = ((_) => 'DIRECT');

  Uri url(List<String> segments, [Map<String, String>? query]) => Uri(
    scheme: 'http',
    host: origin.host == '::1' ? '[::1]' : origin.host,
    port: origin.port,
    pathSegments: segments,
    queryParameters: query == null || query.isEmpty ? null : query,
  );

  void close() {
    _closed = true;
    _client.close(force: true);
  }

  /// Learns the service's absolute roots from `/health` so they can be
  /// scrubbed. Never throws; the generic scrub rules still apply.
  Future<void> ensureRoots() => _rootsLoaded ??= _loadRoots();

  Future<void> _loadRoots() async {
    try {
      final json = await _unscrubbedHealth();
      {
        void root(String key, String label) {
          final v = json[key];
          if (v is String) scrubber.addRoot(v, label);
        }

        root('workspace', '<workspace>');
        root('projectRoot', '<project>');
        root('flutterRoot', '<flutter>');
        final token = json['csrfToken'];
        if (token is String) {
          _csrf = token;
          scrubber.addSecret(token);
        }
      }
    } on Object {
      _rootsLoaded = null;
    }
  }

  /// Raw JSON health (host side). The guest only ever sees [scrubber] output.
  Future<Map<String, dynamic>> health() => _unscrubbedHealth();

  Future<String> _csrfToken({bool refresh = false}) async {
    if (!refresh && _csrf != null) return _csrf!;
    final token = (await _unscrubbedHealth())['csrfToken'];
    if (token is! String || token.isEmpty) {
      throw const PocketCapabilityException('service_error', 'service did not provide a write token');
    }
    scrubber.addSecret(token);
    return _csrf = token;
  }

  Future<Map<String, dynamic>> _unscrubbedHealth() async {
    final response = await _fetch('GET', url(const <String>['health']), null, null, maxBodyBytes);
    if (response.status != 200) {
      throw PocketCapabilityException(errorCodeForStatus(response.status), 'Studio service health failed (HTTP ${response.status})');
    }
    try {
      final decoded = jsonDecode(utf8.decode(response.bytes));
      if (decoded is Map<String, dynamic>) return decoded;
    } on FormatException {
      // fall through
    }
    throw const PocketCapabilityException('invalid_response', 'service returned a malformed health document');
  }

  /// Sends one request. [write] requests carry `x-pocket-csrf`.
  Future<StudioHttpResult> send(
    String method,
    List<String> segments, {
    Map<String, String>? query,
    Object? body,
    bool write = false,
    bool raw = false,
  }) async {
    await ensureRoots();
    return _raw(method, url(segments, query), body, write, raw: raw);
  }

  Future<StudioHttpResult> _raw(String method, Uri uri, Object? body, bool write, {bool raw = false}) async {
    var refreshed = false;
    while (true) {
      final token = write ? await _csrfToken(refresh: refreshed) : null;
      final response = await _fetch(method, uri, body, token, maxBodyBytes);
      if (write && response.status == 403 && !refreshed) {
        refreshed = true; // service restarted: token rotated
        _csrf = null;
        continue;
      }
      return _finish(response, raw: raw);
    }
  }

  StudioHttpResult _finish(_Raw response, {bool raw = false}) {
    final type = response.contentType;
    final isJson = type.contains('json') && !(raw && response.status >= 200 && response.status < 300);
    Object? json;
    if (isJson && response.bytes.isNotEmpty) {
      try {
        json = scrubber.scrubJson(jsonDecode(utf8.decode(response.bytes)));
      } on FormatException {
        throw const PocketCapabilityException('invalid_response', 'service returned malformed JSON');
      }
    }
    if (response.status < 200 || response.status >= 300) {
      String message = 'HTTP ${response.status}';
      if (json is Map && json['error'] is String) {
        message = '${json['error']} (HTTP ${response.status})';
      } else if (!isJson && response.bytes.isNotEmpty && response.bytes.length < 512) {
        message = scrubber.scrubString(utf8.decode(response.bytes, allowMalformed: true));
      }
      throw PocketCapabilityException(errorCodeForStatus(response.status), message);
    }
    return StudioHttpResult(response.status, json, isJson ? null : response.bytes, type);
  }

  static String errorCodeForStatus(int status) => switch (status) {
    400 => 'invalid_request',
    401 || 403 => 'forbidden',
    404 => 'not_found',
    405 => 'invalid_request',
    409 => 'conflict',
    413 => 'too_large',
    415 => 'invalid_request',
    422 => 'checksum_mismatch',
    429 => 'too_many_requests',
    501 => 'unsupported',
    _ => status >= 500 ? 'service_error' : 'invalid_request',
  };

  Future<_Raw> _fetch(String method, Uri uri, Object? body, String? csrf, int maxBytes) async {
    if (_closed) throw const PocketCapabilityException('plugin_disposed', 'Studio provider is closed');
    try {
      return await () async {
        final request = await _client.openUrl(method, uri);
        request.followRedirects = false;
        request.headers.set(HttpHeaders.acceptHeader, 'application/json');
        if (csrf != null) request.headers.set('x-pocket-csrf', csrf);
        if (body != null) {
          request.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
          request.add(utf8.encode(jsonEncode(body)));
        }
        final response = await request.close();
        final builder = BytesBuilder(copy: false);
        await for (final chunk in response) {
          builder.add(chunk);
          if (builder.length > maxBytes) {
            _client.close(force: true);
            _client = _newClient();
            throw PocketCapabilityException('too_large', 'service response exceeds $maxBytes bytes');
          }
        }
        return _Raw(response.statusCode, builder.takeBytes(), response.headers.contentType?.mimeType ?? '');
      }().timeout(requestTimeout);
    } on PocketCapabilityException {
      rethrow;
    } on TimeoutException {
      throw const PocketCapabilityException('service_timeout', 'Studio service did not answer in time');
    } on SocketException {
      throw const PocketCapabilityException('service_unreachable', 'Studio service is not reachable');
    } on HttpException {
      throw const PocketCapabilityException('service_unreachable', 'Studio service connection failed');
    }
  }

  /// Opens an SSE route on a dedicated connection (closed on cancel so the
  /// service releases its stream slot). Events are JSON-decoded and scrubbed.
  Stream<Object?> sse(List<String> segments) {
    late StreamController<Object?> controller;
    HttpClient? client;
    StreamSubscription<String>? lines;
    controller = StreamController<Object?>(
      onListen: () async {
        await ensureRoots();
        client = _newClient();
        try {
          final request = await client!.openUrl('GET', url(segments));
          request.followRedirects = false;
          request.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
          final response = await request.close().timeout(requestTimeout);
          if (response.statusCode != 200) {
            final builder = BytesBuilder();
            await for (final chunk in response) {
              builder.add(chunk);
              if (builder.length > 64 * 1024) break;
            }
            try {
              _finish(_Raw(response.statusCode, builder.takeBytes(), response.headers.contentType?.mimeType ?? ''));
            } on PocketCapabilityException catch (error) {
              controller.addError(error);
            }
            await controller.close();
            return;
          }
          final data = StringBuffer();
          lines = response.transform(utf8.decoder).transform(const LineSplitter()).listen(
            (line) {
              if (line.isEmpty) {
                if (data.isNotEmpty) {
                  final text = data.toString();
                  data.clear();
                  if (text.length <= 256 * 1024) {
                    try {
                      controller.add(scrubber.scrubJson(jsonDecode(text)));
                    } on FormatException {
                      // Ignore a malformed event; the stream continues.
                    }
                  }
                }
              } else if (line.startsWith('data:')) {
                if (data.length <= 256 * 1024) data.write(line.substring(5).trimLeft());
              }
            },
            onError: (Object _) {
              controller.addError(const PocketCapabilityException('service_stream_error', 'Studio service stream failed'));
              controller.close();
            },
            onDone: () => controller.close(),
            cancelOnError: true,
          );
        } on PocketCapabilityException catch (error) {
          controller.addError(error);
          await controller.close();
        } on Object {
          controller.addError(const PocketCapabilityException('service_unreachable', 'Studio service is not reachable'));
          await controller.close();
        }
      },
      onCancel: () async {
        await lines?.cancel();
        client?.close(force: true);
      },
    );
    return controller.stream;
  }
}

final class _Raw {
  const _Raw(this.status, this.bytes, this.contentType);
  final int status;
  final Uint8List bytes;
  final String contentType;
}
