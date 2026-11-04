import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pocket_dio/pocket_dio.dart';
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  late HttpServer server;
  late String origin;

  setUp(() async {
    _redirectHits = 0;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    origin = 'http://127.0.0.1:${server.port}';
    unawaited(server.forEach(_handleRequest));
  });

  tearDown(() async {
    await server.close(force: true);
  });

  test('performs JSON, text, bytes and POST requests', () async {
    final plugin = PocketDioPlugin(allowedOrigins: [origin]);
    try {
      final json =
          await plugin.request(<String, dynamic>{
                'url': '$origin/json',
                'queryParameters': <String, dynamic>{'q': 'pocket'},
              })
              as Map;
      expect(json['statusCode'], 200);
      expect(json['data'], <String, dynamic>{'ok': true, 'query': 'pocket'});
      expect(json['headers'], containsPair('x-pocket', ['dio']));

      final text =
          await plugin.request(<String, dynamic>{
                'url': '$origin/text',
                'responseType': 'text',
              })
              as Map;
      expect(text['data'], 'hello pocket');

      final bytes =
          await plugin.request(<String, dynamic>{
                'url': '$origin/bytes',
                'responseType': 'bytes',
              })
              as Map;
      expect(bytes['data'], [0, 1, 2, 255]);

      final posted =
          await plugin.request(<String, dynamic>{
                'url': '$origin/post',
                'method': 'POST',
                'data': <String, dynamic>{'value': 7},
              })
              as Map;
      expect(posted['data'], <String, dynamic>{'value': 7});
    } finally {
      await plugin.dispose();
    }
  });

  test('returns non-2xx and does not follow redirects', () async {
    final plugin = PocketDioPlugin(allowedOrigins: [origin]);
    try {
      final status =
          await plugin.request(<String, dynamic>{'url': '$origin/status'})
              as Map;
      expect(status['statusCode'], 418);

      final redirect =
          await plugin.request(<String, dynamic>{'url': '$origin/redirect'})
              as Map;
      expect(redirect['statusCode'], 302);
      expect(_redirectHits, 1);
    } finally {
      await plugin.dispose();
    }
  });

  test('rejects malformed JSON only when the response declares JSON', () async {
    final plugin = PocketDioPlugin(allowedOrigins: [origin]);
    try {
      await expectLater(
        plugin.request(<String, dynamic>{'url': '$origin/invalid-json'}),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'response_decode',
          ),
        ),
      );
    } finally {
      await plugin.dispose();
    }
  });

  test('enforces exact origins and response byte limits', () async {
    final plugin = PocketDioPlugin(
      allowedOrigins: [origin],
      maxResponseBytes: 32,
    );
    try {
      await expectLater(
        plugin.request(<String, dynamic>{
          'url': 'http://localhost:${server.port}/json',
        }),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'origin_denied',
          ),
        ),
      );
      await expectLater(
        plugin.request(<String, dynamic>{'url': '$origin/large'}),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'response_too_large',
          ),
        ),
      );
      final encodedBytes = PocketDioPlugin(
        allowedOrigins: [origin],
        maxResponseBytes: 256,
      );
      try {
        await expectLater(
          encodedBytes.request(<String, dynamic>{
            'url': '$origin/binary-large',
            'responseType': 'bytes',
          }),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'response_too_large',
            ),
          ),
        );
      } finally {
        await encodedBytes.dispose();
      }
    } finally {
      await plugin.dispose();
    }
  });

  test('deactivate cancels in-flight requests', () async {
    final plugin = PocketDioPlugin(
      allowedOrigins: [origin],
      requestTimeout: const Duration(seconds: 10),
    );
    final context = PocketPluginContext(
      plugin: plugin.descriptor,
      appId: 'test.app',
      sessionId: 'test-session',
      registry: PocketHostRegistry(),
    );
    try {
      final pending = plugin.request(<String, dynamic>{
        'url': '$origin/slow',
        'responseType': 'text',
      });
      await _waitFor(() => plugin.inFlightCount == 1);
      await plugin.deactivate(context);
      await expectLater(pending, throwsA(isA<PocketCapabilityException>()));
      expect(plugin.inFlightCount, 0);
    } finally {
      context.dispose();
      await plugin.dispose();
    }
  });

  test(
    'applies requestTimeout to the complete request and response stream',
    () async {
      final plugin = PocketDioPlugin(
        allowedOrigins: [origin],
        requestTimeout: const Duration(milliseconds: 50),
      );
      final stopwatch = Stopwatch()..start();
      try {
        await expectLater(
          plugin.request(<String, dynamic>{'url': '$origin/slow'}),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'request_timeout',
            ),
          ),
        );
        expect(stopwatch.elapsed, lessThan(const Duration(seconds: 1)));
      } finally {
        await plugin.dispose();
      }
    },
  );

  test(
    'total deadline applies while a stream keeps delivering small chunks',
    () async {
      final plugin = PocketDioPlugin(
        allowedOrigins: [origin],
        requestTimeout: const Duration(milliseconds: 120),
      );
      final stopwatch = Stopwatch()..start();
      try {
        await expectLater(
          plugin.request(<String, dynamic>{
            'url': '$origin/slow-stream',
            'responseType': 'text',
          }),
          throwsA(
            isA<PocketCapabilityException>().having(
              (error) => error.code,
              'code',
              'request_timeout',
            ),
          ),
        );
        expect(stopwatch.elapsed, lessThan(const Duration(seconds: 1)));
      } finally {
        await plugin.dispose();
      }
    },
  );

  test('dispose cancels an in-flight request', () async {
    final plugin = PocketDioPlugin(
      allowedOrigins: [origin],
      requestTimeout: const Duration(seconds: 10),
    );
    try {
      final pending = plugin.request(<String, dynamic>{
        'url': '$origin/slow',
        'responseType': 'text',
      });
      await _waitFor(() => plugin.inFlightCount == 1);
      await plugin.dispose();
      await expectLater(pending, throwsA(isA<PocketCapabilityException>()));
      expect(plugin.inFlightCount, 0);
    } finally {
      await plugin.dispose();
    }
  });

  test('is admitted only when the network permission is granted', () async {
    final plugin = PocketDioPlugin(allowedOrigins: [origin]);
    final registry = PocketHostRegistry();
    final host = PocketHost(
      registry: registry,
      streams: PocketStreamBridge(send: (_, __) => true),
      allowedCapabilities: const <String>{pocketDioRequestCapability},
      send: (_, __) => true,
    );
    final manager = PocketPluginManager(
      host: host,
      appId: 'test.app',
      sessionId: 'test-session',
      allowedPermissions: const <String>{pocketDioNetworkPermission},
    );
    manager.register(plugin);
    try {
      final availability = await PocketPluginSession(manager).mountGuest(
        required: const <String>[pocketDioRequestCapability],
        requestedPermissions: const <String>[pocketDioNetworkPermission],
      );
      expect(availability.satisfied, isTrue);
      final result =
          await manager.invoke(pocketDioRequestCapability, {
                'url': '$origin/json',
              })
              as Map;
      expect(result['statusCode'], 200);
    } finally {
      await manager.dispose();
      host.dispose();
    }
  });

  test(
    'does not activate or issue requests without network permission',
    () async {
      final plugin = PocketDioPlugin(allowedOrigins: [origin]);
      final host = PocketHost(
        registry: PocketHostRegistry(),
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: const <String>{pocketDioRequestCapability},
        send: (_, __) => true,
      );
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.app',
        sessionId: 'test-session',
      )..register(plugin);
      try {
        await expectLater(
          PocketPluginSession(manager).mountGuest(
            required: const <String>[pocketDioRequestCapability],
            requestedPermissions: const <String>[pocketDioNetworkPermission],
          ),
          throwsA(isA<PocketCapabilityException>()),
        );
        expect(plugin.inFlightCount, 0);
      } finally {
        await manager.dispose();
        host.dispose();
      }
    },
  );
}

