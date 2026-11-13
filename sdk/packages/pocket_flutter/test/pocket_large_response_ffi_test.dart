import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_flutter/pocket_flutter.dart';

// Regression for sdk/docs/LARGE_HOST_RESPONSE_DELIVERY.md on the real FFI path.
Map<String, dynamic> _response(String id, int size) => <String, dynamic>{
  'type': 'event',
  'name': 'host.response',
  'payload': <String, dynamic>{
    'requestId': id,
    'capability': 'test.big',
    'ok': true,
    'result': <String, dynamic>{'data': 'x' * size},
  },
};

/// POCKET_REQUIRE_REAL=1 turns a missing prerequisite into a failure instead of a skip.
void requireReal(Object? skipReason) {
  if (skipReason != null && skipReason != false && Platform.environment['POCKET_REQUIRE_REAL'] == '1') {
    fail('POCKET_REQUIRE_REAL=1: $skipReason');
  }
}

void main() {
  final libraryPath = Platform.environment['POCKET_NATIVE_LIBRARY'];
  final skip = libraryPath == null || libraryPath.isEmpty
      ? 'POCKET_NATIVE_LIBRARY is required'
      : null;
  requireReal(skip);

  test('back-to-back large host.response messages are all delivered', () {
    final runtime = FfiPocketRuntime.open(width: 64, height: 64);
    try {
      runtime.eval(r'''
        const seen = [];
        globalThis.frame = () => {};
        globalThis.__pocketEvent = (packet) => {
          if (packet.name === 'host.response') {
            seen.push(packet.payload.requestId + ':' + packet.payload.result.data.length);
            pocket._emit(JSON.stringify({type: 'event', name: 'seen', payload: {seen: seen.join(',')}}));
          }
        };
        globalThis.__pocketEvent.__binaryCapable = true;
      ''');
      runtime.frame(16);
      for (final size in <int>[100000, 180000, 200000]) {
        runtime.send(_response('a', size));
        runtime.send(_response('b', size));
        final frame = runtime.frame(16);
        final payloads = frame.events
            .where((event) => event.method == 'seen')
            .map((event) => event.params['seen'] as String)
            .toList();
        expect(payloads, isNotEmpty, reason: 'size=$size');
        final last = payloads.last;
        expect(last.endsWith('a:$size,b:$size'), isTrue, reason: last);
      }
    } finally {
      runtime.dispose();
    }
  }, skip: skip);

  test('a continuation over the turn budget is an explicit frame error', () {
    final runtime = FfiPocketRuntime.open(width: 64, height: 64);
    try {
      runtime.eval(r'''
        let release;
        globalThis.frame = () => {};
        new Promise((resolve) => { release = resolve; }).then(() => {
          const start = Date.now();
          while (Date.now() - start < 700) {}
          pocket._emit(JSON.stringify({type: 'event', name: 'spun', payload: {}}));
        });
        globalThis.__pocketEvent = () => { release(); };
        globalThis.__pocketEvent.__binaryCapable = true;
      ''');
      runtime.frame(16);
      runtime.send(_response('a', 10));
      expect(
        () => runtime.frame(16),
        throwsA(
          isA<PocketRuntimeException>().having(
            (error) => error.toString(),
            'message',
            contains('interrupted by budget'),
          ),
        ),
      );
    } finally {
      runtime.dispose();
    }
  }, skip: skip);
}
