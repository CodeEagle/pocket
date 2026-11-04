import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:pocket_hardware/pocket_hardware.dart';
import 'package:pocket_services/pocket_services.dart';

final class _RecordingHardwarePlatform implements HardwarePlatform {
  _RecordingHardwarePlatform(this.responses);

  final Map<String, Map<String, dynamic>> responses;
  final List<String> calls = <String>[];
  final List<Map<String, dynamic>> callArguments = <Map<String, dynamic>>[];
  Future<Map<String, dynamic>> Function(
    String method,
    Map<String, dynamic> arguments,
  )?
  handler;

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) async {
    calls.add(method);
    callArguments.add(Map<String, dynamic>.from(arguments));
    if (handler != null) {
      return handler!(method, arguments);
    }
    return responses[method] ??
        <String, dynamic>{
          'ok': false,
          'errorCode': 'hardware_unsupported',
          'error': '$method is unavailable',
        };
  }
}

final class _ManagerHarness {
  _ManagerHarness(this.host, this.manager);

  final PocketHost host;
  final PocketPluginManager manager;

  Future<void> dispose() async {
    await manager.dispose();
    host.dispose();
  }
}

Future<_ManagerHarness> _createManager(
  String suffix,
  HardwarePlatform platform, {
  Duration requestTimeout = const Duration(seconds: 16),
}) async {
  final registry = PocketHostRegistry();
  final host = PocketHost(
    registry: registry,
    streams: PocketStreamBridge(send: (_, __) => true),
    allowedCapabilities: HardwareCapabilities.all,
    send: (_, __) => true,
  );
  final manager = PocketPluginManager(
    host: host,
    appId: 'test.hardware.$suffix',
    sessionId: 'session.$suffix',
    allowedPermissions: HardwarePermissions.all,
    onPermissionRequest: (_) => HardwarePermissions.all,
  );
  manager.register(
    HardwarePlugin(platform: platform, requestTimeout: requestTimeout),
  );
  final availability = manager.negotiate(
    required: const <String>[],
    optional: HardwareCapabilities.all,
    requestedPermissions: HardwarePermissions.all,
  );
  await manager.activate(availability);
  return _ManagerHarness(host, manager);
}

final class _SensorCall {
  _SensorCall(this.elapsedMs, this.method, this.arguments);

  final int elapsedMs;
  final String method;
  final Map<String, dynamic> arguments;
}

final class _PendingSensorOperation {
  _PendingSensorOperation(this.ownerToken, this.operationId);

  final String? ownerToken;
  final int? operationId;
  final Completer<Map<String, dynamic>> _completer =
      Completer<Map<String, dynamic>>();

  Future<Map<String, dynamic>> get future => _completer.future;

  void complete(Map<String, dynamic> value) {
    if (!_completer.isCompleted) _completer.complete(value);
  }
}

/// Models the iOS manager's singleton sensor slot while preserving MethodChannel
/// FIFO. The first native result is deliberately delivered after the second
/// request has replaced it, so the first plugin's timeout cancel crosses the
/// newer operation's lifetime.
final class _SharedSensorPlatform implements HardwarePlatform {
  _SharedSensorPlatform() : _clock = Stopwatch()..start();

  final Stopwatch _clock;
  final List<_SensorCall> calls = <_SensorCall>[];
  final Completer<void> secondSensorStarted = Completer<void>();
  final Completer<void> lateFirstResultDelivered = Completer<void>();
  _PendingSensorOperation? _current;
  int _sensorRequestCount = 0;

