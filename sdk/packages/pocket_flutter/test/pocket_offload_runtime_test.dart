import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/src/pocket_offload_runtime.dart';

PocketOffloadRequest _request({
  int id = 1,
  required String method,
  required String payload,
  Duration timeout = const Duration(seconds: 5),
}) => PocketOffloadRequest(
  key: PocketOffloadKey(generation: 3, session: 9, id: id),
  method: method,
  payload: payload,
  timeout: timeout,
);

void main() {
  test('bounds serialized errors on Unicode scalar boundaries', () {
    final key = PocketOffloadKey(generation: 3, session: 9, id: 1);
    final message = List<String>.filled(200, '😀').join();
    final record = PocketOffloadCompletion.failure(
      key,
      message,
    ).toNativeRecord();
    final error =
        (jsonDecode(record) as Map<String, Object?>)['error']! as String;
    expect(error.runes.length, 160);
    expect(error, List<String>.filled(160, '😀').join());
  });

  test('host provider leaves pure computation to the JS Worker', () async {
    final provider = PocketBoundedOffloadProvider(session: 9);
    addTearDown(provider.close);
    expect(provider.methods, isEmpty);
    await expectLater(
      provider.execute(
        _request(method: 'compute.sum', payload: '[1,2.5,3]'),
        PocketOffloadCancellationToken(),
      ),
      throwsUnsupportedError,
    );
  });

  test(
    'performs granted HTTP and validates redirects before opening them',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final outside = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var outsideRequests = 0;
      outside.listen((request) {
        outsideRequests++;
        request.response.write('should not be reached');
        request.response.close();
      });
      server.listen((request) async {
        if (request.uri.path == '/redirect') {
          request.response.statusCode = HttpStatus.found;
          request.response.headers.set(HttpHeaders.locationHeader, '/ok');
          await request.response.close();
        } else if (request.uri.path == '/outside') {
          request.response.statusCode = HttpStatus.found;
          request.response.headers.set(
            HttpHeaders.locationHeader,
            'http://127.0.0.1:${outside.port}/blocked',
          );
          await request.response.close();
        } else {
          request.response.write('local-ok');
          await request.response.close();
        }
      });
      final origin = 'http://127.0.0.1:${server.port}';
      final provider = PocketBoundedOffloadProvider(
        session: 9,
        allowedHttpOrigins: [origin],
      );
      addTearDown(() async {
        await provider.close();
        await server.close(force: true);
        await outside.close(force: true);
      });

      final redirectResult = await provider.execute(
        _request(
          method: 'http.request',
          payload: jsonEncode({'url': '$origin/redirect'}),
        ),
        PocketOffloadCancellationToken(),
      );
      expect(jsonDecode(redirectResult), {
        'status': HttpStatus.ok,
        'body': 'local-ok',
      });

      await expectLater(
        provider.execute(
          _request(
            id: 2,
            method: 'http.request',
            payload: jsonEncode({'url': '$origin/outside'}),
          ),
          PocketOffloadCancellationToken(),
        ),
        throwsA(isA<FormatException>()),
      );
      expect(outsideRequests, 0);
    },
  );

  test(
    'aborts an in-flight HTTP operation when native cancellation arrives',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final entered = Completer<void>();
      final releaseServer = Completer<void>();
      server.listen((request) async {
        if (!entered.isCompleted) entered.complete();
        await releaseServer.future;
        try {
          request.response.write('late');
          await request.response.close();
        } on Object {
          // The provider has already aborted this client request.
        }
      });
      final origin = 'http://127.0.0.1:${server.port}';
      final provider = PocketBoundedOffloadProvider(
        session: 9,
        allowedHttpOrigins: [origin],
      );
      addTearDown(() async {
        if (!releaseServer.isCompleted) releaseServer.complete();
        await provider.close();
        await server.close(force: true);
      });
      final request = _request(
        method: 'http.request',
        payload: jsonEncode({'url': '$origin/slow'}),
      );
      final cancellation = PocketOffloadCancellationToken();
      final pending = provider.execute(request, cancellation);
      await entered.future.timeout(const Duration(seconds: 2));
      provider.cancel(request);
      await expectLater(pending, throwsA(isA<PocketOffloadCancelled>()));
    },
  );
}
