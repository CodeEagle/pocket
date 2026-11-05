import 'dart:async';

import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

void main() {
  test(
    'no-listener queue is bounded and reports overflow on the wire',
    () async {
      final sent = <Map<String, dynamic>>[];
      final bridge = PocketStreamBridge(
        maxBufferedMessages: 2,
        send: (method, params) {
          sent.add(<String, dynamic>{'method': method, ...params});
          return true;
        },
      );
      addTearDown(bridge.dispose);
      final port = bridge.open(topic: 'test.incoming');

      bridge.handle(_event('stream.data', port.streamId, 1));
      bridge.handle(_event('stream.data', port.streamId, 2));
      bridge.handle(_event('stream.data', port.streamId, 3));

      expect(port.isClosed, isTrue);
      expect(
        sent.where((packet) => packet['method'] == 'stream.error'),
        contains(
          predicate<Map<String, dynamic>>((packet) {
            final error = packet['error'];
            return error is Map && error['code'] == 'stream_buffer_overflow';
          }),
        ),
      );

      final values = <Object?>[];
      final errors = <Object?>[];
      final done = Completer<void>();
      port.data.listen(
        values.add,
        onError: (Object error) => errors.add(error),
        onDone: done.complete,
      );
      await done.future;
      expect(values, <Object?>[1, 2]);
      expect(errors.single, isA<PocketStreamBufferOverflowException>());
    },
  );

  test('paused queue counts actual controller pending events', () async {
    final sent = <Map<String, dynamic>>[];
    final bridge = PocketStreamBridge(
      maxBufferedMessages: 2,
      send: (method, params) {
        sent.add(<String, dynamic>{'method': method, ...params});
        return true;
      },
    );
    addTearDown(bridge.dispose);
    final port = bridge.open(topic: 'test.paused');
    final values = <Object?>[];
    final errors = <Object?>[];
    final done = Completer<void>();
    final subscription = port.data.listen(
      values.add,
      onError: (Object error) => errors.add(error),
      onDone: done.complete,
    );
    subscription.pause();

    bridge.handle(_event('stream.data', port.streamId, 1));
    bridge.handle(_event('stream.data', port.streamId, 2));
    bridge.handle(_event('stream.data', port.streamId, 3));
    expect(port.isClosed, isTrue);
    expect(
      sent.where((packet) => packet['method'] == 'stream.error'),
      hasLength(1),
    );

    subscription.resume();
    await done.future;
    expect(values, <Object?>[1, 2]);
    expect(errors.single, isA<PocketStreamBufferOverflowException>());
  });

  test('normal end drains buffered data for a late listener', () async {
    final bridge = PocketStreamBridge(send: (_, __) => true);
    addTearDown(bridge.dispose);
    final port = bridge.open(topic: 'test.end');
    bridge.handle(_event('stream.data', port.streamId, 'a'));
    bridge.handle(_event('stream.data', port.streamId, 'b'));
    bridge.handle(_event('stream.end', port.streamId));

    final values = <Object?>[];
    final done = Completer<void>();
    port.data.listen(values.add, onDone: done.complete);
    await done.future;
    expect(values, <Object?>['a', 'b']);
  });

  test('remote errors remain errors after already-buffered data', () async {
    final bridge = PocketStreamBridge(send: (_, __) => true);
    addTearDown(bridge.dispose);
    final port = bridge.open(topic: 'test.remote-error');
    bridge.handle(_event('stream.data', port.streamId, 7));
    bridge.handle(
      PocketEvent(
        id: 'test',
        method: 'stream.error',
        params: <String, dynamic>{
          'streamId': port.streamId,
          'error': <String, dynamic>{'code': 'provider_failed'},
        },
      ),
    );

    final values = <Object?>[];
    final errors = <Object?>[];
    final done = Completer<void>();
    port.data.listen(
      values.add,
      onError: (Object error) => errors.add(error),
      onDone: done.complete,
    );
    await done.future;
    expect(values, <Object?>[7]);
    expect(errors.single, isA<PocketStreamRemoteException>());
  });

  test('canceling the data subscription releases the remote stream', () async {
    final sent = <Map<String, dynamic>>[];
    final bridge = PocketStreamBridge(
      send: (method, params) {
        sent.add(<String, dynamic>{'method': method, ...params});
        return true;
      },
    );
    addTearDown(bridge.dispose);
    final port = bridge.open(topic: 'test.cancel');
    final subscription = port.data.listen((_) {});
    await subscription.cancel();

    expect(port.isClosed, isTrue);
    expect(
      sent,
      contains(
        equals(<String, dynamic>{
          'method': 'stream.cancel',
          'streamId': port.streamId,
          'reason': 'listener_cancelled',
        }),
      ),
    );
    bridge.handle(_event('stream.data', port.streamId, 'late'));
  });

  test('dispose terminates a paused stream and ignores late packets', () async {
    final bridge = PocketStreamBridge(
      maxBufferedMessages: 2,
      send: (_, __) => true,
    );
    final port = bridge.open(topic: 'test.dispose');
    final errors = <Object?>[];
    final done = Completer<void>();
    final subscription = port.data.listen(
      (_) {},
      onError: (Object error) => errors.add(error),
      onDone: done.complete,
    );
    subscription.pause();
    bridge.handle(_event('stream.data', port.streamId, 1));
    bridge.dispose();
    bridge.handle(_event('stream.data', port.streamId, 2));
    subscription.resume();

    await done.future;
    expect(port.isClosed, isTrue);
    expect(errors.single, isA<PocketStreamProtocolException>());
  });

  test('batch admission is bounded and nested batches are ignored', () async {
    final bridge = PocketStreamBridge(send: (_, __) => true);
    addTearDown(bridge.dispose);
    final port = bridge.open(topic: 'test.batch');
    final oversized = <Map<String, dynamic>>[
      for (
        var index = 0;
        index < PocketStreamBridge.maxBatchMessages + 1;
        index++
      )
        <String, dynamic>{
          'method': 'stream.data',
          'params': <String, dynamic>{'streamId': port.streamId, 'data': index},
        },
    ];
    bridge.handle(
      PocketEvent(
        id: 'batch',
        method: 'stream.batch',
        params: <String, dynamic>{'events': oversized},
      ),
    );
    bridge.handle(
      PocketEvent(
        id: 'nested',
        method: 'stream.batch',
        params: <String, dynamic>{
          'events': <Map<String, dynamic>>[
            <String, dynamic>{
              'method': 'stream.batch',
              'params': <String, dynamic>{
                'events': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'method': 'stream.data',
                    'params': <String, dynamic>{
                      'streamId': port.streamId,
                      'data': 'nested',
                    },
                  },
                ],
              },
            },
          ],
        },
      ),
    );
    bridge.handle(_event('stream.data', port.streamId, 'accepted'));
    bridge.handle(_event('stream.end', port.streamId));

    final values = <Object?>[];
    final done = Completer<void>();
    port.data.listen(values.add, onDone: done.complete);
    await done.future;
    expect(values, <Object?>['accepted']);
  });

  test('reentrant delivery remains ordered and bounded', () async {
    final sent = <Map<String, dynamic>>[];
    final bridge = PocketStreamBridge(
      maxBufferedMessages: 1,
      send: (method, params) {
        sent.add(<String, dynamic>{'method': method, ...params});
        return true;
      },
    );
    addTearDown(bridge.dispose);
    final port = bridge.open(topic: 'test.reentrant');
    final values = <Object?>[];
    final errors = <Object?>[];
    final done = Completer<void>();
    port.data.listen(
      (value) {
        values.add(value);
        if (value == 1) {
          bridge.handle(_event('stream.data', port.streamId, 2));
          bridge.handle(_event('stream.data', port.streamId, 3));
        }
      },
      onError: (Object error) => errors.add(error),
      onDone: done.complete,
    );
    bridge.handle(_event('stream.data', port.streamId, 1));

    await Future<void>.delayed(Duration.zero);
    expect(port.isClosed, isTrue);
    expect(values, <Object?>[1, 2]);
    expect(errors.single, isA<PocketStreamBufferOverflowException>());
    expect(
      sent.where((packet) => packet['method'] == 'stream.error'),
      hasLength(1),
    );
  });

  test(
    'oversized single messages fail before entering the stream queue',
    () async {
      final sent = <Map<String, dynamic>>[];
      final bridge = PocketStreamBridge(
        send: (method, params) {
          sent.add(<String, dynamic>{'method': method, ...params});
          return true;
        },
      );
      addTearDown(bridge.dispose);
      final port = bridge.open(topic: 'test.large');
      final large = List<String>.filled(
        PocketStreamBridge.maxMessageBytes,
        'x',
      ).join();
      bridge.handle(_event('stream.data', port.streamId, large));

      expect(port.isClosed, isTrue);
      expect(
        sent.singleWhere(
          (packet) => packet['method'] == 'stream.error',
        )['error'],
        containsPair('code', 'stream_message_too_large'),
      );
    },
  );
}

PocketEvent _event(String method, String streamId, [Object? value]) =>
    PocketEvent(
      id: 'test',
      method: method,
      params: <String, dynamic>{
        'streamId': streamId,
        if (method == 'stream.data') 'data': value,
      },
    );