  @override
  Future<Map<String, dynamic>> invoke(
    String method, [
    Map<String, dynamic> arguments = const <String, dynamic>{},
  ]) {
    calls.add(
      _SensorCall(
        _clock.elapsedMilliseconds,
        method,
        Map<String, dynamic>.from(arguments),
      ),
    );
    if (method == 'readSensors') {
      _sensorRequestCount += 1;
      final pending = _PendingSensorOperation(
        arguments['ownerToken'] as String?,
        arguments['operationId'] as int?,
      );
      if (_sensorRequestCount == 2) {
        final previous = _current;
        if (previous != null) {
          Future<void>.delayed(const Duration(milliseconds: 30), () {
            previous.complete(<String, dynamic>{
              'ok': false,
              'errorCode': 'hardware_cancelled',
              'error': 'old native result arrived late',
            });
            if (!lateFirstResultDelivered.isCompleted) {
              lateFirstResultDelivered.complete();
            }
          });
        }
        if (!secondSensorStarted.isCompleted) {
          secondSensorStarted.complete();
        }
        Future<void>.delayed(const Duration(milliseconds: 100), () {
          if (identical(_current, pending)) {
            _current = null;
            pending.complete(<String, dynamic>{
              'ok': true,
              'realSensors': true,
              'accelX': 0.12,
            });
          }
        });
      }
      _current = pending;
      return pending.future;
    }
    if (method == 'cancelSensorOperation') {
      final current = _current;
      final matches =
          current != null &&
          current.ownerToken == arguments['ownerToken'] &&
          current.operationId == arguments['operationId'];
      if (matches) {
        _current = null;
        current.complete(<String, dynamic>{
          'ok': false,
          'errorCode': 'hardware_cancelled',
          'error': 'sensor operation cancelled',
        });
      }
      return Future<Map<String, dynamic>>.value(<String, dynamic>{
        'ok': true,
        'cancelled': matches,
      });
    }
    if (method == 'disposeSession') {
      _current = null;
    }
    return Future<Map<String, dynamic>>.value(<String, dynamic>{'ok': true});
  }
}

