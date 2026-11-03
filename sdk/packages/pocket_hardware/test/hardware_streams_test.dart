import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_flutter/src/pocket_model.dart';
import 'package:pocket_services/pocket_services.dart';

final class _StreamingFakePlatform
    implements HardwarePlatform, HardwareStreamingPlatform {
  final StreamController<Object?> events = StreamController<Object?>.broadcast(
    sync: true,
  );
  final List<String> calls = <String>[];
  final List<Map<String, dynamic>> startArguments = <Map<String, dynamic>>[];
  final List<Map<String, dynamic>> stopArguments = <Map<String, dynamic>>[];

  @override
  Stream<Object?> get hardwareEvents => events.stream;

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<Map<String, dynamic>> startHardwareStream(
    Map<String, dynamic> arguments,
  ) async {
    calls.add('startHardwareStream');
    startArguments.add(Map<String, dynamic>.from(arguments));
    return <String, dynamic>{'ok': true, 'streamId': arguments['streamId']};
  }

  @override
  Future<Map<String, dynamic>> stopHardwareStream(
    Map<String, dynamic> arguments,
  ) async {
    calls.add('stopHardwareStream');
    stopArguments.add(Map<String, dynamic>.from(arguments));
    return <String, dynamic>{'ok': true, 'stopped': true};
  }

  Future<void> close() => events.close();
}

final class _StreamHarness {
  _StreamHarness(this.host, this.manager, this.outgoing);

  final PocketHost host;
  final PocketPluginManager manager;
  final List<Map<String, dynamic>> outgoing;

  Future<void> dispose() async {
    await manager.dispose();
    host.dispose();
  }
}

Future<_StreamHarness> _createStreamHarness(
  HardwarePlatform platform, {
  Set<String>? allowedPermissions,
  PocketPermissionRequestHandler? onPermissionRequest,
  Set<String>? hardwareGrantedPermissions,
  PocketPluginBudget budget = const PocketPluginBudget(),
}) async {
  final outgoing = <Map<String, dynamic>>[];
  final registry = PocketHostRegistry();
  final host = PocketHost(
    registry: registry,
    streams: PocketStreamBridge(
      send: (method, params) {
        outgoing.add(<String, dynamic>{'method': method, ...params});
        return true;
      },
    ),
    allowedCapabilities: HardwareCapabilities.all,
    send: (method, params) {
      outgoing.add(<String, dynamic>{'method': method, ...params});
      return true;
    },
  );
  final manager = PocketPluginManager(
    host: host,
    appId: 'test.hardware.streams',
    sessionId: 'stream-session',
    budget: budget,
    allowedPermissions: allowedPermissions ?? HardwarePermissions.all,
    onPermissionRequest:
        onPermissionRequest ?? ((_) => HardwarePermissions.all),
  );
  manager.register(
    HardwarePlugin(
      platform: platform,
      grantedPermissions: hardwareGrantedPermissions,
    ),
  );
  final availability = manager.negotiate(
    required: const <String>[],
    optional: HardwareCapabilities.all,
    requestedPermissions: HardwarePermissions.all,
  );
  await manager.activate(availability);
  return _StreamHarness(host, manager, outgoing);
}

Future<PocketDuplexStream> _openRemoteStream(
  PocketHost host, {
  required String streamId,
  required String capability,
  Map<String, dynamic> params = const <String, dynamic>{},
}) async {
  final completer = Completer<PocketDuplexStream>();
  final subscription = host.streams.incoming.listen((port) {
    if (port.streamId == streamId && !completer.isCompleted) {
      completer.complete(port);
    }
  });
  host.streams.handle(
    PocketEvent.fromJson(<String, dynamic>{
      'id': streamId,
      'method': 'stream.open',
      'params': <String, dynamic>{
        'streamId': streamId,
        'topic': capability,
        'params': params,
      },
    }),
  );
  final port = await completer.future.timeout(const Duration(seconds: 1));
  await subscription.cancel();
  return port;
}

