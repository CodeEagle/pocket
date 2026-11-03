import 'dart:async';

import 'package:pocket_flutter/src/pocket_model.dart' show PocketEvent;
import 'package:pocket_services/pocket_services.dart';
import 'package:test/test.dart';

final class _HostFixture {
  _HostFixture(Map<String, PocketCapabilityStream> providers) {
    final registry = PocketHostRegistry();
    providers.forEach(registry.registerStream);
    final streams = PocketStreamBridge(send: _send);
    host = PocketHost(
      registry: registry,
      streams: streams,
      allowedCapabilities: providers.keys.toSet(),
      send: _send,
    );
    host.configureGuestCapabilities(required: providers.keys);
  }

  late final PocketHost host;
  final sent = <Map<String, dynamic>>[];

  bool _send(String method, Map<String, dynamic> params) {
    sent.add(<String, dynamic>{'method': method, ...params});
    return true;
  }

  Future<void> event(String method, Map<String, dynamic> params) async {
    await host.handle(PocketEvent(id: 'test', method: method, params: params));
    await Future<void>.delayed(Duration.zero);
  }

  Future<void> open(String id, String capability) =>
      event('stream.open', {'streamId': id, 'topic': capability});
}

void main() {
  test(
    'provider receives inbound data while host watches stream lifecycle',
    () async {
      final fixture = _HostFixture({
        'test.echo': (context) =>
            context.incoming.map((value) => {'echo': value}),
      });
      addTearDown(fixture.host.dispose);
      await fixture.open('js-1', 'test.echo');
      await fixture.event('stream.data', {'streamId': 'js-1', 'data': 42});
      expect(
        fixture.sent,
        contains(
          equals({
            'method': 'stream.data',
            'streamId': 'js-1',
            'data': {'echo': 42},
          }),
        ),
      );
      await fixture.event('stream.end', {'streamId': 'js-1'});
    },
  );

  test(
    'remote cancellation releases provider without an uncaught stream error',
    () async {
      var cancellations = 0;
      final producer = StreamController<Object?>(
        onCancel: () => cancellations++,
      );
      addTearDown(producer.close);
      final fixture = _HostFixture({'test.watch': (_) => producer.stream});
      addTearDown(fixture.host.dispose);
      await fixture.open('js-2', 'test.watch');
      await fixture.event('stream.cancel', {
        'streamId': 'js-2',
        'reason': 'page left',
      });
      expect(cancellations, 1);
      producer.add(7);
      await Future<void>.delayed(Duration.zero);
      expect(
        fixture.sent.where((event) => event['method'] == 'stream.data'),
        isEmpty,
      );
    },
  );

  test(
    'provider failure retains its code instead of reporting successful end',
    () async {
      final fixture = _HostFixture({
        'test.fail': (_) => Stream<Object?>.error(
          const PocketCapabilityException('permission_denied', 'not granted'),
        ),
      });
      addTearDown(fixture.host.dispose);
      await fixture.open('js-3', 'test.fail');
      expect(
        fixture.sent,
        contains(
          equals({
            'method': 'stream.error',
            'streamId': 'js-3',
            'error': {'code': 'permission_denied', 'message': 'not granted'},
          }),
        ),
      );
      expect(
        fixture.sent.where((event) => event['method'] == 'stream.end'),
        isEmpty,
      );
    },
  );

  test('synchronous provider throw is contained by stream dispatch', () async {
    final fixture = _HostFixture({
      'test.throw': (_) =>
          throw const PocketCapabilityException('unavailable', 'off'),
    });
    addTearDown(fixture.host.dispose);
    await fixture.open('js-4', 'test.throw');
    expect(fixture.sent.single['method'], 'stream.error');
    expect(fixture.sent.single['error'], {
      'code': 'unavailable',
      'message': 'off',
    });
  });

  test(
    'revocation releases only matching producers and dispose releases the rest',
    () async {
      var stoppedA = 0;
      var stoppedB = 0;
      final a = StreamController<Object?>(onCancel: () => stoppedA++);
      final b = StreamController<Object?>(onCancel: () => stoppedB++);
      addTearDown(a.close);
      addTearDown(b.close);
      final fixture = _HostFixture({
        'test.a': (_) => a.stream,
        'test.b': (_) => b.stream,
      });
      addTearDown(fixture.host.dispose);
      await fixture.open('js-a', 'test.a');
      await fixture.open('js-b', 'test.b');
      fixture.host.revokeCapabilities({'test.a'});
      await Future<void>.delayed(Duration.zero);
      expect(stoppedA, 1);
      expect(stoppedB, 0);
      b.add(9);
      await Future<void>.delayed(Duration.zero);
      expect(
        fixture.sent,
        contains(
          equals({'method': 'stream.data', 'streamId': 'js-b', 'data': 9}),
        ),
      );
      fixture.host.dispose();
      await Future<void>.delayed(Duration.zero);
      expect(stoppedB, 1);
    },
  );

  test(
    'invalid JSON provider payload terminates stream with structured error',
    () async {
      final fixture = _HostFixture({
        'test.invalid': (_) => Stream<Object?>.value(Object()),
      });
      addTearDown(fixture.host.dispose);
      await fixture.open('js-5', 'test.invalid');
      expect(fixture.sent.single['method'], 'stream.error');
      expect((fixture.sent.single['error'] as Map)['code'], 'invalid_result');
    },
  );
}