int _permissionStatus = 1;
final _permissionCalls = <String>[];

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const permissionChannel = MethodChannel(
    'flutter.baseflow.com/permissions/methods',
  );
  setUp(() {
    // iOS motion has an OS grant; Android aliases are tested by pocket_permissions.
    debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
    _permissionStatus = 1;
    _permissionCalls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(permissionChannel, (call) async {
          _permissionCalls.add(call.method);
          if (call.method == 'requestPermissions') {
            return <int, int>{
              for (final value in call.arguments as List)
                value as int: _permissionStatus,
            };
          }
          return _permissionStatus;
        });
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
  });
  tearDown(
    () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(permissionChannel, null),
  );

  test(
    'aggregate routes scan/read to hardware and OS permission to permission_handler',
    () async {
      final platform = _RecordingHardwarePlatform(
        <String, Map<String, dynamic>>{
          'startBleScan': <String, dynamic>{
            'ok': true,
            'realBle': true,
            'state': 'poweredOn',
            'devices': const <Map<String, dynamic>>[],
          },
          'readSensors': <String, dynamic>{
            'ok': true,
            'realSensors': true,
            'accelX': 0.12,
            'accelY': -0.04,
            'accelZ': 0.08,
            'gravityX': 0.0,
            'gravityY': -0.98,
            'gravityZ': -0.15,
            'gyroX': 0.01,
            'gyroY': 0.02,
            'gyroZ': -0.01,
            'pitch': 0.15,
            'roll': 0.02,
            'yaw': 0.31,
          },
          'disposeSession': <String, dynamic>{'ok': true, 'disposed': true},
        },
      );
      final sent = <Map<String, dynamic>>[];
      final registry = PocketHostRegistry();
      final host = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: HardwareCapabilities.all,
        send: (method, params) {
          sent.add(<String, dynamic>{'method': method, ...params});
          return true;
        },
      );
      final plugin = HardwarePlugin(platform: platform);
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.pocket_hardware',
        sessionId: 'session-1',
        allowedPermissions: HardwarePermissions.all,
        onPermissionRequest: (_) => HardwarePermissions.all,
      );
      manager.register(plugin);
      final availability = manager.negotiate(
        required: const <String>[],
        optional: HardwareCapabilities.all,
        requestedPermissions: HardwarePermissions.all,
      );
      await manager.activate(availability);

      final bleResult =
          await manager.invoke(
                HardwareCapabilities.bluetoothScan,
                const <String, dynamic>{'timeoutMs': 1600},
              )
              as Map<String, dynamic>;
      expect(bleResult['ok'], isTrue);
      final permResult =
          await manager.invoke(
                HardwareCapabilities.requestPermission,
                const <String, dynamic>{
                  'permission': HardwarePermissions.sensors,
                },
              )
              as Map<String, dynamic>;
      expect(permResult['ok'], isTrue);
      expect(permResult['granted'], isTrue);
      final sensorResult =
          await manager.invoke(HardwareCapabilities.sensorsRead)
              as Map<String, dynamic>;
      expect(sensorResult['ok'], isTrue);
      expect(sensorResult['accelX'], 0.12);

      await manager.dispose();
      host.dispose();
      expect(
        platform.callArguments[0]['sessionId'],
        'test.pocket_hardware:session-1',
      );
      expect(
        platform.callArguments[1]['sessionId'],
        'test.pocket_hardware:session-1',
      );
      expect(
        platform.callArguments[2]['sessionId'],
        'test.pocket_hardware:session-1',
      );
      expect(
        platform.calls,
        containsAllInOrder(<String>[
          'startBleScan',
          'readSensors',
          'disposeSession',
        ]),
      );
    },
  );

  test(
    'readSensors retains its long native deadline and returns numeric data',
    () async {
      final platform = _RecordingHardwarePlatform(
        <String, Map<String, dynamic>>{},
      );
      platform.handler = (method, arguments) async {
        if (method == 'readSensors') {
          await Future<void>.delayed(const Duration(milliseconds: 3300));
          return <String, dynamic>{
            'ok': true,
            'realSensors': true,
            'accelX': 0.25,
            'accelY': -0.05,
            'accelZ': 0.11,
          };
        }
        return <String, dynamic>{'ok': true};
      };

      final registry = PocketHostRegistry();
      final host = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: HardwareCapabilities.all,
        send: (_, __) => true,
      );
      final plugin = HardwarePlugin(platform: platform);
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.pocket_hardware.prompt',
        sessionId: 'session-prompt',
        allowedPermissions: HardwarePermissions.all,
        onPermissionRequest: (_) => HardwarePermissions.all,
      );
      manager.register(plugin);
      final availability = manager.negotiate(
        required: const <String>[],
        optional: HardwareCapabilities.all,
        requestedPermissions: HardwarePermissions.all,
      );
      await manager.activate(availability);

      final result =
          await manager.invoke(HardwareCapabilities.sensorsRead)
              as Map<String, dynamic>;
      expect(result['ok'], isTrue);
      expect(result['accelX'], 0.25);
      expect(platform.calls, equals(<String>['readSensors']));
      expect(platform.callArguments.first['operationId'], 1);
      expect(platform.callArguments.first['ownerToken'], isA<String>());
      expect((platform.callArguments.first['ownerToken'] as String).length, 32);
      expect(platform.callArguments.first['timeoutMs'], 16000);

      await manager.dispose();
      host.dispose();
    },
  );

  test(
    'sensor timeout cancels the matching native identity and subsequent read succeeds',
    () async {
      final hungRead = Completer<Map<String, dynamic>>();
      var readAttempt = 0;
      final platform = _RecordingHardwarePlatform(
        <String, Map<String, dynamic>>{},
      );
      platform.handler = (method, arguments) async {
        if (method == 'readSensors') {
          readAttempt += 1;
          if (readAttempt == 1) {
            return hungRead.future;
          }
          return <String, dynamic>{
            'ok': true,
            'realSensors': true,
            'accelX': 0.42,
          };
        }
        return <String, dynamic>{'ok': true, 'cancelled': true};
      };

      final registry = PocketHostRegistry();
      final host = PocketHost(
        registry: registry,
        streams: PocketStreamBridge(send: (_, __) => true),
        allowedCapabilities: HardwareCapabilities.all,
        send: (_, __) => true,
      );
      final plugin = HardwarePlugin(
        platform: platform,
        requestTimeout: const Duration(milliseconds: 40),
      );
      final manager = PocketPluginManager(
        host: host,
        appId: 'test.pocket_hardware.timeout',
        sessionId: 'session-timeout',
        allowedPermissions: HardwarePermissions.all,
        onPermissionRequest: (_) => HardwarePermissions.all,
      );
      manager.register(plugin);
      final availability = manager.negotiate(
        required: const <String>[],
        optional: HardwareCapabilities.all,
        requestedPermissions: HardwarePermissions.all,
      );
      await manager.activate(availability);

      await expectLater(
        manager.invoke(HardwareCapabilities.sensorsRead),
        throwsA(
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'code',
            'hardware_timeout',
          ),
        ),
      );
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(
        platform.calls,
        equals(<String>['readSensors', 'cancelSensorOperation']),
      );
      expect(
        platform.callArguments[1]['operationId'],
        equals(platform.callArguments[0]['operationId']),
      );
      expect(
        platform.callArguments[1]['ownerToken'],
        equals(platform.callArguments[0]['ownerToken']),
      );

      _permissionStatus = 0;
      final deniedPerm =
          await manager.invoke(
                HardwareCapabilities.requestPermission,
                const <String, dynamic>{
                  'permission': HardwarePermissions.sensors,
                },
              )
              as Map<String, dynamic>;
      expect(deniedPerm['granted'], isFalse);
      expect(deniedPerm['status'], 'denied');

      final secondRead =
          await manager.invoke(HardwareCapabilities.sensorsRead)
              as Map<String, dynamic>;
      expect(secondRead['ok'], isTrue);
      expect(secondRead['accelX'], 0.42);

      await manager.dispose();
      host.dispose();
    },
  );

  test(
    'sensor timeout from plugin A cannot cancel plugin B read in strict FIFO',
    () async {
      final platform = _SharedSensorPlatform();
      final managerA = await _createManager(
        'fifo-read-a',
        platform,
        requestTimeout: const Duration(milliseconds: 40),
      );
      final managerB = await _createManager(
        'fifo-read-b',
        platform,
        requestTimeout: const Duration(milliseconds: 300),
      );

      try {
        Object? errorA;
        Object? errorB;
        StackTrace? errorBStack;
        final aRead = managerA.manager.invoke(HardwareCapabilities.sensorsRead);
        final bRead = Future<void>.delayed(const Duration(milliseconds: 20))
            .then<Object?>((_) {
              return managerB.manager.invoke(HardwareCapabilities.sensorsRead);
            })
            .then<Object?>(
              (value) => value,
              onError: (Object error, StackTrace stack) {
                errorB = error;
                errorBStack = stack;
                return null;
              },
            );
        try {
          await aRead;
        } catch (error) {
          errorA = error;
        }
        await platform.secondSensorStarted.future;
        final valueBResult = await bRead;
        expect(errorB, isNull, reason: 'B failed: $errorB\n$errorBStack');
        expect(valueBResult, isA<Map<String, dynamic>>());
        final valueB = valueBResult! as Map<String, dynamic>;

        expect(
          errorA,
          isA<PocketCapabilityException>().having(
            (error) => error.code,
            'A error',
            'hardware_timeout',
          ),
        );
        expect(valueB['ok'], isTrue);
        expect(valueB['realSensors'], isTrue);
        await platform.lateFirstResultDelivered.future;

        final sensorCalls = platform.calls
            .where(
              (call) =>
                  call.method == 'readSensors' ||
                  call.method == 'cancelSensorOperation',
            )
            .toList(growable: false);
        expect(
          sensorCalls.map((call) => call.method),
          equals(<String>[
            'readSensors',
            'readSensors',
            'cancelSensorOperation',
          ]),
        );
        final ownerA = sensorCalls[0].arguments['ownerToken'];
        final ownerB = sensorCalls[1].arguments['ownerToken'];
        expect(ownerA, isA<String>());
        expect(ownerB, isA<String>());
        expect(ownerA, isNot(equals(ownerB)));
        expect(sensorCalls[0].arguments['operationId'], 1);
        expect(sensorCalls[1].arguments['operationId'], 1);
        expect(sensorCalls[2].arguments['ownerToken'], ownerA);
        expect(sensorCalls[2].arguments['operationId'], 1);
        expect(sensorCalls[1].elapsedMs, lessThan(sensorCalls[2].elapsedMs));
      } finally {
        await managerA.dispose();
        await managerB.dispose();
      }
    },
  );

  test(
    'sensor timeout cannot cancel or enqueue a permission_handler request',
    () async {
      final platform = _SharedSensorPlatform();
      final managerA = await _createManager(
        'independent-a',
        platform,
        requestTimeout: const Duration(milliseconds: 40),
      );
      final managerB = await _createManager('independent-b', platform);
      try {
        final read = managerA.manager.invoke(HardwareCapabilities.sensorsRead);
        final failed = expectLater(
          read,
          throwsA(isA<PocketCapabilityException>()),
        );
        final permission =
            await managerB.manager.invoke(
                  HardwareCapabilities.requestPermission,
                  {'permission': HardwarePermissions.sensors},
                )
                as Map;
        expect(permission['granted'], isTrue);
        await failed;
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(_permissionCalls, ['requestPermissions']);
        expect(
          platform.calls
              .where((call) => call.method != 'disposeSession')
              .map((call) => call.method),
          ['readSensors', 'cancelSensorOperation'],
        );
      } finally {
        await managerA.dispose();
        await managerB.dispose();
      }
    },
  );
}