void main() {
  test(
    'registers streams, routes by streamId, and stops only the cancelled stream',
    () async {
      final platform = _StreamingFakePlatform();
      final harness = await _createStreamHarness(platform);
      try {
        final first = await _openRemoteStream(
          harness.host,
          streamId: 'sensor-stream-1',
          capability: HardwareCapabilities.sensorsWatch,
          params: const <String, dynamic>{
            'samplingHz': 20,
            'sessionId': 'guest-overwrite-attempt',
          },
        );
        final second = await _openRemoteStream(
          harness.host,
          streamId: 'sensor-stream-2',
          capability: HardwareCapabilities.sensorsWatch,
          params: const <String, dynamic>{'samplingHz': 5},
        );
        await Future<void>.delayed(const Duration(milliseconds: 20));
        expect(platform.startArguments, hasLength(2));
        expect(platform.startArguments[0], <String, dynamic>{
          'kind': 'sensors',
          'streamId':
              'flutter.hardware:test.hardware.streams:stream-session:sensor-stream-1',
          'sessionId': 'test.hardware.streams:stream-session',
          'samplingHz': 20,
        });
        expect(
          platform.startArguments[1]['streamId'],
          'flutter.hardware:test.hardware.streams:stream-session:sensor-stream-2',
        );

        platform.events.add(<String, dynamic>{
          'streamId':
              'flutter.hardware:test.hardware.streams:stream-session:sensor-stream-1',
          'data': <String, dynamic>{'sample': 1},
        });
        platform.events.add(<String, dynamic>{
          'streamId':
              'flutter.hardware:test.hardware.streams:stream-session:sensor-stream-2',
          'data': <String, dynamic>{'sample': 2},
        });
        await Future<void>.delayed(Duration.zero);
        expect(
          harness.outgoing.where((event) => event['method'] == 'stream.data'),
          containsAll(<Map<String, dynamic>>[
            <String, dynamic>{
              'method': 'stream.data',
              'streamId': 'sensor-stream-1',
              'data': <String, dynamic>{'sample': 1},
            },
            <String, dynamic>{
              'method': 'stream.data',
              'streamId': 'sensor-stream-2',
              'data': <String, dynamic>{'sample': 2},
            },
          ]),
        );

        first.cancel('caller cancelled');
        await Future<void>.delayed(Duration.zero);
        expect(platform.stopArguments, hasLength(1));
        expect(platform.stopArguments.single, <String, dynamic>{
          'streamId':
              'flutter.hardware:test.hardware.streams:stream-session:sensor-stream-1',
          'sessionId': 'test.hardware.streams:stream-session',
        });
        expect(
          harness.outgoing.where((event) => event['method'] == 'stream.data'),
          hasLength(2),
        );
        second.cancel('caller cancelled');
      } finally {
        await harness.dispose();
        await platform.close();
      }
    },
  );

  test(
    'stream admission enforces method permission and unsupported boundaries',
    () async {
      final platform = _StreamingFakePlatform();
      final harness = await _createStreamHarness(
        platform,
        hardwareGrantedPermissions: <String>{HardwarePermissions.bluetooth},
      );
      try {
        final port = await _openRemoteStream(
          harness.host,
          streamId: 'sensor-denied',
          capability: HardwareCapabilities.sensorsWatch,
        );
        await Future<void>.delayed(const Duration(milliseconds: 50));
        final errors = harness.outgoing.where(
          (event) =>
              event['method'] == 'stream.error' &&
              event['streamId'] == 'sensor-denied',
        );
        expect(errors, hasLength(1));
        expect((errors.single['error'] as Map)['code'], 'permission_denied');
        expect(platform.startArguments, isEmpty);
        port.cancel('permission denied');
      } finally {
        await harness.dispose();
        await platform.close();
      }
    },
  );

  test(
    'continuous stream forwards 300 ordered samples through Host and stops once',
    () async {
      final platform = _StreamingFakePlatform();
      final harness = await _createStreamHarness(platform);
      final port = await _openRemoteStream(
        harness.host,
        streamId: 'continuous-sensor-stream',
        capability: HardwareCapabilities.sensorsWatch,
      );
      try {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        const nativeStreamId =
            'flutter.hardware:test.hardware.streams:stream-session:continuous-sensor-stream';
        for (var sample = 0; sample < 300; sample++) {
          platform.events.add(<String, dynamic>{
            'streamId': nativeStreamId,
            'data': <String, dynamic>{'sample': sample},
          });
        }
        await Future<void>.delayed(Duration.zero);

        final samples = harness.outgoing
            .where((event) => event['method'] == 'stream.data')
            .map((event) => (event['data'] as Map)['sample'] as int)
            .toList(growable: false);
        expect(samples, List<int>.generate(300, (index) => index));

        port.cancel('caller cancelled');
        await Future<void>.delayed(Duration.zero);
        expect(platform.stopArguments, hasLength(1));
      } finally {
        await harness.dispose();
        await platform.close();
      }
    },
  );

  test(
    'host stream event and cumulative quotas remain enforced without provider cap',
    () async {
      final platform = _StreamingFakePlatform();
      final harness = await _createStreamHarness(
        platform,
        budget: const PocketPluginBudget(
          maxStreamEvents: 2,
          maxStreamEventBytes: 64,
        ),
      );
      final port = await _openRemoteStream(
        harness.host,
        streamId: 'quota-sensor-stream',
        capability: HardwareCapabilities.sensorsWatch,
      );
      try {
        await Future<void>.delayed(const Duration(milliseconds: 20));
        const nativeStreamId =
            'flutter.hardware:test.hardware.streams:stream-session:quota-sensor-stream';
        for (var sample = 0; sample < 3; sample++) {
          platform.events.add(<String, dynamic>{
            'streamId': nativeStreamId,
            'data': <String, dynamic>{'sample': sample},
          });
        }
        await Future<void>.delayed(Duration.zero);
        expect(
          harness.outgoing
              .where((event) => event['method'] == 'stream.data')
              .map((event) => (event['data'] as Map)['sample'])
              .toList(growable: false),
          <int>[0, 1],
        );
        final quotaErrors = harness.outgoing.where(
          (event) =>
              event['method'] == 'stream.error' &&
              (event['error'] as Map)['code'] == 'plugin_stream_quota',
        );
        expect(quotaErrors, hasLength(1));

        port.cancel('quota reached');
        await Future<void>.delayed(Duration.zero);
        expect(platform.stopArguments, hasLength(1));
      } finally {
        await harness.dispose();
        await platform.close();
      }
    },
  );

  test('host still rejects an oversized individual stream event', () async {
    final platform = _StreamingFakePlatform();
    final harness = await _createStreamHarness(
      platform,
      budget: const PocketPluginBudget(
        maxStreamEvents: 10,
        maxStreamEventBytes: 64,
      ),
    );
    final port = await _openRemoteStream(
      harness.host,
      streamId: 'bytes-sensor-stream',
      capability: HardwareCapabilities.sensorsWatch,
    );
    try {
      await Future<void>.delayed(const Duration(milliseconds: 20));
      platform.events.add(<String, dynamic>{
        'streamId':
            'flutter.hardware:test.hardware.streams:stream-session:bytes-sensor-stream',
        'data': <String, dynamic>{'payload': 'x' * 128},
      });
      await Future<void>.delayed(Duration.zero);

      expect(
        harness.outgoing.where((event) => event['method'] == 'stream.data'),
        isEmpty,
      );
      final quotaErrors = harness.outgoing.where(
        (event) =>
            event['method'] == 'stream.error' &&
            (event['error'] as Map)['code'] == 'plugin_payload_quota',
      );
      expect(quotaErrors, hasLength(1));
      port.cancel('payload quota reached');
      await Future<void>.delayed(Duration.zero);
      expect(platform.stopArguments, hasLength(1));
    } finally {
      await harness.dispose();
      await platform.close();
    }
  });

  test(
    'deactivation advances stream epoch and prevents late events from leaking',
    () async {
      final platform = _StreamingFakePlatform();
      final harness = await _createStreamHarness(platform);
      final port = await _openRemoteStream(
        harness.host,
        streamId: 'epoch-stream',
        capability: HardwareCapabilities.sensorsWatch,
      );
      try {
        await harness.manager.deactivate();
        platform.events.add(<String, dynamic>{
          'streamId':
              'flutter.hardware:test.hardware.streams:stream-session:epoch-stream',
          'data': <String, dynamic>{'late': true},
        });
        await Future<void>.delayed(Duration.zero);
        expect(platform.stopArguments, hasLength(1));
        expect(
          harness.outgoing.where(
            (event) =>
                event['method'] == 'stream.data' &&
                event['streamId'] == 'epoch-stream',
          ),
          isEmpty,
        );
        port.cancel('revoked');
      } finally {
        await harness.dispose();
        await platform.close();
      }
    },
  );
}