Future<void> _handleRequest(HttpRequest request) async {
  switch (request.uri.path) {
    case '/json':
      request.response.headers.add('x-pocket', 'dio');
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode(<String, dynamic>{
          'ok': true,
          'query': request.uri.queryParameters['q'],
        }),
      );
    case '/text':
      request.response.headers.contentType = ContentType.text;
      request.response.write('hello pocket');
    case '/bytes':
      request.response.add(<int>[0, 1, 2, 255]);
    case '/post':
      final body = await utf8.decoder.bind(request).join();
      request.response.headers.contentType = ContentType.json;
      request.response.write(body);
    case '/status':
      request.response.statusCode = 418;
      request.response.write('teapot');
    case '/invalid-json':
      request.response.headers.contentType = ContentType.json;
      request.response.write('{invalid');
    case '/redirect':
      _redirectHits++;
      request.response.statusCode = HttpStatus.found;
      request.response.headers.set(HttpHeaders.locationHeader, '/final');
    case '/final':
      request.response.write('followed');
    case '/large':
      request.response.add(List<int>.filled(64, 65));
    case '/binary-large':
      request.response.add(List<int>.filled(128, 65));
    case '/slow':
      await Future<void>.delayed(const Duration(seconds: 2));
      request.response.write('slow');
    case '/slow-stream':
      request.response.headers.contentType = ContentType.text;
      for (var i = 0; i < 20; i++) {
        request.response.write('chunk');
        await request.response.flush();
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    default:
      request.response.statusCode = HttpStatus.notFound;
  }
  await request.response.close();
}

var _redirectHits = 0;

Future<void> _waitFor(bool Function() condition) async {
  for (var i = 0; i < 100; i++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail('condition was not reached');
}
